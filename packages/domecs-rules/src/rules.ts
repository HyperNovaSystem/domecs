import type { ComponentType, SystemHandle, World } from '@domecs/core'
import { walkFieldRefs, type AstNode } from './ast.js'
import { parseExpression } from './parser.js'
import { evaluate, type EvalEnv } from './evaluator.js'

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
      walkFieldRefs(whenAst, (component, _field, pos) => {
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
    const targetType = resolveAndTrack(compName, -1, `referenced in action "${action.set}"`)

    const parsed = parseExpression(action.expr)
    if ('errors' in parsed) {
      for (const e of parsed.errors) errors.push({ rule: def.name, position: e.position, message: e.message })
      continue
    }
    walkFieldRefs(parsed.ast, (component, _field, pos) => {
      resolveAndTrack(component, pos, `referenced in action "${action.set}" expr`)
    })
    if (targetType) {
      compiledActions.push({ component: targetType, field: fieldName, ast: parsed.ast })
    }
  }

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

      for (const entity of ctx.entities) {
        // One bad entity (e.g. a query match missing a field referenced by
        // `when`/an action) must never stop the rest of the query from
        // being processed this tick — see evaluator.ts's RuleEvalError doc.
        // Documented choice: skip-this-entity, not propagate/crash.
        try {
          const env: EvalEnv = {
            dt,
            time,
            rand: { uniform: () => ctx.rand.uniform() },
            resolveField(component, field) {
              const type = componentsByName.get(component)
              if (!type) return undefined
              const value = world.getComponent(entity.id, type) as
                | Record<string, number | string | boolean>
                | undefined
              if (value === undefined) return undefined
              return value[field]
            },
          }

          if (whenAst && !evaluate(whenAst, env)) continue

          for (const action of actions) {
            const result = evaluate(action.ast, env)
            const current = world.getComponent(entity.id, action.component) as
              | Record<string, unknown>
              | undefined
            if (current === undefined) continue
            current[action.field] = result
            world.markChanged(entity.id, action.component)
          }
        } catch {
          continue
        }
      }
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
