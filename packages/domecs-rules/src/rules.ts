import type { ComponentType, SystemFault, SystemHandle, World } from '@domecs/core'
import { walkFieldRefs, type AstNode } from './ast.js'
import { parseExpression } from './parser.js'
import { evaluate, RuleEvalError, type EvalEnv } from './evaluator.js'
import { inferKind } from './typecheck.js'

/**
 * O-67: field names a rule may never read or write. Reads are own-property
 * only, and these names would reach the object's prototype machinery.
 */
const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

export interface RuleActionDef {
  /** Dotted "Component.field" target, same JSON shape as Studio's SystemData.actions. */
  set: string
  expr: string
}

export interface RuleDef {
  name: string
  schedule: 'tick' | 'fixed'
  enabled?: boolean
  query: string[]
  when?: string
  actions: RuleActionDef[]
}

export interface RuleError {
  rule: string
  /** Character position within the offending expression source, or -1 for
   *  a non-syntax error (e.g. an unresolvable component name in `query` or
   *  an action's `set` target — see compileRule doc for the exact rule). */
  position: number
  message: string
}

/**
 * The error a rule reports, as an entity fault (`Faulted`, source
 * `rule:<name>`), when it cannot run on that entity: a field it reads is
 * missing, or an action's write is rejected (O-68). The entity is skipped
 * for that tick and nothing is written.
 */
export interface RuleFault {
  readonly kind: 'rule_eval_failed'
  readonly rule: string
  readonly message: string
}

/** Opaque compiled-rule handle. Internal shape lives in CompiledRuleInternal below. */
export interface CompiledRule {
  def: RuleDef
}

interface CompiledAction {
  component: ComponentType<any>
  field: string
  ast: AstNode
}

interface CompiledRuleInternal extends CompiledRule {
  queryTypes: ComponentType<any>[]
  whenAst: AstNode | undefined
  actions: CompiledAction[]
  /** Every component name referenced anywhere in this rule (query + when +
   *  actions), resolved once at compile time — reused at eval time by
   *  resolveField so the per-tick hot path never calls `resolve` again. */
  componentsByName: Map<string, ComponentType<any>>
}

/**
 * Resolve+parse a `RuleDef` against real `@domecs/core` component types.
 *
 * - `def.when` (if present) and every `def.actions[i].expr` are parsed via
 *   `parseExpression`; every `ParseError` becomes a `RuleError` at the same
 *   `position` (position is relative to the individual expression string
 *   that produced it, not the whole `RuleDef`).
 * - Every `def.query[i]` name, and every `Component` referenced by a
 *   `Component.field` inside any parsed expression (when or action expr),
 *   is resolved via `resolve(name)`. An unresolvable name is a `RuleError`
 *   with `position` set to the referencing token's position when it came
 *   from inside an expression (so callers can point at it), or `-1` for a
 *   bare name with no token position of its own — `query[i]` entries and an
 *   action's `set` target's component name (the left side of the dot in
 *   `"Component.field"`, which is a raw string, not something parsed).
 * - Type errors certain before the rule runs are `RuleError`s at the
 *   offending node's position (O-68): a string or boolean literal, or an
 *   operator result of that kind, where arithmetic, a comparison or a
 *   function needs a number — outside the right side of `&&`/`||` and
 *   ternary branches, which may not run. Field kinds are not inferred.
 * - If there are ANY errors, returns `{ rule: null, errors }` — never a
 *   partially-compiled rule.
 */
export function compileRule(
  def: RuleDef,
  resolve: (name: string) => ComponentType<any> | undefined,
): { rule: CompiledRule; errors: [] } | { rule: null; errors: RuleError[] } {
  const errors: RuleError[] = []
  const componentsByName = new Map<string, ComponentType<any>>()

  function resolveAndTrack(name: string, pos: number, context: string): ComponentType<any> | undefined {
    const cached = componentsByName.get(name)
    if (cached) return cached
    const resolved = resolve(name)
    if (!resolved) {
      errors.push({ rule: def.name, position: pos, message: `Unknown component "${name}" ${context}` })
      return undefined
    }
    componentsByName.set(name, resolved)
    return resolved
  }

  function checkField(field: string, pos: number): void {
    if (FORBIDDEN_FIELDS.has(field)) {
      errors.push({ rule: def.name, position: pos, message: `Field name "${field}" is not allowed` })
    }
  }

  const queryTypes: ComponentType<any>[] = []
  for (const name of def.query) {
    const t = resolveAndTrack(name, -1, 'referenced in query')
    if (t) queryTypes.push(t)
  }

  let whenAst: AstNode | undefined
  if (def.when !== undefined) {
    const parsed = parseExpression(def.when)
    if ('errors' in parsed) {
      for (const e of parsed.errors) errors.push({ rule: def.name, position: e.position, message: e.message })
    } else {
      whenAst = parsed.ast
      walkFieldRefs(whenAst, (component, field, pos) => {
        checkField(field, pos)
        resolveAndTrack(component, pos, 'referenced in "when"')
      })
    }
  }

  const compiledActions: CompiledAction[] = []
  for (const action of def.actions) {
    const dotIdx = action.set.indexOf('.')
    if (dotIdx <= 0 || dotIdx === action.set.length - 1) {
      errors.push({
        rule: def.name,
        position: -1,
        message: `Action "set" must be "Component.field", got "${action.set}"`,
      })
      continue
    }
    const compName = action.set.slice(0, dotIdx)
    const fieldName = action.set.slice(dotIdx + 1)
    checkField(fieldName, -1)
    const targetType = resolveAndTrack(compName, -1, `referenced in action "${action.set}"`)

    const parsed = parseExpression(action.expr)
    if ('errors' in parsed) {
      for (const e of parsed.errors) errors.push({ rule: def.name, position: e.position, message: e.message })
      continue
    }
    walkFieldRefs(parsed.ast, (component, field, pos) => {
      checkField(field, pos)
      resolveAndTrack(component, pos, `referenced in action "${action.set}" expr`)
    })
    if (targetType) {
      compiledActions.push({ component: targetType, field: fieldName, ast: parsed.ast })
    }
  }

  if (errors.length > 0) return { rule: null, errors }

  // O-68 (R4): reject type errors certain before the rule runs (see
  // typecheck.ts). Field kinds are not inferred: defaults do not fix them.
  const report = (position: number, message: string): void => {
    errors.push({ rule: def.name, position, message })
  }
  if (whenAst) inferKind(whenAst, report)
  for (const action of compiledActions) inferKind(action.ast, report)
  if (errors.length > 0) return { rule: null, errors }

  const rule: CompiledRuleInternal = {
    def,
    queryTypes,
    whenAst,
    actions: compiledActions,
    componentsByName,
  }
  return { rule, errors: [] }
}

/**
 * O-67: a write must target an existing own field and keep its kind
 * (number, string or boolean); a field holding `null` or `undefined` takes
 * any of the three. Numbers must be finite. Anything else would add fields
 * on a typo, store booleans from `&&`/`||` into numeric fields, or persist
 * `Infinity` as `null`.
 */
function checkWrite(action: CompiledAction, current: Record<string, unknown>, value: unknown): void {
  const target = `${action.component.name}.${action.field}`
  if (!Object.hasOwn(current, action.field)) {
    throw new RuleEvalError(`Cannot set ${target}: the component has no such field`)
  }
  const prior = current[action.field]
  const before = typeof prior
  if (prior !== null && prior !== undefined && typeof value !== before) {
    throw new RuleEvalError(`Cannot set ${target}: expected a ${before}, got ${typeof value}`)
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RuleEvalError(`Cannot set ${target}: ${value} is not a finite number`)
  }
}

/** Register a single compiled rule as a `world.system(...)`. */
function registerRuleSystem(world: World, rule: CompiledRuleInternal): SystemHandle {
  const { def, queryTypes, whenAst, actions, componentsByName } = rule

  return world.system(
    `rule:${def.name}`,
    {
      schedule: def.schedule,
      query: queryTypes,
      enabled: () => def.enabled !== false,
    },
    (ctx) => {
      // Fixed-rate rules fire once per fixed-step tick, independent of the
      // frame's wall dt — dt is that fixed step. Tick-rate rules use the
      // (scale-adjusted, ms-quantized) per-frame delta.
      const dt = def.schedule === 'fixed' ? ctx.time.fixedStep : ctx.time.scaledDelta
      const time = ctx.time.elapsed

      // O-68 (R4): a rule that cannot run on an entity (a missing field, a
      // rejected write) skips that entity and reports it as a fault on it,
      // so it shows in `Faulted` instead of vanishing. Any other error is a
      // bug and propagates.
      const faults: SystemFault<RuleFault>[] = []
      for (const entity of ctx.entities) {
        // One bad entity (e.g. a query match missing a field referenced by
        // `when`/an action) must never stop the rest of the query from
        // being processed this tick — see evaluator.ts's RuleEvalError doc.
        try {
          // O-68 (R3): writes are staged per "Component.field" and committed
          // only when every action succeeded. Reads see staged values, so
          // actions still apply in order (`hp = 100; hp = hp - 1` → 99).
          const staged = new Map<string, number | string | boolean>()
          const env: EvalEnv = {
            dt,
            time,
            rand: { uniform: () => ctx.rand.uniform() },
            resolveField(component, field) {
              const pending = staged.get(`${component}.${field}`)
              if (pending !== undefined) return pending
              const type = componentsByName.get(component)
              if (!type) return undefined
              const value = world.getComponent(entity.id, type) as
                | Record<string, number | string | boolean>
                | undefined
              if (value === undefined) return undefined
              // O-67: own properties only — never the prototype chain.
              return Object.hasOwn(value, field) ? value[field] : undefined
            },
          }

          if (whenAst && !evaluate(whenAst, env)) continue

          // O-68 (R3): evaluate and check every action, in order, before
          // writing any, so a failing action leaves the entity untouched.
          const writes: Array<{ target: Record<string, unknown>; action: CompiledAction; value: unknown }> = []
          for (const action of actions) {
            const result = evaluate(action.ast, env)
            const current = world.getComponent(entity.id, action.component) as
              | Record<string, unknown>
              | undefined
            // Atomic: a missing target component fails the whole entity.
            if (current === undefined) {
              throw new RuleEvalError(`Cannot set ${action.component.name}.${action.field}: the entity has no ${action.component.name}`)
            }
            checkWrite(action, current, result)
            writes.push({ target: current, action, value: result })
            staged.set(`${action.component.name}.${action.field}`, result)
          }
          // Commit the final value of each field once; R9: an unchanged
          // value is not a change.
          const committed = new Set<string>()
          for (let i = writes.length - 1; i >= 0; i--) {
            const { target, action } = writes[i]!
            const key = `${action.component.name}.${action.field}`
            if (committed.has(key)) continue
            committed.add(key)
            const value = staged.get(key)
            if (Object.is(target[action.field], value)) continue
            target[action.field] = value
            world.markChanged(entity.id, action.component)
          }
        } catch (e) {
          if (!(e instanceof RuleEvalError)) throw e
          faults.push({
            entity: entity.id,
            error: { kind: 'rule_eval_failed', rule: def.name, message: e.message },
            recoverable: true,
          })
        }
      }
      if (faults.length > 0) return { errors: faults }
    },
  )
}

export interface RulesHandle {
  /**
   * Replace the full active rule set: compiles every def, installs (as
   * `world.system` calls) every rule that compiled clean, and silently (from
   * the caller's perspective — the returned Map tells them) skips ones that
   * did not. Un-registers any `world.system` from a PREVIOUS `update()` call
   * whose rule name is no longer present in `defs`, or is present but now
   * fails to compile.
   *
   * @returns a `Map<string, RuleError[]>` keyed by rule name for every def
   * that failed to compile. Compiled-clean rules are absent from the map —
   * never present with an empty array.
   */
  update(defs: RuleDef[]): Map<string, RuleError[]>
  /** Remove every currently-installed rule system. */
  uninstall(): void
}

/** Constructs a {@link RulesHandle} and immediately calls `update(defs)` once. */
export function installRules(
  world: World,
  defs: RuleDef[],
  resolve: (name: string) => ComponentType<any> | undefined,
): RulesHandle {
  const active = new Map<string, SystemHandle>()

  function update(newDefs: RuleDef[]): Map<string, RuleError[]> {
    const errorsByName = new Map<string, RuleError[]>()
    const newNames = new Set<string>()

    for (const def of newDefs) {
      newNames.add(def.name)

      // Always drop any previous registration for this name before
      // (re)installing — a def may have changed shape (schedule, query,
      // actions) between updates, and re-registering is the only way the
      // real SystemHandle reflects the new SystemDef.
      const existing = active.get(def.name)
      if (existing) {
        existing.remove()
        active.delete(def.name)
      }

      const compiled = compileRule(def, resolve)
      if (compiled.rule === null) {
        errorsByName.set(def.name, compiled.errors)
        continue
      }

      const handle = registerRuleSystem(world, compiled.rule as CompiledRuleInternal)
      active.set(def.name, handle)
    }

    // Un-register systems for rule names no longer present in this update.
    for (const [name, handle] of active) {
      if (!newNames.has(name)) {
        handle.remove()
        active.delete(name)
      }
    }

    return errorsByName
  }

  function uninstall(): void {
    for (const handle of active.values()) handle.remove()
    active.clear()
  }

  const handle: RulesHandle = { update, uninstall }
  handle.update(defs)
  return handle
}
