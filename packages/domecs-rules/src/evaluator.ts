import type { AstNode, FunctionName } from './ast.js'

/**
 * Everything `evaluate` needs, without importing "@domecs/core" — the AST /
 * parser / evaluator stay pure and world-agnostic. The world-facing wiring
 * (resolving `Component.field` against a real `World`) lives in rules.ts.
 */
export interface EvalEnv {
  /**
   * Resolve a `Component.field` reference. Return `undefined` when the
   * component is not registered/known, when the entity currently being
   * evaluated does not have that component, or when the component instance
   * has no such field. `evaluate` treats any of those uniformly: it throws
   * a {@link RuleEvalError} (see the class doc for the documented
   * skip-this-entity contract callers must implement).
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
 * Thrown by `evaluate` when it cannot produce a value — currently only for
 * an unresolvable `Component.field` reference (missing component or missing
 * field on the entity being evaluated), and for a value of the wrong type
 * reaching an operator/function that requires a specific type (e.g. `+` on
 * a boolean).
 *
 * **Documented contract (per M6 spec):** this is a per-entity-per-tick
 * condition, not a systemic one. `evaluate` itself does not know about
 * entities or ticks — it just throws. The caller (`compileRule` /
 * `installRules` in rules.ts) is responsible for catching `RuleEvalError`
 * (and any other error `evaluate` might throw) **per entity**, treating it
 * as "this entity does not satisfy `when`" (skip-this-entity), and
 * continuing on to the next entity in the query. One bad entity must never
 * stop the rest of the query from being processed that tick.
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
    throw new RuleEvalError(`Expected a number for ${context}, got ${typeof value} (${JSON.stringify(value)})`)
  }
  return value
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
      return Math.sin(expectNumber(evaluate(args[0]!, env), 'sin()'))
    case 'cos':
      return Math.cos(expectNumber(evaluate(args[0]!, env), 'cos()'))
    case 'floor':
      return Math.floor(expectNumber(evaluate(args[0]!, env), 'floor()'))
    case 'random':
      return env.rand.uniform()
  }
}
