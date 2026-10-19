import {
  And,
  Has,
  Not,
  createSpatialGrid,
  validateEventPayload,
  type ComponentType,
  type EntityView,
  type EventType,
  type InputSnapshot,
  type QueryDef,
  type SpatialGrid,
  type SystemDef,
  type SystemFault,
  type SystemHandle,
  type World,
} from '@domecs/core'
import { childNodes, walkComponentRefs, type AstNode, type EntityNode } from './ast.js'
import { parseExpression } from './parser.js'
import { compileExpression, RuleEvalError, RuleNoValueError, type CompiledExpression, type EvalEnv } from './evaluator.js'
import { inferKind } from './typecheck.js'

/**
 * O-67: field names a rule may never read or write. Reads are own-property
 * only, and these names would reach the object's prototype machinery.
 */
export const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

export interface RuleActionDef {
  /** Dotted "Component.field" target, same JSON shape as Studio's SystemData.actions. */
  set: string
  expr: string
}

export interface RuleDef {
  name: string
  /**
   * `'tick'` / `'fixed'`: the rule polls every entity matching `query` on
   * that schedule. `'event'` (2.3, §6.1): the rule runs when the event named
   * by {@link on} is delivered — once per payload, in emission order — for
   * the entity {@link self} names, else for every entity matching `query`
   * (broadcast, ascending id), else once with no entity (world scope: empty
   * `query`, no `self`).
   */
  schedule: 'tick' | 'fixed' | 'event'
  /**
   * Event rules (2.3): the name of the event that triggers the rule,
   * resolved through {@link InstallRulesOptions.resolveEvent} (default
   * `world.lookupEvent`). Required iff `schedule` is `'event'`.
   */
  on?: string
  /**
   * Event rules (2.3): an expression giving self's entity id from the
   * payload, e.g. `"event.target"`. When it names an entity that is not
   * alive or does not match `query`/`without`, the payload is skipped
   * silently; when it gives no value or no integer, that is a systemic
   * `rule_eval_failed` fault (`event.target ?? -1` skips silently instead).
   * It cannot read an evaluated entity (`C.f`, `self`, ...) or `other`.
   */
  self?: string
  /**
   * Event rules (2.3): an expression giving the entity `other` refers to,
   * e.g. `"event.b"`. When it gives no value, or the entity is dead,
   * reads of `other` are no value. Same restrictions as {@link self}.
   */
  other?: string
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
  /**
   * Components that exclude an entity from the rule (2.2, §5.2): the rule
   * runs on entities holding every `query` component and none of these
   * (`And(...query.map(Has), ...without.map(c => Not(Has(c))))`).
   */
  without?: string[]
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
  // 2.3 (§6.1): event rules.
  | 'on'
  | 'self'
  | 'other'
  | { readonly query: number }
  | { readonly without: number }
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
  /** Event rules: the resolved trigger. */
  eventType: EventType<unknown> | undefined
  /** Event rules: the compiled `self` / `other` bindings. */
  selfBinding: CompiledExpression | undefined
  otherBinding: CompiledExpression | undefined
  /** Event rule with no `self` and an empty `query`: runs once per payload with no entity. */
  worldScope: boolean
  queryTypes: ComponentType<any>[]
  withoutTypes: ComponentType<any>[]
  /** Sets read by `nearest`/`countWithin`: one grid each per run. */
  spatialSets: string[]
  /** The resolved `spatial` option, when any form needs positions. */
  spatial: ResolvedSpatial | undefined
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
 * - Event rules (2.3, §6.1): `on` must resolve through
 *   `options.resolveEvent` (`field: 'on'`); `on`, `self` and `other` on a
 *   polling rule are errors at that field. `event.f` outside an event rule,
 *   or naming a field the event's schema does not declare, and `other`
 *   without an `other` binding, are errors at their position. The `self` /
 *   `other` bindings and every expression of a world-scope rule (no `self`,
 *   empty `query`) cannot read an evaluated entity (`C.f`, `self`,
 *   `has(C)`, `nearest`, `distanceTo`, a centre-less `countWithin`); a
 *   world-scope rule cannot `set` (`{ action: i, part: 'set' }`) or use
 *   `without`.
 * - Every error carries `field` (§4.6), the one part of the def it is about:
 *   `'schedule'`, `'priority'`, `'rng'`, `'on'`, `'self'`, `'other'`, `{ query: i }`, `'when'` (parse, resolve and
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
  options: CompileRuleOptions = {},
): { rule: CompiledRule; errors: [] } | { rule: null; errors: RuleError[] } {
  const errors: RuleError[] = []
  const componentsByName = new Map<string, ComponentType<any>>()

  // O-69 (R7): a bad schedule or priority is a compile error, not a throw
  // from world.system().
  // §4.6: every error names the one part of the def it is about.
  const fail = (field: RuleDefPath, position: number, message: string): void => {
    errors.push({ rule: def.name, position, message, field })
  }

  if (def.schedule !== 'tick' && def.schedule !== 'fixed' && def.schedule !== 'event') {
    fail('schedule', -1, `Unknown schedule ${JSON.stringify(def.schedule)} (expected "tick", "fixed" or "event")`)
  }
  // §6.1: event rules name their trigger; polling rules have no payload.
  const isEvent = def.schedule === 'event'
  let eventType: EventType<unknown> | undefined
  if (isEvent) {
    if (def.on === undefined) {
      fail('on', -1, 'An event rule needs "on": the name of the event that triggers it')
    } else if (typeof def.on !== 'string' || def.on.length === 0) {
      fail('on', -1, `"on" must be an event name, got ${JSON.stringify(def.on)}`)
    } else {
      eventType = options.resolveEvent?.(def.on)
      if (!eventType) {
        fail('on', -1, options.resolveEvent
          ? `Unknown event "${def.on}"`
          : `Unknown event "${def.on}" (no resolveEvent was given; installRules uses world.lookupEvent)`)
      }
    }
  } else {
    for (const key of ['on', 'self', 'other'] as const) {
      if (def[key] !== undefined) fail(key, -1, `"${key}" is only for event rules (schedule "event")`)
    }
  }
  const worldScope = isEvent && def.self === undefined && def.query.length === 0
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
  const withoutTypes: ComponentType<any>[] = []
  for (let i = 0; i < (def.without ?? []).length; i++) {
    if (worldScope) {
      fail({ without: i }, -1, 'A world-scope event rule (no "self", empty "query") has no entities to exclude')
      continue
    }
    const t = resolveAndTrack(def.without![i]!, -1, 'referenced in without', { without: i })
    if (t) withoutTypes.push(t)
  }

  // §5.2: every component name in an expression — self and member reads,
  // sets, `has` targets, aggregate fields — resolves, and member fields get
  // the O-67 check too. Spatial forms need the `spatial` option.
  const spatialSets = new Set<string>()
  let spatial: ResolvedSpatial | undefined
  // §6.1: where an expression has no evaluated entity — a `self`/`other`
  // binding (evaluated before self is known) or a world-scope rule.
  type NoEntity = 'binding' | 'world' | undefined
  const NO_ENTITY: Record<'binding' | 'world', string> = {
    binding: 'in a "self"/"other" binding (it runs before self is bound)',
    world: 'in a world-scope event rule (no "self", empty "query")',
  }
  function checkExpression(ast: AstNode, path: RuleDefPath, context: string, source: string, noEntity?: NoEntity): void {
    walkComponentRefs(ast, (component, field, pos) => {
      if (field !== null) checkField(field, pos, path)
      resolveAndTrack(component, pos, context, path)
    })
    forEachNode(ast, (node) => {
      if (node.kind === 'event') {
        if (!isEvent) {
          fail(path, node.pos, `"event.${node.field}" reads the triggering event's payload: only event rules (schedule "event") have one`)
        } else if (FORBIDDEN_FIELDS.has(node.field)) {
          checkField(node.field, node.pos, path)
        } else if (eventType) {
          // A declared schema fixes the payload's fields (absent = optional).
          const problem = validateEventPayload(eventType, Object.fromEntries([[node.field, undefined]]))
          if (problem !== null) fail(path, node.pos, `Event "${def.on}": ${problem}`)
        }
      } else if (node.kind === 'other') {
        if (!isEvent) {
          fail(path, node.pos, '"other": only event rules (schedule "event") with an "other" binding have one')
        } else if (noEntity === 'binding') {
          fail(path, node.pos, '"other" cannot be read in a "self"/"other" binding (neither is bound yet); use entity(n)')
        } else if (def.other === undefined) {
          fail(path, node.pos, '"other" needs an "other" binding on the rule (e.g. other: "event.b")')
        }
      }
      if (noEntity !== undefined) {
        const what = entityForm(node, source)
        if (what !== null) fail(path, node.pos, `${what} reads the evaluated entity, but there is no evaluated entity ${NO_ENTITY[noEntity]}`)
      }
      // §5.4 (AGENTS.md rule 4): key edges and the wheel are per render
      // tick, so a fixed step (zero, one or several per frame) would miss
      // them or see them twice.
      if (def.schedule === 'fixed') {
        if (node.kind === 'input' && (node.op === 'pressed' || node.op === 'released')) {
          fail(path, node.pos, `${node.op}() in a fixed rule: key edges last one render tick, so a fixed step can miss one or see it twice; read key() (held) or put the rule on the tick schedule`)
        } else if (node.kind === 'pointer' && node.field === 'wheel') {
          fail(path, node.pos, 'pointer.wheel in a fixed rule: the wheel accumulates over one render tick, so a fixed step can miss it or see it twice; put the rule on the tick schedule')
        }
      }
      const form = spatialForm(node)
      if (form === null) return
      if (node.kind === 'select' || node.kind === 'countWithin') spatialSets.add(node.set)
      const option = options.spatial
      if (!option) {
        fail(path, node.pos, `"${form}" needs positions: pass the spatial option to installRules`)
        return
      }
      const type = resolveAndTrack(option.component, node.pos, 'named by the spatial option', path)
      if (type) spatial = { type, x: option.x ?? 'x', y: option.y ?? 'y', cellSize: option.cellSize ?? DEFAULT_CELL_SIZE }
    })
  }

  // §6.1: the `self` / `other` bindings of an event rule.
  const bindingAsts: { self?: AstNode; other?: AstNode } = {}
  if (isEvent) {
    for (const key of ['self', 'other'] as const) {
      const source = def[key]
      if (source === undefined) continue
      if (typeof source !== 'string') {
        fail(key, -1, `"${key}" must be an expression string, got ${JSON.stringify(source)}`)
        continue
      }
      const parsed = parseExpression(source)
      if ('errors' in parsed) {
        for (const e of parsed.errors) fail(key, e.position, e.message)
        continue
      }
      bindingAsts[key] = parsed.ast
      checkExpression(parsed.ast, key, `referenced in "${key}"`, source, 'binding')
    }
  }
  const exprScope: NoEntity = worldScope ? 'world' : undefined

  let whenAst: AstNode | undefined
  if (def.when !== undefined) {
    const parsed = parseExpression(def.when)
    if ('errors' in parsed) {
      for (const e of parsed.errors) fail('when', e.position, e.message)
    } else {
      whenAst = parsed.ast
      checkExpression(whenAst, 'when', 'referenced in "when"', def.when, exprScope)
    }
  }

  const compiledActions: CompiledAction[] = []
  // Index into def.actions of each compiledActions entry, for type errors.
  const compiledIndex: number[] = []
  for (let i = 0; i < def.actions.length; i++) {
    const action = def.actions[i]!
    const setPath: RuleDefPath = { action: i, part: 'set' }
    const exprPath: RuleDefPath = { action: i, part: 'expr' }
    if (worldScope) {
      fail(setPath, -1, `A world-scope event rule (no "self", empty "query") has no entity to set; give it a "self" or a "query", or emit an event`)
      continue
    }
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
    checkExpression(parsed.ast, exprPath, `referenced in action "${action.set}" expr`, action.expr)
    if (targetType) {
      compiledIndex.push(i)
      compiledActions.push({
        component: targetType,
        componentName: compName,
        field: fieldName,
        ast: parsed.ast,
        run: undefined as unknown as CompiledExpression, // compiled below, once memoization is known
      })
    }
  }

  if (errors.length > 0) return { rule: null, errors }

  // O-68 (R4): reject type errors certain before the rule runs (see
  // typecheck.ts). Field kinds are not inferred: defaults do not fix them.
  if (whenAst) inferKind(whenAst, (position, message) => fail('when', position, message))
  for (const key of ['self', 'other'] as const) {
    const ast = bindingAsts[key]
    if (!ast) continue
    const kind = inferKind(ast, (position, message) => fail(key, position, message))
    if (kind === 'string' || kind === 'boolean') fail(key, ast.pos, `"${key}" must give an entity id (a number), not a ${kind}`)
  }
  for (let j = 0; j < compiledActions.length; j++) {
    const exprPath: RuleDefPath = { action: compiledIndex[j]!, part: 'expr' }
    inferKind(compiledActions[j]!.ast, (position, message) => fail(exprPath, position, message))
  }
  if (errors.length > 0) return { rule: null, errors }

  // §5.2 memoization: a set aggregate is computed once per run when it
  // cannot change during the run — `count`/`exists` always (membership is
  // stable within a run), a field aggregate when the rule writes no field of
  // that component. Otherwise it is recomputed per entity (Gauss–Seidel).
  // Compared by resolved type, not spelling: `resolve` may map two names to
  // one component, and both read the same data.
  const written = new Set(compiledActions.map((a) => a.component))
  const memo = {
    memoize: (node: Extract<AstNode, { kind: 'aggregate' }>): boolean =>
      node.component === undefined || !written.has(componentsByName.get(node.component)!),
  }
  for (const action of compiledActions) action.run = compileExpression(action.ast, memo)

  const rule: CompiledRuleInternal = {
    def,
    eventType,
    selfBinding: bindingAsts.self ? compileExpression(bindingAsts.self, memo) : undefined,
    otherBinding: bindingAsts.other ? compileExpression(bindingAsts.other, memo) : undefined,
    worldScope,
    queryTypes,
    withoutTypes,
    spatialSets: [...spatialSets],
    spatial,
    whenAst,
    when: whenAst ? compileExpression(whenAst, memo) : undefined,
    actions: compiledActions,
    componentsByName,
  }
  return { rule, errors: [] }
}

/** Default `spatial.cellSize`: a pure performance setting (results never depend on it). */
export const DEFAULT_CELL_SIZE = 32

/** Where positions come from (§5.2), resolved against real component types. */
interface ResolvedSpatial {
  type: ComponentType<any>
  x: string
  y: string
  cellSize: number
}

/** The position source for `nearest`, `countWithin` and `distanceTo`. */
export interface SpatialOption {
  /** Component holding each entity's position. */
  readonly component: string
  /** Field names (default `'x'` / `'y'`). */
  readonly x?: string
  readonly y?: string
  /** Grid cell size (default 32): performance only, results never depend on it. */
  readonly cellSize?: number
}

/** Options for {@link compileRule} (2.2). */
export interface CompileRuleOptions {
  /** Position source; required if the rule uses `nearest`, `countWithin` or `distanceTo`. */
  readonly spatial?: SpatialOption
  /**
   * Event types by name (2.3, §6.1), for an event rule's `on`.
   * `installRules` defaults it to `world.lookupEvent`; `compileRule` has
   * no default, so an event rule compiled without it reports `on`.
   */
  readonly resolveEvent?: (name: string) => EventType<unknown> | undefined
}

/**
 * The form that reads the evaluated entity, described for an error, or
 * null (2.3, §6.1): where there is none — a binding or a world-scope rule.
 */
function entityForm(node: AstNode | EntityNode, source: string): string | null {
  switch (node.kind) {
    case 'field':
      return `"${node.component}.${node.field}"`
    case 'self':
      // `has(C)` parses with an implicit self at the `has` token.
      return source.startsWith('self', node.pos) ? '"self"' : `has(C) (it tests self; write has(e, C))`
    case 'select':
      return node.op === 'nearest' ? `nearest(${node.set}) (it measures from self)` : null
    case 'distanceTo':
      return 'distanceTo(e) (it measures from self)'
    case 'countWithin':
      return node.centre ? null : `countWithin(${node.set}, r) (it counts around self; give a centre)`
    default:
      return null
  }
}

/** The name of the spatial form `node` is, or null. */
function spatialForm(node: AstNode | EntityNode): string | null {
  if (node.kind === 'select' && node.op === 'nearest') return 'nearest'
  if (node.kind === 'countWithin') return 'countWithin'
  if (node.kind === 'distanceTo') return 'distanceTo'
  return null
}

/** Visit `root` and every node below it (expressions and entity nodes), parents first. */
export function forEachNode(root: AstNode, visit: (node: AstNode | EntityNode) => void): void {
  const stack: Array<AstNode | EntityNode> = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    visit(node)
    const children = childNodes(node)
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!)
  }
}

/**
 * §5.4 (verify pass): `setInput` takes whatever the host built, and a host
 * rebuilding snapshots from JSON (an act log) can pass arrays or drop a
 * part. A malformed part is a fault on the entity, as a non-number pointer
 * field is (evaluator.ts), never a TypeError out of the step.
 */
function inputSet(value: unknown, part: string): ReadonlySet<string> {
  if (value instanceof Set) return value as ReadonlySet<string>
  if (value !== null && typeof value === 'object' && typeof (value as { has?: unknown }).has === 'function') {
    return value as ReadonlySet<string>
  }
  throw new RuleEvalError(`input.${part} is not a Set (${Array.isArray(value) ? 'an array' : value === null ? 'null' : typeof value})`)
}

function inputMods(value: unknown): Readonly<Record<string, unknown>> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>
  throw new RuleEvalError(`input.mods is not an object (${Array.isArray(value) ? 'an array' : value === null ? 'null' : typeof value})`)
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
  const { def, eventType, selfBinding, otherBinding, worldScope, queryTypes, withoutTypes, spatialSets, spatial, when, actions, componentsByName } = rule
  const isEvent = def.schedule === 'event'
  // Staging keys name the resolved component type, not the rule's spelling:
  // `resolve` may map two names to one component, and a read under either
  // name must see the other's staged write.
  const typeIndex = new Map<ComponentType<any>, number>()
  for (const t of componentsByName.values()) if (!typeIndex.has(t)) typeIndex.set(t, typeIndex.size)
  const keyOf = (component: string, field: string): string => `${typeIndex.get(componentsByName.get(component)!)}.${field}`
  const actionKeys = actions.map((a) => keyOf(a.componentName, a.field))
  // O-69 (R12): staging lookups are needed only when an action reads a
  // field an earlier action wrote, and commit dedupe only when two actions
  // write the same field. Both are known now, so the common case skips them.
  // Any field read counts (§5.2): an aggregate or `entity(n)` may read the
  // evaluated entity itself, which resolves through resolveField.
  const readsStaged = actions.some((a, i) => {
    let hit = false
    walkComponentRefs(a.ast, (c, f) => {
      if (f === null) return
      const k = actionKeys.indexOf(keyOf(c, f))
      if (k >= 0 && k < i) hit = true
    })
    return hit
  })
  const uniqueTargets = new Set(actionKeys).size === actionKeys.length
  // §5.2 `without`: And(...Has, ...Not(Has)); the plain list otherwise (2.1 shape).
  const query: QueryDef =
    withoutTypes.length === 0 ? queryTypes : And(...queryTypes.map((t) => Has(t)), ...withoutTypes.map((t) => Not(Has(t))))
  // One grid per spatial set, cleared and refilled at the start of each run.
  const grids = new Map<string, SpatialGrid>()
  if (spatial) for (const set of spatialSets) grids.set(set, createSpatialGrid(spatial.cellSize))

  const common = {
    priority: def.priority ?? 0,
    order,
    // §4.4: an own stream is keyed by the cursor key `rule:<name>`, and
    // outlives the system, so update() re-registration resumes it.
    rng: def.rng ?? rng,
    enabled: () => def.enabled !== false,
    // §4.5: lets describe().systems map the system back to its rule.
    meta: { rule: def.name },
  }
  // §6.1: an event rule is a core event system triggered by its event (so
  // describe() lists the event); a world-scope one has no query.
  const systemDef: SystemDef = isEvent
    ? { schedule: 'event', triggers: [eventType!], ...(worldScope ? {} : { query }), ...common }
    : { schedule: def.schedule as 'tick' | 'fixed', query, ...common }
  const matches = (id: number): boolean => {
    for (const t of queryTypes) if (!world.has(id, t)) return false
    for (const t of withoutTypes) if (world.has(id, t)) return false
    return true
  }

  return world.system(
    `rule:${def.name}`,
    systemDef,
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
      // The evaluated entity; undefined in a world-scope event rule.
      let entity: EntityView | undefined
      // §6.1: the payload being handled (event rules).
      let payload: unknown
      // §5.2: member lists, once per run per set (ascending id; structure
      // never changes during a run).
      const memberCache = new Map<string, readonly number[]>()
      const members = (set: string): readonly number[] => {
        let list = memberCache.get(set)
        if (list === undefined) {
          const type = componentsByName.get(set)
          list = type ? world.listEntities([type]) : []
          memberCache.set(set, list)
        }
        return list
      }
      const position = (id: number): { x: number; y: number } | undefined => {
        if (!spatial) return undefined
        const value = world.getComponent(id, spatial.type) as Record<string, unknown> | undefined
        if (value === undefined || !Object.hasOwn(value, spatial.x) || !Object.hasOwn(value, spatial.y)) return undefined
        const x = value[spatial.x]
        const y = value[spatial.y]
        return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)
          ? { x, y }
          : undefined
      }
      // §5.4: the input `setInput` (or an input plugin) installed for this tick.
      // Typed as possibly absent: a host can install anything (see inputSet).
      const input = ctx.input as InputSnapshot | undefined
      const excluding = (exclude: number | undefined): ((id: number) => boolean) | undefined =>
        exclude === undefined ? undefined : (id) => id !== exclude
      const env: EvalEnv = {
        dt,
        time,
        rand: { uniform: () => ctx.rand.uniform() },
        resolveField(component, field) {
          if (staged.size > 0) {
            const pending = staged.get(keyOf(component, field))
            if (pending !== undefined) return pending
          }
          const value = componentOf(component)
          if (value === undefined) return undefined
          // O-67: own properties only — never the prototype chain.
          return Object.hasOwn(value, field) ? (value[field] as number | string | boolean) : undefined
        },
        tick: ctx.time.tick,
        readField(id, component, field) {
          const type = componentsByName.get(component)
          const value = type ? (world.getComponent(id, type) as Record<string, unknown> | undefined) : undefined
          if (value === undefined || !Object.hasOwn(value, field)) return undefined
          return value[field] as number | string | boolean
        },
        members,
        isAlive: (id) => world.isAlive(id),
        has(id, component) {
          const type = componentsByName.get(component)
          return type !== undefined && world.isAlive(id) && world.has(id, type)
        },
        position,
        nearest(set, x, y, maxDistance, exclude) {
          const grid = grids.get(set)
          if (!grid) return undefined
          const accept = excluding(exclude)
          return accept ? grid.nearest(x, y, { maxDistance, accept }) : grid.nearest(x, y, { maxDistance })
        },
        within(set, x, y, r, exclude) {
          const grid = grids.get(set)
          return grid ? grid.within(x, y, r, excluding(exclude)) : []
        },
        input: {
          key: (name) => inputSet(input?.keys, 'keys').has(name),
          pressed: (name) => inputSet(input?.keyDelta?.pressed, 'keyDelta.pressed').has(name),
          released: (name) => inputSet(input?.keyDelta?.released, 'keyDelta.released').has(name),
          mod: (name) => {
            const mods = inputMods(input?.mods)
            return Object.hasOwn(mods, name) && mods[name] === true
          },
          pointer: input?.pointer as NonNullable<EvalEnv['input']>['pointer'],
        },
      }
      if (isEvent) {
        // §6.1 `event.f`: an own field of the payload; absent, undefined or
        // null is no value; anything else that is not a primitive is a type error.
        env.eventField = (field) => {
          if (payload === null || typeof payload !== 'object' || !Object.hasOwn(payload, field)) return undefined
          const value: unknown = (payload as Record<string, unknown>)[field]
          if (value === undefined || value === null) return undefined
          if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value
          throw new RuleEvalError(`"event.${field}" is not a number, string or boolean (${typeof value})`)
        }
      }
      // §5.2 spatial selection: grids from positions at the start of the run.
      if (grids.size > 0 && (isEvent || ctx.entities.length > 0)) {
        for (const [set, grid] of grids) {
          grid.clear()
          for (const id of members(set)) {
            const p = position(id)
            if (p) grid.set(id, p.x, p.y)
          }
        }
      }
      // The entity's component: from its query view when the query holds
      // it, else looked up.
      function componentOf(name: string): Record<string, unknown> | undefined {
        if (entity === undefined) return undefined
        if (name !== 'id') {
          const v = (entity as unknown as Record<string, unknown>)[name]
          if (v !== undefined) return v as Record<string, unknown>
        }
        const type = componentsByName.get(name)
        return type ? (world.getComponent(entity.id, type) as Record<string, unknown> | undefined) : undefined
      }

      // Run the rule for one entity (undefined: a world-scope event rule).
      // One bad entity (e.g. a query match missing a field referenced by
      // `when`/an action) must never stop the rest of the query from being
      // processed this tick — see evaluator.ts's RuleEvalError doc.
      function runEntity(view: EntityView | undefined): void {
        entity = view
        env.self = view?.id
        if (readsStaged) staged.clear()
        try {
          if (when && !when(env)) return

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
              world.markChanged(view!.id, actions[i]!.component)
            }
            return
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
            world.markChanged(view!.id, action.component)
          }
        } catch (e) {
          if (!(e instanceof RuleEvalError)) throw e
          fault(view?.id, e.message)
        }
      }
      // A fault on the entity, or a systemic one (`signals.faultRaised`)
      // when there is none: a world-scope rule or a failed binding.
      function fault(id: number | undefined, message: string): void {
        const error: RuleFault = { kind: 'rule_eval_failed', rule: def.name, message }
        faults.push(id === undefined ? { error, recoverable: true } : { entity: id, error, recoverable: true })
      }
      // §6.1: a binding's entity id; no value is undefined when allowed.
      function bind(expr: CompiledExpression, key: 'self' | 'other'): number | undefined {
        let value: unknown
        try {
          value = expr(env)
        } catch (e) {
          if (key === 'other' && e instanceof RuleNoValueError) return undefined
          if (e instanceof RuleEvalError) throw new RuleEvalError(`"${key}" (${def[key]}): ${e.message}`)
          throw e
        }
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          throw new RuleEvalError(`"${key}" (${def[key]}) must give an entity id (an integer), got ${typeof value === 'number' ? value : typeof value}`)
        }
        return value
      }

      if (!isEvent) {
        for (const view of ctx.entities) runEntity(view)
      } else {
        // §6.1: each payload of this tick, in emission order.
        for (const p of ctx.events.of(eventType!)) {
          payload = p
          entity = undefined
          env.self = undefined
          env.other = undefined
          let selfId: number | undefined
          try {
            if (otherBinding) env.other = bind(otherBinding, 'other')
            if (selfBinding) selfId = bind(selfBinding, 'self')
          } catch (e) {
            if (!(e instanceof RuleEvalError)) throw e
            fault(undefined, e.message)
            continue
          }
          if (selfBinding) {
            // Not alive or not matching: a deterministic no-op.
            if (!world.isAlive(selfId!) || !matches(selfId!)) continue
            runEntity(world.getView(selfId!))
          } else if (worldScope) {
            runEntity(undefined)
          } else {
            for (const view of ctx.entities) runEntity(view)
          }
        }
        payload = undefined
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
  /**
   * Position source for `nearest`, `countWithin` and `distanceTo` (2.2,
   * §5.2); required if any rule uses them (otherwise that rule fails to
   * compile). Selection uses a grid built from these positions at the start
   * of each rule run; `distanceTo` reads live positions. An entity whose
   * position fields are missing or not finite numbers has no position.
   */
  readonly spatial?: SpatialOption
  /**
   * Event types by name, for event rules' `on` (2.3, §6.1). Default
   * `world.lookupEvent`: the event must be known to the world (registered,
   * emitted, subscribed to or a trigger) when `update()` compiles the rule,
   * and its name must not be ambiguous.
   */
  readonly resolveEvent?: (name: string) => EventType<unknown> | undefined
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
  const spatialOption = options.spatial
  if (spatialOption !== undefined) {
    const isName = (v: unknown): boolean => typeof v === 'string' && v.length > 0 && !FORBIDDEN_FIELDS.has(v)
    if (
      typeof spatialOption !== 'object' ||
      spatialOption === null ||
      !isName(spatialOption.component) ||
      (spatialOption.x !== undefined && !isName(spatialOption.x)) ||
      (spatialOption.y !== undefined && !isName(spatialOption.y))
    ) {
      throw new Error(
        `@domecs/rules: installRules spatial must be { component, x?, y?, cellSize? } with non-empty names, got ${JSON.stringify(spatialOption)}`,
      )
    }
    const cs = spatialOption.cellSize
    if (cs !== undefined && (typeof cs !== 'number' || !Number.isFinite(cs) || cs <= 0)) {
      throw new Error(`@domecs/rules: installRules spatial.cellSize must be a finite number > 0, got ${String(cs)}`)
    }
  }
  const active = new Map<string, SystemHandle>()
  const compileOptions: CompileRuleOptions = {
    ...(spatialOption ? { spatial: spatialOption } : {}),
    resolveEvent: options.resolveEvent ?? ((name) => world.lookupEvent(name)),
  }

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

      const compiled = compileRule(def, resolve, compileOptions)
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
