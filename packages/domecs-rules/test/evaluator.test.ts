import { describe, expect, it } from 'vitest'
import { parseExpression } from '../src/parser.js'
import { evaluate, RuleEvalError, type EvalEnv } from '../src/evaluator.js'

function evalExpr(source: string, env: Partial<EvalEnv> = {}): number | string | boolean {
  const parsed = parseExpression(source)
  if ('errors' in parsed) {
    throw new Error(`expected ${source} to parse: ${JSON.stringify(parsed.errors)}`)
  }
  const fullEnv: EvalEnv = {
    dt: 0,
    time: 0,
    rand: { uniform: () => 0 },
    resolveField: () => undefined,
    ...env,
  }
  return evaluate(parsed.ast, fullEnv)
}

describe('evaluate — literals and identifiers', () => {
  it('evaluates number/string/boolean literals', () => {
    expect(evalExpr('42')).toBe(42)
    expect(evalExpr('"hi"')).toBe('hi')
    expect(evalExpr('true')).toBe(true)
    expect(evalExpr('false')).toBe(false)
  })

  it('reads dt and time from the env', () => {
    expect(evalExpr('dt', { dt: 0.5 })).toBe(0.5)
    expect(evalExpr('time', { time: 12.25 })).toBe(12.25)
  })

  it('resolves Component.field via env.resolveField', () => {
    const value = evalExpr('Health.hp', {
      resolveField: (c, f) => (c === 'Health' && f === 'hp' ? 7 : undefined),
    })
    expect(value).toBe(7)
  })

  it('throws RuleEvalError when a field is not available on the entity', () => {
    expect(() => evalExpr('Health.hp', { resolveField: () => undefined })).toThrow(RuleEvalError)
  })
})

describe('evaluate — arithmetic and comparisons', () => {
  it('computes + - * / %', () => {
    expect(evalExpr('1 + 2')).toBe(3)
    expect(evalExpr('5 - 2')).toBe(3)
    expect(evalExpr('3 * 4')).toBe(12)
    expect(evalExpr('7 / 2')).toBe(3.5)
    expect(evalExpr('7 % 2')).toBe(1)
  })

  it('computes comparisons', () => {
    expect(evalExpr('1 < 2')).toBe(true)
    expect(evalExpr('2 <= 2')).toBe(true)
    expect(evalExpr('3 > 2')).toBe(true)
    expect(evalExpr('2 >= 3')).toBe(false)
    expect(evalExpr('2 == 2')).toBe(true)
    expect(evalExpr('2 != 3')).toBe(true)
  })

  it('== / != work across types without coercion', () => {
    expect(evalExpr('1 == "1"')).toBe(false)
    expect(evalExpr('1 != "1"')).toBe(true)
    expect(evalExpr('"a" == "a"')).toBe(true)
    expect(evalExpr('true == true')).toBe(true)
  })

  it('throws when a non-number reaches an arithmetic operator', () => {
    expect(() => evalExpr('"a" + 1')).toThrow(RuleEvalError)
  })
})

describe('evaluate — boolean logic, unary, ternary', () => {
  it('evaluates && / || / !', () => {
    expect(evalExpr('true && false')).toBe(false)
    expect(evalExpr('true || false')).toBe(true)
    expect(evalExpr('!true')).toBe(false)
    expect(evalExpr('!false')).toBe(true)
  })

  it('evaluates unary minus', () => {
    expect(evalExpr('-5')).toBe(-5)
    expect(evalExpr('-(2 + 3)')).toBe(-5)
  })

  it('evaluates the ternary operator', () => {
    expect(evalExpr('true ? 1 : 2')).toBe(1)
    expect(evalExpr('false ? 1 : 2')).toBe(2)
  })

  it('short-circuits && so the right side is not evaluated when the left is false', () => {
    let touched = false
    evalExpr('false && Missing.field', {
      resolveField: () => {
        touched = true
        return undefined
      },
    })
    expect(touched).toBe(false)
  })

  it('short-circuits || so the right side is not evaluated when the left is true', () => {
    let touched = false
    evalExpr('true || Missing.field', {
      resolveField: () => {
        touched = true
        return undefined
      },
    })
    expect(touched).toBe(false)
  })

  it('ternary only evaluates the taken branch', () => {
    let touched = false
    evalExpr('true ? 1 : Missing.field', {
      resolveField: () => {
        touched = true
        return undefined
      },
    })
    expect(touched).toBe(false)
  })
})

describe('evaluate — whitelisted functions', () => {
  it('min / max', () => {
    expect(evalExpr('min(3, 5)')).toBe(3)
    expect(evalExpr('max(3, 5)')).toBe(5)
  })

  it('clamp: below range', () => {
    expect(evalExpr('clamp(-5, 0, 10)')).toBe(0)
  })

  it('clamp: within range', () => {
    expect(evalExpr('clamp(5, 0, 10)')).toBe(5)
  })

  it('clamp: above range', () => {
    expect(evalExpr('clamp(50, 0, 10)')).toBe(10)
  })

  it('abs / floor', () => {
    expect(evalExpr('abs(-3.5)')).toBe(3.5)
    expect(evalExpr('floor(3.9)')).toBe(3)
  })

  it('sin / cos', () => {
    expect(evalExpr('sin(0)')).toBe(0)
    expect(evalExpr('cos(0)')).toBe(1)
  })

  it('random() delegates to env.rand.uniform()', () => {
    expect(evalExpr('random()', { rand: { uniform: () => 0.42 } })).toBe(0.42)
  })
})

describe('evaluate — dt-scaled accumulation across simulated ticks', () => {
  it('Health.hp - dt * 1 decrements hp by dt each simulated tick', () => {
    const parsed = parseExpression('Health.hp - dt * 1')
    if ('errors' in parsed) throw new Error('unexpected parse error')

    let hp = 10
    const dt = 0.5
    for (let tick = 0; tick < 4; tick++) {
      const env: EvalEnv = {
        dt,
        time: dt * (tick + 1),
        rand: { uniform: () => 0 },
        resolveField: (c, f) => (c === 'Health' && f === 'hp' ? hp : undefined),
      }
      hp = evaluate(parsed.ast, env) as number
    }
    expect(hp).toBe(10 - 0.5 * 4)
  })
})
