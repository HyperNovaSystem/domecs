import { dmath } from '@domecs/core'
import type { AstNode, FunctionName } from './ast.js'

/**
 * Everything `evaluate` needs, without touching a `World` — the AST /
 * parser / evaluator stay pure and world-agnostic (the only "@domecs/core"
 * import is the pure `dmath` namespace, so `sin()`/`cos()` are
 * bit-reproducible across engines; O-75). The world-facing wiring
 * (resolving `Component.field` against a real `World`) lives in rules.ts.
 */
export interface EvalEnv {
  /**
   * Resolve a `Component.field` reference. Return `undefined` when the
   * component is not registered/known, when the entity currently being
   * evaluated does not have that component, or when the component instance
   * has no such field. `evaluate` treats any of those uniformly: it throws
   * a {@link RuleEvalError} (see the class doc for how rules.ts handles it).
   */
  resolveField(component: string, field: string): number | string | boolean | undefined
  /** Current tick delta-time in seconds (schedule-dependent — see rules.ts). */
  dt: number
  /** Current elapsed simulation time in seconds. */
  time: number
  /** Deterministic RNG hook for the `random()` builtin. */
  rand: { uniform(): number }
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

function toBoolean(value: number | string | boolean): boolean {
  return Boolean(value)
}

function expectNumber(value: number | string | boolean, context: string): number {
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

/**
 * Evaluate a parsed expression against `env`. Pure with respect to the AST
 * (no mutation), but each call to `random()` advances `env.rand`'s
 * underlying state — see rules.ts for how that is wired to a per-tick
 * `Rng` for deterministic replay.
 *
 * Short-circuits `&&`, `||`, and `?:` — the untaken branch is never
 * evaluated, so it can reference fields the current entity lacks without
 * raising (matches ordinary expression-language expectations and avoids
 * spurious RuleEvalErrors from branches that were never meant to run).
 */
export function evaluate(ast: AstNode, env: EvalEnv): number | string | boolean {
  switch (ast.kind) {
    case 'number':
    case 'string':
    case 'boolean':
      return ast.value

    case 'identifier':
      return ast.name === 'dt' ? env.dt : env.time

    case 'field': {
      const value = env.resolveField(ast.component, ast.field)
      if (value === undefined) {
        throw new RuleEvalError(
          `Field "${ast.component}.${ast.field}" is not available on this entity`,
        )
      }
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

    case 'call':
      return evaluateCall(ast.name, ast.args, env)
  }
}

function evaluateCall(name: FunctionName, args: AstNode[], env: EvalEnv): number {
  switch (name) {
    case 'min': {
      const [a, b] = args.map((n) => expectNumber(evaluate(n, env), 'min()'))
      return Math.min(a!, b!)
    }
    case 'max': {
      const [a, b] = args.map((n) => expectNumber(evaluate(n, env), 'max()'))
      return Math.max(a!, b!)
    }
    case 'clamp': {
      const [v, lo, hi] = args.map((n) => expectNumber(evaluate(n, env), 'clamp()'))
      return Math.min(Math.max(v!, lo!), hi!)
    }
    case 'abs':
      return Math.abs(expectNumber(evaluate(args[0]!, env), 'abs()'))
    case 'sin':
      return dmath.sin(expectNumber(evaluate(args[0]!, env), 'sin()'))
    case 'cos':
      return dmath.cos(expectNumber(evaluate(args[0]!, env), 'cos()'))
    case 'floor':
      return Math.floor(expectNumber(evaluate(args[0]!, env), 'floor()'))
    case 'random':
      return env.rand.uniform()
  }
}

/** A compiled expression: {@link evaluate} for one AST, without the walk. */
export type CompiledExpression = (env: EvalEnv) => number | string | boolean

/**
 * O-69 (R12): turn `ast` into nested closures once, so a rule evaluated for
 * every entity every tick does not re-dispatch on node kinds. Same results,
 * errors and short-circuiting as {@link evaluate}; no code is generated.
 */
export function compileExpression(ast: AstNode): CompiledExpression {
  switch (ast.kind) {
    case 'number':
    case 'string':
    case 'boolean': {
      const value = ast.value
      return () => value
    }
    case 'identifier':
      return ast.name === 'dt' ? (env) => env.dt : (env) => env.time
    case 'field': {
      const { component, field } = ast
      return (env) => {
        const value = env.resolveField(component, field)
        if (value === undefined) {
          throw new RuleEvalError(`Field "${component}.${field}" is not available on this entity`)
        }
        return value
      }
    }
    case 'unary': {
      const operand = compileExpression(ast.operand)
      if (ast.op === '!') return (env) => !toBoolean(operand(env))
      return (env) => -expectNumber(operand(env), 'unary "-"')
    }
    case 'logical': {
      const left = compileExpression(ast.left)
      const right = compileExpression(ast.right)
      return ast.op === '&&'
        ? (env) => toBoolean(left(env)) && toBoolean(right(env))
        : (env) => toBoolean(left(env)) || toBoolean(right(env))
    }
    case 'ternary': {
      const cond = compileExpression(ast.cond)
      const then = compileExpression(ast.then)
      const otherwise = compileExpression(ast.else)
      return (env) => (toBoolean(cond(env)) ? then(env) : otherwise(env))
    }
    case 'binary': {
      const left = compileExpression(ast.left)
      const right = compileExpression(ast.right)
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
      const args = ast.args.map(compileExpression)
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
      }
    }
  }
}
