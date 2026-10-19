import { dmath } from '@domecs/core'
import type { AstNode, EntityNode, FunctionName } from './ast.js'

/** A value an expression produces. */
type Value = number | string | boolean

/**
 * Everything `evaluate` needs, without touching a `World` — the AST /
 * parser / evaluator stay pure and world-agnostic (the only "@domecs/core"
 * import is the pure `dmath` namespace, so `sin()`/`cos()` and, from 2.2,
 * `atan2()`/`hypot()`/`pow()` are bit-reproducible across engines; O-75).
 * The world-facing wiring (resolving `Component.field` against a real
 * `World`) lives in rules.ts.
 *
 * The 2.2 members (spec §5.2) are optional, so the evaluator stays usable
 * without a world: a form whose hook is missing raises a
 * {@link RuleEvalError} "not available in this environment".
 */
export interface EvalEnv {
  /**
   * Resolve a `Component.field` reference. Return `undefined` when the
   * component is not registered/known, when the entity currently being
   * evaluated does not have that component, or when the component instance
   * has no such field. `evaluate` treats any of those uniformly: it throws
   * a {@link RuleEvalError} (a "no value" one, which `??` catches; see the
   * class doc for how rules.ts handles it).
   */
  resolveField(component: string, field: string): Value | undefined
  /** Current tick delta-time in seconds (schedule-dependent — see rules.ts). */
  dt: number
  /** Current elapsed simulation time in seconds. */
  time: number
  /** Deterministic RNG hook for the `random()` builtin. */
  rand: { uniform(): number }
  /** The evaluated entity's id (`self`, `self.id`; excluded by selectors). */
  self?: number
  /** `C.f` on another entity, own properties only; `undefined` when absent. */
  readField?(entity: number, component: string, field: string): Value | undefined
  /** The entities holding component `set`, ascending id, stable within a run. */
  members?(set: string): readonly number[]
  /** Whether `entity` is alive (`entity(n)`). */
  isAlive?(entity: number): boolean
  /** Whether `entity` holds `component` (`has`). */
  has?(entity: number, component: string): boolean
  /** The entity's position (live), or `undefined` when it has none. */
  position?(entity: number): { x: number; y: number } | undefined
  /** Nearest member of `set` to (x, y) within `maxDistance` (ties → lowest id), excluding `exclude`. */
  nearest?(set: string, x: number, y: number, maxDistance: number, exclude: number | undefined): number | undefined
  /** Members of `set` within `r` of (x, y), ascending id, excluding `exclude`. */
  within?(set: string, x: number, y: number, r: number, exclude: number | undefined): readonly number[]
  /** `world.time.tick` (`tick`). */
  tick?: number
}

/**
 * Thrown by `evaluate` when it cannot produce a value — for
 * an unresolvable `Component.field` reference (missing component or missing
 * field on the entity being evaluated), and for a value of the wrong type
 * reaching an operator/function that requires a specific type (e.g. `+` on
 * a boolean). rules.ts also throws it for a write it rejects (O-67: missing
 * target component or field, a kind mismatch, a non-finite number).
 *
 * **Documented contract (per M6 spec):** this is a per-entity-per-tick
 * condition, not a systemic one. `evaluate` itself does not know about
 * entities or ticks — it just throws. The caller (`installRules` in
 * rules.ts) catches `RuleEvalError` **per entity**, skips that entity for
 * the tick, reports it as a `rule_eval_failed` fault on the entity (O-68),
 * and continues with the next entity in the query. One bad entity must
 * never stop the rest of the query from being processed that tick. Any
 * other error is a bug and propagates.
 */
export class RuleEvalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuleEvalError'
  }
}

/**
 * "No value" (2.2, §5.2): a missing self or member field, an empty
 * selector result, a dead `entity(n)`, an empty `avg`/`minOf`/`maxOf`, an
 * entity without a position. `a ?? b` evaluates `b` on this error only.
 * Internal: `instanceof RuleEvalError` still holds, so uncaught it is the
 * existing per-entity `rule_eval_failed` fault.
 */
export class RuleNoValueError extends RuleEvalError {
  constructor(message: string) {
    super(message)
    this.name = 'RuleNoValueError'
  }
}

function toBoolean(value: Value): boolean {
  return Boolean(value)
}

function expectNumber(value: Value, context: string): number {
  if (typeof value !== 'number') {
    throw new RuleEvalError(`Expected a number for ${context}, got ${typeof value} (${describeValue(value)})`)
  }
  return value
}

/**
 * A short rendering of a value for an error message that cannot itself
 * throw — component fields may hold BigInts, symbols or cyclic objects.
 */
function describeValue(value: unknown): string {
  try {
    const json = JSON.stringify(value)
    if (json !== undefined) return json
  } catch {
    // fall through
  }
  try {
    return String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

function notAvailable(what: string): RuleEvalError {
  return new RuleEvalError(`"${what}" is not available in this environment`)
}

function hook<K extends keyof EvalEnv>(env: EvalEnv, key: K, what: string): NonNullable<EvalEnv[K]> {
  const fn = env[key]
  if (fn === undefined) throw notAvailable(what)
  return fn as NonNullable<EvalEnv[K]>
}

function selfId(env: EvalEnv): number {
  if (env.self === undefined) throw notAvailable('self')
  return env.self
}

function noField(component: string, field: string, entity?: number): RuleNoValueError {
  return new RuleNoValueError(
    entity === undefined
      ? `Field "${component}.${field}" is not available on this entity`
      : `Field "${component}.${field}" is not available on entity ${entity}`,
  )
}

/**
 * `C.f` on `entity`: the evaluated entity reads through `resolveField`
 * (staged writes included), any other through `readField`.
 */
function readOn(env: EvalEnv, entity: number, component: string, field: string): Value | undefined {
  if (entity === env.self) return env.resolveField(component, field)
  return hook(env, 'readField', `${component}.${field} on another entity`)(entity, component, field)
}

function positionOf(env: EvalEnv, entity: number, what: string): { x: number; y: number } {
  const p = hook(env, 'position', what)(entity)
  if (p === undefined) throw new RuleNoValueError(`Entity ${entity} has no position (${what})`)
  return p
}

function distanceBetween(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  return Math.sqrt(dx * dx + dy * dy)
}

/** Resolve an entity node to an id. `expr` evaluates its expression arguments. */
function resolveEntity(node: EntityNode, env: EvalEnv, expr: (n: AstNode) => Value): number {
  switch (node.kind) {
    case 'self':
      return selfId(env)
    case 'entityById': {
      const n = expectNumber(expr(node.id), 'entity()')
      if (!Number.isInteger(n)) throw new RuleEvalError(`entity() needs an integer id, got ${n}`)
      if (!hook(env, 'isAlive', 'entity()')(n)) throw new RuleNoValueError(`entity(${n}) is not alive`)
      return n
    }
    case 'select': {
      if (node.op === 'first') {
        const members = hook(env, 'members', `first(${node.set})`)(node.set)
        for (const id of members) if (id !== env.self) return id
        throw new RuleNoValueError(`first(${node.set}) has no member`)
      }
      const what = `nearest(${node.set})`
      const nearest = hook(env, 'nearest', what)
      const self = selfId(env)
      const maxDistance = node.maxDistance ? expectNumber(expr(node.maxDistance), 'nearest()') : Infinity
      const at = positionOf(env, self, what)
      const id = nearest(node.set, at.x, at.y, maxDistance, self)
      if (id === undefined) throw new RuleNoValueError(`${what} has no member in range`)
      return id
    }
  }
}

/** The evaluation of one aggregate (shared by both evaluation paths). */
function aggregate(
  node: Extract<AstNode, { kind: 'aggregate' }>,
  env: EvalEnv,
): Value {
  const members = hook(env, 'members', `${node.op}(${node.set})`)(node.set)
  if (node.op === 'count') return members.length
  if (node.op === 'exists') return members.length > 0
  const component = node.component!
  const field = node.field!
  const ctx = `${node.op}()`
  let n = 0
  let acc = 0
  for (const id of members) {
    const raw = readOn(env, id, component, field)
    if (raw === undefined) continue // members without the field are skipped
    const v = expectNumber(raw, ctx)
    if (node.op === 'sum' || node.op === 'avg') acc = n === 0 ? v : acc + v
    else if (node.op === 'minOf') acc = n === 0 ? v : Math.min(acc, v)
    else acc = n === 0 ? v : Math.max(acc, v)
    n++
  }
  if (node.op === 'sum') return n === 0 ? 0 : acc
  if (n === 0) throw new RuleNoValueError(`${node.op}(${node.set}, ${component}.${field}) has no member with that field`)
  return node.op === 'avg' ? acc / n : acc
}

function countWithin(
  node: Extract<AstNode, { kind: 'countWithin' }>,
  env: EvalEnv,
  expr: (n: AstNode) => Value,
): number {
  const what = `countWithin(${node.set})`
  const within = hook(env, 'within', what)
  const radius = expectNumber(expr(node.radius), 'countWithin()')
  const centre = node.centre ? resolveEntity(node.centre, env, expr) : selfId(env)
  const at = positionOf(env, centre, what)
  return within(node.set, at.x, at.y, radius, centre).length
}

function distanceTo(
  node: Extract<AstNode, { kind: 'distanceTo' }>,
  env: EvalEnv,
  expr: (n: AstNode) => Value,
): number {
  const target = resolveEntity(node.target, env, expr)
  const a = positionOf(env, selfId(env), 'distanceTo()')
  const b = positionOf(env, target, 'distanceTo()')
  return distanceBetween(a.x, a.y, b.x, b.y)
}

function member(
  node: Extract<AstNode, { kind: 'member' }>,
  env: EvalEnv,
  expr: (n: AstNode) => Value,
): Value {
  if (node.target.kind === 'self') {
    const value = env.resolveField(node.component, node.field)
    if (value === undefined) throw noField(node.component, node.field)
    return value
  }
  const id = resolveEntity(node.target, env, expr)
  const value = readOn(env, id, node.component, node.field)
  if (value === undefined) throw noField(node.component, node.field, id)
  return value
}

/**
 * Evaluate a parsed expression against `env`. Pure with respect to the AST
 * (no mutation), but each call to `random()` advances `env.rand`'s
 * underlying state — see rules.ts for how that is wired to a per-tick
 * `Rng` for deterministic replay.
 *
 * Short-circuits `&&`, `||`, `?:` and `??` — the untaken branch is never
 * evaluated, so it can reference fields the current entity lacks without
 * raising (matches ordinary expression-language expectations and avoids
 * spurious RuleEvalErrors from branches that were never meant to run).
 */
export function evaluate(ast: AstNode, env: EvalEnv): Value {
  const expr = (n: AstNode): Value => evaluate(n, env)
  switch (ast.kind) {
    case 'number':
    case 'string':
    case 'boolean':
      return ast.value

    case 'identifier':
      if (ast.name === 'tick') {
        if (env.tick === undefined) throw notAvailable('tick')
        return env.tick
      }
      return ast.name === 'dt' ? env.dt : env.time

    case 'field': {
      const value = env.resolveField(ast.component, ast.field)
      if (value === undefined) throw noField(ast.component, ast.field)
      return value
    }

    case 'unary': {
      if (ast.op === '!') return !toBoolean(evaluate(ast.operand, env))
      return -expectNumber(evaluate(ast.operand, env), `unary "-"`)
    }

    case 'logical': {
      const left = toBoolean(evaluate(ast.left, env))
      if (ast.op === '&&') return left && toBoolean(evaluate(ast.right, env))
      return left || toBoolean(evaluate(ast.right, env))
    }

    case 'nullish':
      try {
        return evaluate(ast.left, env)
      } catch (e) {
        if (!(e instanceof RuleNoValueError)) throw e
        return evaluate(ast.right, env)
      }

    case 'ternary':
      return toBoolean(evaluate(ast.cond, env))
        ? evaluate(ast.then, env)
        : evaluate(ast.else, env)

    case 'binary': {
      if (ast.op === '==' || ast.op === '!=') {
        const left = evaluate(ast.left, env)
        const right = evaluate(ast.right, env)
        return ast.op === '==' ? left === right : left !== right
      }
      const left = expectNumber(evaluate(ast.left, env), `"${ast.op}"`)
      const right = expectNumber(evaluate(ast.right, env), `"${ast.op}"`)
      switch (ast.op) {
        case '+':
          return left + right
        case '-':
          return left - right
        case '*':
          return left * right
        case '/':
          return left / right
        case '%':
          return left % right
        case '<':
          return left < right
        case '<=':
          return left <= right
        case '>':
          return left > right
        case '>=':
          return left >= right
      }
      // exhaustive
      return left
    }

    case 'call': {
      const ctx = `${ast.name}()`
      const args = ast.args.map((n) => expectNumber(evaluate(n, env), ctx))
      return applyFunction(ast.name, args, env)
    }

    case 'member':
      return member(ast, env, expr)

    case 'entityId':
      return resolveEntity(ast.target, env, expr)

    case 'has': {
      const id = resolveEntity(ast.target, env, expr)
      return hook(env, 'has', `has(${ast.component})`)(id, ast.component)
    }

    case 'aggregate':
      return aggregate(ast, env)

    case 'countWithin':
      return countWithin(ast, env, expr)

    case 'distanceTo':
      return distanceTo(ast, env, expr)
  }
}

/** Apply a whitelisted function to already-checked numeric arguments. */
function applyFunction(name: FunctionName, a: number[], env: EvalEnv): number {
  switch (name) {
    case 'min':
      return Math.min(a[0]!, a[1]!)
    case 'max':
      return Math.max(a[0]!, a[1]!)
    case 'clamp':
      return Math.min(Math.max(a[0]!, a[1]!), a[2]!)
    case 'abs':
      return Math.abs(a[0]!)
    case 'sin':
      return dmath.sin(a[0]!)
    case 'cos':
      return dmath.cos(a[0]!)
    case 'floor':
      return Math.floor(a[0]!)
    case 'random':
      return env.rand.uniform()
    case 'sqrt':
      return Math.sqrt(a[0]!)
    case 'pow':
      return dmath.pow(a[0]!, a[1]!)
    case 'atan2':
      return dmath.atan2(a[0]!, a[1]!)
    case 'hypot':
      return dmath.hypot(a[0]!, a[1]!)
    case 'sign':
      return Math.sign(a[0]!)
    case 'round':
      return Math.round(a[0]!)
    case 'ceil':
      return Math.ceil(a[0]!)
    case 'lerp':
      return a[0]! + (a[1]! - a[0]!) * a[2]!
    case 'distance':
      return distanceBetween(a[0]!, a[1]!, a[2]!, a[3]!)
  }
}

/** A compiled expression: {@link evaluate} for one AST, without the walk. */
export type CompiledExpression = (env: EvalEnv) => Value

/** Options for {@link compileExpression}. */
export interface CompileOptions {
  /**
   * Aggregates for which this returns true are computed once per
   * environment object (rules.ts builds one per rule run) and reused for
   * every entity of that run. Only sound when the aggregate cannot change
   * during the run: rules.ts marks a set aggregate whose field's component
   * the rule does not write (§5.2 "Memoization"). Results are identical
   * either way.
   */
  readonly memoize?: (node: Extract<AstNode, { kind: 'aggregate' }>) => boolean
}

/**
 * O-69 (R12): turn `ast` into nested closures once, so a rule evaluated for
 * every entity every tick does not re-dispatch on node kinds. Same results,
 * errors and short-circuiting as {@link evaluate}; no code is generated.
 */
export function compileExpression(ast: AstNode, options: CompileOptions = {}): CompiledExpression {
  const compile = (n: AstNode): CompiledExpression => compileExpression(n, options)
  switch (ast.kind) {
    case 'number':
    case 'string':
    case 'boolean': {
      const value = ast.value
      return () => value
    }
    case 'identifier':
      if (ast.name === 'tick') {
        return (env) => {
          if (env.tick === undefined) throw notAvailable('tick')
          return env.tick
        }
      }
      return ast.name === 'dt' ? (env) => env.dt : (env) => env.time
    case 'field': {
      const { component, field } = ast
      return (env) => {
        const value = env.resolveField(component, field)
        if (value === undefined) throw noField(component, field)
        return value
      }
    }
    case 'unary': {
      const operand = compile(ast.operand)
      if (ast.op === '!') return (env) => !toBoolean(operand(env))
      return (env) => -expectNumber(operand(env), 'unary "-"')
    }
    case 'logical': {
      const left = compile(ast.left)
      const right = compile(ast.right)
      return ast.op === '&&'
        ? (env) => toBoolean(left(env)) && toBoolean(right(env))
        : (env) => toBoolean(left(env)) || toBoolean(right(env))
    }
    case 'nullish': {
      const left = compile(ast.left)
      const right = compile(ast.right)
      return (env) => {
        try {
          return left(env)
        } catch (e) {
          if (!(e instanceof RuleNoValueError)) throw e
          return right(env)
        }
      }
    }
    case 'ternary': {
      const cond = compile(ast.cond)
      const then = compile(ast.then)
      const otherwise = compile(ast.else)
      return (env) => (toBoolean(cond(env)) ? then(env) : otherwise(env))
    }
    case 'binary': {
      const left = compile(ast.left)
      const right = compile(ast.right)
      const op = ast.op
      if (op === '==') return (env) => left(env) === right(env)
      if (op === '!=') return (env) => left(env) !== right(env)
      const ctx = `"${op}"`
      const num = (f: CompiledExpression, env: EvalEnv): number => expectNumber(f(env), ctx)
      switch (op) {
        case '+': return (env) => { const a = num(left, env); return a + num(right, env) }
        case '-': return (env) => { const a = num(left, env); return a - num(right, env) }
        case '*': return (env) => { const a = num(left, env); return a * num(right, env) }
        case '/': return (env) => { const a = num(left, env); return a / num(right, env) }
        case '%': return (env) => { const a = num(left, env); return a % num(right, env) }
        case '<': return (env) => { const a = num(left, env); return a < num(right, env) }
        case '<=': return (env) => { const a = num(left, env); return a <= num(right, env) }
        case '>': return (env) => { const a = num(left, env); return a > num(right, env) }
        case '>=': return (env) => { const a = num(left, env); return a >= num(right, env) }
      }
      return left
    }
    case 'call': {
      const args = ast.args.map(compile)
      const n = (i: number, env: EvalEnv, ctx: string): number => expectNumber(args[i]!(env), ctx)
      switch (ast.name) {
        case 'min': return (env) => { const a = n(0, env, 'min()'); return Math.min(a, n(1, env, 'min()')) }
        case 'max': return (env) => { const a = n(0, env, 'max()'); return Math.max(a, n(1, env, 'max()')) }
        case 'clamp': return (env) => {
          const v = n(0, env, 'clamp()')
          const lo = n(1, env, 'clamp()')
          return Math.min(Math.max(v, lo), n(2, env, 'clamp()'))
        }
        case 'abs': return (env) => Math.abs(n(0, env, 'abs()'))
        case 'sin': return (env) => dmath.sin(n(0, env, 'sin()'))
        case 'cos': return (env) => dmath.cos(n(0, env, 'cos()'))
        case 'floor': return (env) => Math.floor(n(0, env, 'floor()'))
        case 'random': return (env) => env.rand.uniform()
        case 'sqrt': return (env) => Math.sqrt(n(0, env, 'sqrt()'))
        case 'sign': return (env) => Math.sign(n(0, env, 'sign()'))
        case 'round': return (env) => Math.round(n(0, env, 'round()'))
        case 'ceil': return (env) => Math.ceil(n(0, env, 'ceil()'))
        case 'pow': return (env) => { const a = n(0, env, 'pow()'); return dmath.pow(a, n(1, env, 'pow()')) }
        case 'atan2': return (env) => { const a = n(0, env, 'atan2()'); return dmath.atan2(a, n(1, env, 'atan2()')) }
        case 'hypot': return (env) => { const a = n(0, env, 'hypot()'); return dmath.hypot(a, n(1, env, 'hypot()')) }
        case 'lerp': return (env) => {
          const a = n(0, env, 'lerp()')
          const b = n(1, env, 'lerp()')
          return a + (b - a) * n(2, env, 'lerp()')
        }
        case 'distance': return (env) => {
          const x1 = n(0, env, 'distance()')
          const y1 = n(1, env, 'distance()')
          const x2 = n(2, env, 'distance()')
          return distanceBetween(x1, y1, x2, n(3, env, 'distance()'))
        }
      }
    }
    // The 2.2 forms: closures over the shared helpers. Expression arguments
    // inside entity nodes are compiled once and looked up by node.
    case 'member':
    case 'entityId':
    case 'has':
    case 'countWithin':
    case 'distanceTo': {
      const compiled = new Map<AstNode, CompiledExpression>()
      const collect = (node: EntityNode | undefined): void => {
        if (node?.kind === 'select' && node.maxDistance) compiled.set(node.maxDistance, compile(node.maxDistance))
        if (node?.kind === 'entityById') compiled.set(node.id, compile(node.id))
      }
      if (ast.kind === 'countWithin') {
        compiled.set(ast.radius, compile(ast.radius))
        collect(ast.centre)
      } else {
        collect(ast.target)
      }
      const node = ast
      return (env) => {
        const expr = (child: AstNode): Value => compiled.get(child)!(env)
        switch (node.kind) {
          case 'member':
            return member(node, env, expr)
          case 'entityId':
            return resolveEntity(node.target, env, expr)
          case 'has':
            return hook(env, 'has', `has(${node.component})`)(resolveEntity(node.target, env, expr), node.component)
          case 'countWithin':
            return countWithin(node, env, expr)
          default:
            return distanceTo(node, env, expr)
        }
      }
    }
    case 'aggregate': {
      const node = ast
      if (!options.memoize?.(node)) return (env) => aggregate(node, env)
      // One value per environment (= per rule run in rules.ts).
      let cachedEnv: EvalEnv | undefined
      let cached: Value = 0
      return (env) => {
        if (cachedEnv === env) return cached
        cached = aggregate(node, env)
        cachedEnv = env
        return cached
      }
    }
  }
}
