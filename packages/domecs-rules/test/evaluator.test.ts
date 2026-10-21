import { describe, expect, it } from 'vitest'
import { createWorld, defineComponent, dmath, entry, type ComponentType } from '@domecs/core'
import { parseExpression } from '../src/parser.js'
import { compileExpression, evaluate, RuleEvalError, type EvalEnv } from '../src/evaluator.js'
import { installRules } from '../src/rules.js'

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

// O-75 / spec §4.2 test 3: rules evaluate sin()/cos() with dmath, so a rule's
// output is bit-identical on every engine (Math.sin/cos differ by <= 1 ulp
// between V8 builds).
describe('sin / cos are bit-reproducible (dmath)', () => {
  const Px = defineComponent<{ a: number; x: number; y: number }>('DmPx', {
    defaults: { a: 0, x: 0, y: 0 },
  })
  const types: ComponentType<any>[] = [Px]
  const resolve = (name: string): ComponentType<any> | undefined => types.find((t) => t.name === name)

  /** Inputs where V8 13.6 (Node 24) Math.sin / Math.cos differ from musl by 1 ulp. */
  const knownDiffering = [
    -3.952543023042381, 5.6727100582793355, 5.555683663114905, // sin
    2.4444008199498057, 0.7207945035770535, 4.211404654197395, // cos
  ]

  function seededAngles(count: number): number[] {
    let s = 0xa11ce >>> 0
    const next = (): number => {
      s = (s + 0x6d2b79f5) >>> 0
      let t = s
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 0x100000000
    }
    const out = [...knownDiffering]
    while (out.length < count) out.push((next() * 2 - 1) * (out.length % 3 === 0 ? 1e4 : 10))
    return out
  }

  it('installRules: x = sin(Px.a), y = cos(Px.a) equal dmath for 1000 seeded a', () => {
    const angles = seededAngles(1000)
    const w = createWorld({ headless: true })
    const ids = angles.map((a) => w.spawn([entry(Px, { a, x: 0, y: 0 })]))
    installRules(
      w,
      [
        {
          name: 'trig',
          schedule: 'tick',
          query: ['DmPx'],
          actions: [
            { set: 'DmPx.x', expr: 'sin(DmPx.a)' },
            { set: 'DmPx.y', expr: 'cos(DmPx.a)' },
          ],
        },
      ],
      resolve,
    )
    w.stepOnce()
    const wrong: string[] = []
    ids.forEach((id, i) => {
      const a = angles[i]!
      const p = w.getComponent(id, Px)!
      if (!Object.is(p.x, dmath.sin(a))) wrong.push(`sin(${a}) = ${p.x}, dmath ${dmath.sin(a)}`)
      if (!Object.is(p.y, dmath.cos(a))) wrong.push(`cos(${a}) = ${p.y}, dmath ${dmath.cos(a)}`)
    })
    expect(wrong.slice(0, 5)).toEqual([])
  })

  it('evaluate and compileExpression agree with dmath on the known differing inputs', () => {
    for (const a of knownDiffering) {
      const env: EvalEnv = {
        dt: 0,
        time: 0,
        rand: { uniform: () => 0 },
        resolveField: (c, f) => (c === 'P' && f === 'a' ? a : undefined),
      }
      for (const fn of ['sin', 'cos'] as const) {
        const parsed = parseExpression(`${fn}(P.a)`)
        if ('errors' in parsed) throw new Error('unexpected parse error')
        expect(evaluate(parsed.ast, env)).toBe(dmath[fn](a))
        expect(compileExpression(parsed.ast)(env)).toBe(dmath[fn](a))
      }
    }
  })
})
