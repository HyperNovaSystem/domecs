import {
  createSpatialGrid,
  err,
  ok,
  type ComponentType,
  type Result,
  type SpatialGrid,
  type World,
} from '@domecs/core'
import { walkComponentRefs, type AstNode } from './ast.js'
import { compileExpression, RuleEvalError, type CompiledExpression, type EvalEnv } from './evaluator.js'
import { parseExpression } from './parser.js'
import {
  DEFAULT_CELL_SIZE,
  FORBIDDEN_FIELDS,
  forEachNode,
  type InstallRulesOptions,
  type RuleError,
  type RuleFault,
} from './rules.js'
import { inferKind } from './typecheck.js'

/** The `rule` name world-expression errors and faults carry. */
const RULE = '<expr>'

/**
 * A compiled world expression (2.2, §5.3): a rules expression with no
 * evaluated entity, for metrics, probes and outcomes measured over a whole
 * world.
 */
export interface WorldExpression {
  /** The source it was compiled from. */
  readonly source: string
  /** The parsed expression. */
  readonly ast: AstNode
  /**
   * Evaluate against `world`'s current state. Read-only: never mutates the
   * world, never draws randomness, never moves change windows, so
   * `hashSnapshot(world.snapshot({}), { includeChanges: true })` is the same
   * after any number of calls, and `describe()` changes only by a type
   * object attached to data a restore left unregistered. Retains nothing
   * of `world` after it returns. A no-value read without `??`, a type error,
   * a non-finite number or a non-primitive result is
   * `err({ kind: 'rule_eval_failed', rule: '<expr>', message })`.
   */
  evaluate(world: World): Result<number | string | boolean, RuleFault>
}

/**
 * Compile a world expression (2.2, §5.3): the rules grammar without an
 * evaluated entity. Rejected at compile time, at the form's position:
 * bare `Component.field`, `self`, `has(C)` without an entity, `distanceTo`
 * and `nearest` (both measure from the evaluated entity), `countWithin`
 * without a centre, `dt`, `random()` (measuring a world must not
 * advance its randomness), and the input reads `key`, `pressed`,
 * `released`, `mod` and `pointer.*` (a metric must not depend on input), and
 * (2.3) the event-rule forms `event.f` and `other`. `time` is `world.time.elapsed` and `tick` is
 * `world.time.tick`. Everything else — selectors `first(S)` and
 * `entity(n)` with `.C.f` / `.id` reads, `has(e, C)`, aggregates,
 * `countWithin(S, r, e)` (needs `options.spatial`), math and `??` —
 * means what it means in a rule.
 *
 * Unknown components, forbidden fields and certain type errors are errors
 * too, as in `compileRule`. Errors carry `rule: '<expr>'` and a `position`
 * in `source`, in source order. Never throws.
 */
export function compileWorldExpression(
  source: string,
  resolve: (name: string) => ComponentType<any> | undefined,
  options: { readonly spatial?: InstallRulesOptions['spatial'] } = {},
): { expression: WorldExpression; errors: [] } | { expression: null; errors: RuleError[] } {
  if (typeof source !== 'string') {
    return { expression: null, errors: [{ rule: RULE, position: -1, message: 'A world expression must be a string' }] }
  }
  const parsed = parseExpression(source)
  if ('errors' in parsed) {
    return {
      expression: null,
      errors: parsed.errors.map((e) => ({ rule: RULE, position: e.position, message: e.message })),
    }
  }
  const ast = parsed.ast
  const errors: RuleError[] = []
  const fail = (position: number, message: string): void => {
    errors.push({ rule: RULE, position, message })
  }

  // Every component name resolves; member fields get the O-67 check.
  const types = new Map<string, ComponentType<any>>()
  const resolveName = (name: string, pos: number, context: string): ComponentType<any> | undefined => {
    const known = types.get(name)
    if (known) return known
    let type: ComponentType<any> | undefined
    try {
      type = resolve(name)
    } catch (e) {
      fail(pos, `Resolving component "${name}" ${context} failed: ${e instanceof Error ? e.message : String(e)}`)
      return undefined
    }
    if (!type) {
      fail(pos, `Unknown component "${name}" ${context}`)
      return undefined
    }
    types.set(name, type)
    return type
  }
  walkComponentRefs(ast, (component, field, pos) => {
    if (field !== null && FORBIDDEN_FIELDS.has(field)) fail(pos, `Field name "${field}" is not allowed`)
    resolveName(component, pos, 'referenced in the expression')
  })

  // Forms that need an evaluated entity, or that would change the world.
  const NO_ENTITY = 'no entity in a world expression'
  let spatial: { type: ComponentType<any>; x: string; y: string; cellSize: number } | undefined
  forEachNode(ast, (node) => {
    switch (node.kind) {
      case 'field':
        fail(node.pos, `"${node.component}.${node.field}" reads the evaluated entity, but there is ${NO_ENTITY}; use first(S).${node.component}.${node.field}`)
        return
      case 'self':
        // `has(C)` parses with an implicit self at the `has` token.
        if (source.startsWith('self', node.pos)) fail(node.pos, `"self": there is ${NO_ENTITY}; use first(S) or entity(n)`)
        else fail(node.pos, `has(C) tests the evaluated entity, but there is ${NO_ENTITY}; use has(first(S), C)`)
        return
      case 'identifier':
        if (node.name === 'dt') fail(node.pos, '"dt" is not available in a world expression (it has no schedule); use time or tick')
        return
      case 'call':
        if (node.name === 'random') {
          fail(node.pos, 'random() is not allowed in a world expression: it would advance the world\'s randomness, so measuring would change the future')
        }
        return
      case 'input':
        fail(node.pos, `${node.op}() reads input, but a world expression must not depend on input (a metric measures the world's state)`)
        return
      case 'pointer':
        fail(node.pos, `pointer.${node.field} reads input, but a world expression must not depend on input (a metric measures the world's state)`)
        return
      case 'event':
        fail(node.pos, `"event.${node.field}" reads the triggering event's payload: only event rules (schedule "event") have one`)
        return
      case 'other':
        fail(node.pos, `"other" is bound only in an event rule with an "other" binding; use first(S) or entity(n)`)
        return
      case 'distanceTo':
        fail(node.pos, `distanceTo(e) measures from the evaluated entity, but there is ${NO_ENTITY}; use distance(x1, y1, x2, y2) with first(S) reads`)
        return
      case 'select':
        if (node.op === 'nearest') {
          fail(node.pos, `nearest(${node.set}) measures from the evaluated entity, but there is ${NO_ENTITY}; use first(S) or entity(n)`)
        }
        return
      case 'countWithin': {
        if (!node.centre) {
          fail(node.pos, `countWithin(${node.set}, r) counts around the evaluated entity, but there is ${NO_ENTITY}; give a centre: countWithin(${node.set}, r, first(S))`)
          return
        }
        const option = options.spatial
        if (!option) {
          fail(node.pos, '"countWithin" needs positions: pass the spatial option')
          return
        }
        const problem = spatialProblem(option)
        if (problem) {
          fail(node.pos, problem)
          return
        }
        const type = resolveName(option.component, node.pos, 'named by the spatial option')
        if (type) spatial = { type, x: option.x ?? 'x', y: option.y ?? 'y', cellSize: option.cellSize ?? DEFAULT_CELL_SIZE }
        return
      }
      default:
        return
    }
  })

  if (errors.length === 0) inferKind(ast, fail)
  if (errors.length > 0) {
    // Stable: errors at one position keep the order they were found in.
    return { expression: null, errors: errors.map((e, i) => [e, i] as const).sort((a, b) => a[0].position - b[0].position || a[1] - b[1]).map(([e]) => e) }
  }

  // Per call, nothing can change the world, so every aggregate is computed
  // once per evaluation (the environment is fresh for each call).
  const run = compileExpression(ast, { memoize: () => true })
  const expression: WorldExpression = {
    source,
    ast,
    evaluate: (world) => evaluateOn(world, run, types, spatial),
  }
  return { expression, errors: [] }
}

/** Why `option` is not a usable `spatial` option, or null. Mirrors installRules' validation. */
function spatialProblem(option: NonNullable<InstallRulesOptions['spatial']>): string | null {
  const isName = (v: unknown): boolean => typeof v === 'string' && v.length > 0 && !FORBIDDEN_FIELDS.has(v)
  if (
    typeof option !== 'object' ||
    option === null ||
    !isName(option.component) ||
    (option.x !== undefined && !isName(option.x)) ||
    (option.y !== undefined && !isName(option.y))
  ) {
    return 'The spatial option must be { component, x?, y?, cellSize? } with non-empty names'
  }
  const cs = option.cellSize
  if (cs !== undefined && (typeof cs !== 'number' || !Number.isFinite(cs) || cs <= 0)) {
    return 'spatial.cellSize must be a finite number > 0'
  }
  return null
}

function evaluateOn(
  target: World,
  run: CompiledExpression,
  types: ReadonlyMap<string, ComponentType<any>>,
  spatial: { type: ComponentType<any>; x: string; y: string; cellSize: number } | undefined,
): Result<number | string | boolean, RuleFault> {
  // The compiled aggregates memoize by environment object and keep the last
  // one, so nothing the environment reaches may outlive this call: every
  // closure reads the world through `live`, cleared (with the caches) in
  // `finally`, and never through the `target` parameter.
  let live: World | undefined = target
  const world = (): World => live!
  // Which referenced types this world can be read through (per call).
  // - Registered under this name: read. Core keeps a store for every
  //   registered type (across restore too), so a read changes nothing.
  //   A *different* type under the name is an error value.
  // - Not registered, but held by some entity: a snapshot restored into a
  //   world that never registered the type keeps the data by name. Read it;
  //   the read attaches the type object to that name, as every core read
  //   does — no state, snapshot or hash changes.
  // - Not registered and held by no entity: absent, and not asked about:
  //   a core read would register a new type with an empty store.
  const held = new Map<ComponentType<any>, boolean>()
  let counts: Readonly<Record<string, number>> | undefined
  const holds = (type: ComponentType<any>, spelling: string): boolean => {
    let answer = held.get(type)
    if (answer === undefined) {
      const registered = world().lookupComponent(type.name)
      if (registered !== undefined && registered !== type) {
        throw new RuleEvalError(`Component "${spelling}" is a different component type in this world (same name "${type.name}")`)
      }
      if (registered !== undefined) answer = true
      else {
        counts ??= world().describe().componentCounts
        answer = Object.hasOwn(counts, type.name) && counts[type.name]! > 0
      }
      held.set(type, answer)
    }
    return answer
  }
  const typeOf = (name: string): ComponentType<any> | undefined => {
    const type = types.get(name)
    return type !== undefined && holds(type, name) ? type : undefined
  }
  const memberCache = new Map<string, readonly number[]>()
  const members = (set: string): readonly number[] => {
    let list = memberCache.get(set)
    if (list === undefined) {
      const type = typeOf(set)
      list = type ? world().listEntities([type]) : []
      memberCache.set(set, list)
    }
    return list
  }
  const position = (id: number): { x: number; y: number } | undefined => {
    if (!spatial || !holds(spatial.type, spatial.type.name) || !world().isAlive(id)) return undefined
    const value = world().getComponent(id, spatial.type) as Record<string, unknown> | undefined
    if (value === undefined || !Object.hasOwn(value, spatial.x) || !Object.hasOwn(value, spatial.y)) return undefined
    const x = value[spatial.x]
    const y = value[spatial.y]
    return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined
  }
  // One grid per set, built on first use in this call.
  const grids = new Map<string, SpatialGrid>()
  const gridOf = (set: string): SpatialGrid => {
    let grid = grids.get(set)
    if (grid === undefined) {
      grid = createSpatialGrid(spatial?.cellSize ?? DEFAULT_CELL_SIZE)
      for (const id of members(set)) {
        const p = position(id)
        if (p) grid.set(id, p.x, p.y)
      }
      grids.set(set, grid)
    }
    return grid
  }
  const env: EvalEnv = {
    // No evaluated entity: bare reads and `self` are rejected at compile time.
    resolveField: () => undefined,
    dt: 0,
    time: target.time.elapsed,
    tick: target.time.tick,
    rand: {
      uniform: () => {
        throw new RuleEvalError('random() is not available in a world expression')
      },
    },
    readField(id, component, field) {
      const type = typeOf(component)
      const value = type && world().isAlive(id) ? (world().getComponent(id, type) as Record<string, unknown> | undefined) : undefined
      if (value === undefined || !Object.hasOwn(value, field)) return undefined
      return value[field] as number | string | boolean
    },
    members,
    isAlive: (id) => world().isAlive(id),
    has(id, component) {
      const type = typeOf(component)
      return type !== undefined && world().isAlive(id) && world().has(id, type)
    },
    position,
    within: (set, x, y, r, exclude) => gridOf(set).within(x, y, r, exclude === undefined ? undefined : (id) => id !== exclude),
  }
  try {
    const value: unknown = run(env)
    if (typeof value === 'number' && !Number.isFinite(value)) {
      // As for a rule's write (O-67): NaN and ±Infinity do not survive JSON
      // (they become null), so a metric sample could not be stored or compared.
      return err({ kind: 'rule_eval_failed', rule: RULE, message: `The expression produced ${value}, not a finite number` })
    }
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return ok(value)
    return err({
      kind: 'rule_eval_failed',
      rule: RULE,
      message: `The expression produced ${value === null ? 'null' : `a ${typeof value}`}, not a number, string or boolean`,
    })
  } catch (e) {
    if (!(e instanceof RuleEvalError)) throw e
    return err({ kind: 'rule_eval_failed', rule: RULE, message: e.message })
  } finally {
    live = undefined
    counts = undefined
    held.clear()
    memberCache.clear()
    grids.clear()
  }
}
