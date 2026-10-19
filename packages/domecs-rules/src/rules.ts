import type { ComponentType, EntityView, SystemFault, SystemHandle, World } from '@domecs/core'
import { walkFieldRefs, type AstNode } from './ast.js'
import { parseExpression } from './parser.js'
import { compileExpression, RuleEvalError, type CompiledExpression, type EvalEnv } from './evaluator.js'
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
  /**
   * System priority (lower runs first; default 0). Rules of equal priority
   * run in the order of the `defs` array last passed to `update()` (O-69).
   * Where they sit among other systems of that priority depends on
   * {@link InstallRulesOptions.order}.
   */
  priority?: number
  /**
   * Which stream the rule's `random()` draws (§4.4; SPEC §2.8). Overrides
   * {@link InstallRulesOptions.rng} for this rule. `'own'`: the rule's own
   * stream, keyed `rule:<name>` and derived from the world's root seed, so
   * adding, removing or editing another rule never changes its draws (its
   * draws still depend on how many entities it visits). `'shared'`: the
   * world's shared stream. Any other value is a {@link RuleError} on `'rng'`.
   */
  rng?: 'shared' | 'own'
  enabled?: boolean
  query: string[]
  when?: string
  actions: RuleActionDef[]
}

/**
 * Which part of a {@link RuleDef} an error is about (§4.6). Later minors add
 * members, so keep a default branch when switching on it.
 */
export type RuleDefPath =
  | 'name'
  | 'schedule'
  | 'priority'
  | 'rng'
  | 'when'
  | { readonly query: number }
  | { readonly action: number; readonly part: 'set' | 'expr' }

export interface RuleError {
  rule: string
  /** Character position within the offending part's string (see `field`),
   *  or -1 for a non-syntax error (e.g. an unresolvable component name in
   *  `query` or an action's `set` target — see compileRule doc for the
   *  exact rule). */
  position: number
  message: string
  /** The part of the def the error is about. Set by compileRule and
   *  installRules from 2.1 on every error. */
  field?: RuleDefPath
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
  /** The component name as the rule spells it (what `resolveField` sees). */
  componentName: string
  field: string
  ast: AstNode
  run: CompiledExpression
}

interface CompiledRuleInternal extends CompiledRule {
  queryTypes: ComponentType<any>[]
  whenAst: AstNode | undefined
  when: CompiledExpression | undefined
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
 * - Every error carries `field` (§4.6), the one part of the def it is about:
 *   `'schedule'`, `'priority'`, `'rng'`, `{ query: i }`, `'when'` (parse, resolve and
 *   type errors), `{ action: i, part: 'set' }` (malformed target, unknown
 *   target component, forbidden target field) or `{ action: i, part: 'expr' }`
 *   (every error inside that expression). `position` is an offset within
 *   that part's string, or -1.
 * - If there are ANY errors, returns `{ rule: null, errors }` — never a
 *   partially-compiled rule.
 */
export function compileRule(
  def: RuleDef,
  resolve: (name: string) => ComponentType<any> | undefined,
): { rule: CompiledRule; errors: [] } | { rule: null; errors: RuleError[] } {
  const errors: RuleError[] = []
  const componentsByName = new Map<string, ComponentType<any>>()

  // O-69 (R7): a bad schedule or priority is a compile error, not a throw
  // from world.system().
  // §4.6: every error names the one part of the def it is about.
  const fail = (field: RuleDefPath, position: number, message: string): void => {
    errors.push({ rule: def.name, position, message, field })
  }

  if (def.schedule !== 'tick' && def.schedule !== 'fixed') {
    fail('schedule', -1, `Unknown schedule ${JSON.stringify(def.schedule)} (expected "tick" or "fixed")`)
  }
  if (def.priority !== undefined && !Number.isFinite(def.priority)) {
    fail('priority', -1, 'priority must be a finite number')
  }
  if (def.rng !== undefined && def.rng !== 'shared' && def.rng !== 'own') {
    fail('rng', -1, `Unknown rng ${JSON.stringify(def.rng)} (expected "shared" or "own")`)
  }

  function resolveAndTrack(
    name: string,
    pos: number,
    context: string,
    field: RuleDefPath,
  ): ComponentType<any> | undefined {
    const cached = componentsByName.get(name)
    if (cached) return cached
    const resolved = resolve(name)
    if (!resolved) {
      fail(field, pos, `Unknown component "${name}" ${context}`)
      return undefined
    }
    componentsByName.set(name, resolved)
    return resolved
  }

  function checkField(name: string, pos: number, field: RuleDefPath): void {
    if (FORBIDDEN_FIELDS.has(name)) fail(field, pos, `Field name "${name}" is not allowed`)
  }

  const queryTypes: ComponentType<any>[] = []
  for (let i = 0; i < def.query.length; i++) {
    const t = resolveAndTrack(def.query[i]!, -1, 'referenced in query', { query: i })
    if (t) queryTypes.push(t)
  }

  let whenAst: AstNode | undefined
  if (def.when !== undefined) {
    const parsed = parseExpression(def.when)
    if ('errors' in parsed) {
      for (const e of parsed.errors) fail('when', e.position, e.message)
    } else {
      whenAst = parsed.ast
      walkFieldRefs(whenAst, (component, field, pos) => {
        checkField(field, pos, 'when')
        resolveAndTrack(component, pos, 'referenced in "when"', 'when')
      })
    }
  }

  const compiledActions: CompiledAction[] = []
  // Index into def.actions of each compiledActions entry, for type errors.
  const compiledIndex: number[] = []
  for (let i = 0; i < def.actions.length; i++) {
    const action = def.actions[i]!
    const setPath: RuleDefPath = { action: i, part: 'set' }
    const exprPath: RuleDefPath = { action: i, part: 'expr' }
    const dotIdx = action.set.indexOf('.')
    if (dotIdx <= 0 || dotIdx === action.set.length - 1) {
      fail(setPath, -1, `Action "set" must be "Component.field", got "${action.set}"`)
      continue
    }
    const compName = action.set.slice(0, dotIdx)
    const fieldName = action.set.slice(dotIdx + 1)
    checkField(fieldName, -1, setPath)
    const targetType = resolveAndTrack(compName, -1, `referenced in action "${action.set}"`, setPath)

    const parsed = parseExpression(action.expr)
    if ('errors' in parsed) {
      for (const e of parsed.errors) fail(exprPath, e.position, e.message)
      continue
    }
    walkFieldRefs(parsed.ast, (component, field, pos) => {
      checkField(field, pos, exprPath)
      resolveAndTrack(component, pos, `referenced in action "${action.set}" expr`, exprPath)
    })
    if (targetType) {
      compiledIndex.push(i)
      compiledActions.push({
        component: targetType,
        componentName: compName,
        field: fieldName,
        ast: parsed.ast,
        run: compileExpression(parsed.ast),
      })
    }
  }

  if (errors.length > 0) return { rule: null, errors }

  // O-68 (R4): reject type errors certain before the rule runs (see
  // typecheck.ts). Field kinds are not inferred: defaults do not fix them.
  if (whenAst) inferKind(whenAst, (position, message) => fail('when', position, message))
  for (let j = 0; j < compiledActions.length; j++) {
    const exprPath: RuleDefPath = { action: compiledIndex[j]!, part: 'expr' }
    inferKind(compiledActions[j]!.ast, (position, message) => fail(exprPath, position, message))
  }
  if (errors.length > 0) return { rule: null, errors }

  const rule: CompiledRuleInternal = {
    def,
    queryTypes,
    whenAst,
    when: whenAst ? compileExpression(whenAst) : undefined,
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
  // Messages are built only on failure: this runs for every write.
  const target = (): string => `${action.component.name}.${action.field}`
  if (!Object.hasOwn(current, action.field)) {
    throw new RuleEvalError(`Cannot set ${target()}: the component has no such field`)
  }
  const prior = current[action.field]
  const before = typeof prior
  if (prior !== null && prior !== undefined && typeof value !== before) {
    throw new RuleEvalError(`Cannot set ${target()}: expected a ${before}, got ${typeof value}`)
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RuleEvalError(`Cannot set ${target()}: ${value} is not a finite number`)
  }
}

/**
 * Register a single compiled rule as a `world.system(...)`. `order` is the
 * secondary sort key (0 in 'registration' mode; `orderBase + i` in 'stable');
 * `rng` the stream mode when the def gives none (§4.4).
 */
function registerRuleSystem(
  world: World,
  rule: CompiledRuleInternal,
  order: number,
  rng: 'shared' | 'own',
): SystemHandle {
  const { def, queryTypes, when, actions, componentsByName } = rule
  // Keyed by the rule's own names, as reads through resolveField are.
  const actionKeys = actions.map((a) => `${a.componentName}.${a.field}`)
  // O-69 (R12): staging lookups are needed only when an action reads a
  // field an earlier action wrote, and commit dedupe only when two actions
  // write the same field. Both are known now, so the common case skips them.
  const readsStaged = actions.some((a, i) => {
    let hit = false
    walkFieldRefs(a.ast, (c, f) => {
      if (actionKeys.indexOf(`${c}.${f}`) < i && actionKeys.indexOf(`${c}.${f}`) >= 0) hit = true
    })
    return hit
  })
  const uniqueTargets = new Set(actionKeys).size === actionKeys.length

  return world.system(
    `rule:${def.name}`,
    {
      schedule: def.schedule,
      query: queryTypes,
      priority: def.priority ?? 0,
      order,
      // §4.4: an own stream is keyed by the cursor key `rule:<name>`, and
      // outlives the system, so update() re-registration resumes it.
      rng: def.rng ?? rng,
      enabled: () => def.enabled !== false,
      // §4.5: lets describe().systems map the system back to its rule.
      meta: { rule: def.name },
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
      // O-69 (R12): one environment and scratch state per run, reset per
      // entity, instead of fresh closures, maps and arrays for each one.
      // O-68 (R3): writes are staged per "Component.field" and committed
      // only when every action succeeded. Reads see staged values, so
      // actions still apply in order (`hp = 100; hp = hp - 1` → 99).
      const staged = new Map<string, number | string | boolean>()
      const targets: Array<Record<string, unknown>> = []
      const values: Array<number | string | boolean> = []
      const committed = new Set<string>()
      let entity!: EntityView
      const env: EvalEnv = {
        dt,
        time,
        rand: { uniform: () => ctx.rand.uniform() },
        resolveField(component, field) {
          if (staged.size > 0) {
            const pending = staged.get(component + '.' + field)
            if (pending !== undefined) return pending
          }
          const value = componentOf(component)
          if (value === undefined) return undefined
          // O-67: own properties only — never the prototype chain.
          return Object.hasOwn(value, field) ? (value[field] as number | string | boolean) : undefined
        },
      }
      // The entity's component: from its query view when the query holds
      // it, else looked up.
      function componentOf(name: string): Record<string, unknown> | undefined {
        if (name !== 'id') {
          const v = (entity as unknown as Record<string, unknown>)[name]
          if (v !== undefined) return v as Record<string, unknown>
        }
        const type = componentsByName.get(name)
        return type ? (world.getComponent(entity.id, type) as Record<string, unknown> | undefined) : undefined
      }

      for (const view of ctx.entities) {
        entity = view
        if (readsStaged) staged.clear()
        // One bad entity (e.g. a query match missing a field referenced by
        // `when`/an action) must never stop the rest of the query from
        // being processed this tick — see evaluator.ts's RuleEvalError doc.
        try {
          if (when && !when(env)) continue

          // O-68 (R3): evaluate and check every action, in order, before
          // writing any, so a failing action leaves the entity untouched.
          for (let i = 0; i < actions.length; i++) {
            const action = actions[i]!
            const result = action.run(env)
            const current = componentOf(action.component.name)
            // Atomic: a missing target component fails the whole entity.
            if (current === undefined) {
              throw new RuleEvalError(`Cannot set ${action.component.name}.${action.field}: the entity has no ${action.component.name}`)
            }
            checkWrite(action, current, result)
            targets[i] = current
            values[i] = result
            if (readsStaged) staged.set(actionKeys[i]!, result)
          }
          // Commit the final value of each field once; R9: an unchanged
          // value is not a change.
          if (uniqueTargets) {
            for (let i = 0; i < actions.length; i++) {
              const target = targets[i]!
              const field = actions[i]!.field
              if (Object.is(target[field], values[i])) continue
              target[field] = values[i]
              world.markChanged(entity.id, actions[i]!.component)
            }
            continue
          }
          committed.clear()
          for (let i = actions.length - 1; i >= 0; i--) {
            const action = actions[i]!
            const key = actionKeys[i]!
            if (committed.has(key)) continue
            committed.add(key)
            const target = targets[i]!
            const value = values[i]
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
   * Rules are registered in `defs` order, so equal-priority rules run in
   * that order (O-69). In 'registration' mode re-registration also moves
   * every rule after the equal-priority systems registered before this
   * call; in 'stable' mode it does not (see {@link InstallRulesOptions}). A def that repeats an earlier def's name is not
   * installed and is reported under that name.
   *
   * @returns a `Map<string, RuleError[]>` keyed by rule name for every def
   * that failed to compile or repeated a name. Rules without problems are
   * absent from the map — never present with an empty array.
   */
  update(defs: RuleDef[]): Map<string, RuleError[]>
  /** Remove every currently-installed rule system. */
  uninstall(): void
}

/** Largest |orderBase| for which every key orderBase + i stays exact. */
const MAX_ORDER_BASE = 2 ** 51

/** Options for {@link installRules}. */
export interface InstallRulesOptions {
  /**
   * 'registration' (default, 2.0 behaviour): rules tie-break by registration
   * index, so after `update()` they run after every equal-priority system
   * registered before it.
   * 'stable': rule i (its index in the de-duplicated defs) registers with
   * `order: orderBase + i`, so its run position is a pure function of
   * (priority, defs order), never of when `update()` ran. A def that fails
   * to compile keeps its index.
   */
  readonly order?: 'registration' | 'stable'
  /**
   * First order key used in 'stable' mode (finite, |orderBase| <= 2^51 so
   * every key orderBase + i stays exact). Default 1, so systems
   * with the default order 0 run before rules of the same priority. Give
   * each stable handle on one world its own range.
   */
  readonly orderBase?: number
  /**
   * Default stream mode for every rule that sets no {@link RuleDef.rng}
   * (§4.4). Default `'shared'` (2.0 behaviour). `'own'` gives each rule its
   * own stream, so editing one rule never reshuffles another's draws.
   */
  readonly rng?: 'shared' | 'own'
}

/**
 * Constructs a {@link RulesHandle} and immediately calls `update(defs)` once.
 *
 * @throws Error when `options.order` is not 'registration' or 'stable',
 *   `options.orderBase` is not a finite number with |orderBase| <= 2^51, or
 *   `options.rng` is not 'shared' or 'own'.
 */
export function installRules(
  world: World,
  defs: RuleDef[],
  resolve: (name: string) => ComponentType<any> | undefined,
  options: InstallRulesOptions = {},
): RulesHandle {
  const mode = options.order ?? 'registration'
  if (mode !== 'registration' && mode !== 'stable') {
    throw new Error(`@domecs/rules: installRules order must be 'registration' or 'stable', got ${JSON.stringify(mode)}`)
  }
  const orderBase = options.orderBase ?? 1
  // |orderBase| <= 2^51 keeps every key orderBase + i below 2^52, where a
  // double's spacing is at most 0.5, so consecutive keys stay distinct and
  // increasing. Past that, e.g. MAX_SAFE_INTEGER + 1 === MAX_SAFE_INTEGER + 2,
  // two rules would share a key and tie-break by registration index again.
  if (typeof orderBase !== 'number' || !Number.isFinite(orderBase) || Math.abs(orderBase) > MAX_ORDER_BASE) {
    throw new Error(
      `@domecs/rules: installRules orderBase must be a finite number with |orderBase| <= 2^51 (so orderBase + i stays exact), got ${String(orderBase)}`,
    )
  }
  const rngMode = options.rng ?? 'shared'
  if (rngMode !== 'shared' && rngMode !== 'own') {
    throw new Error(`@domecs/rules: installRules rng must be 'shared' or 'own', got ${JSON.stringify(rngMode)}`)
  }
  const active = new Map<string, SystemHandle>()

  function update(newDefs: RuleDef[]): Map<string, RuleError[]> {
    const errorsByName = new Map<string, RuleError[]>()
    const newNames = new Set<string>()
    // Index in the de-duplicated defs: the stable-mode order key.
    let index = 0

    for (const def of newDefs) {
      // O-69 (R8): a repeated name would silently replace the earlier rule.
      if (newNames.has(def.name)) {
        const list = errorsByName.get(def.name) ?? []
        list.push({
          rule: def.name,
          position: -1,
          message: `Duplicate rule name "${def.name}"; only the first is installed`,
          field: 'name',
        })
        errorsByName.set(def.name, list)
        continue
      }
      newNames.add(def.name)
      const order = mode === 'stable' ? orderBase + index : 0
      index++

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

      const handle = registerRuleSystem(world, compiled.rule as CompiledRuleInternal, order, rngMode)
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
