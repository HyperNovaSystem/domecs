import { describe, expect, it } from 'vitest'
import { compileExpression, evaluate, type EvalEnv } from '../src/evaluator.js'
import { parseExpression } from '../src/parser.js'

// O-69 (R12): compiled closures behave exactly like the tree walker.
describe('compileExpression matches evaluate', () => {
  const exprs = [
    '1 + 2 * 3 - 4 / 2 % 3', 'A.x > 2 && A.s == "hi"', 'A.x < 0 || A.b', '!A.b', '-A.x',
    'A.x >= 3 ? "big" : "small"', 'min(A.x, 7) + max(1, 2) + clamp(A.x, 0, 1)', 'abs(-3) + floor(2.7)',
    'sin(A.x) + cos(A.x)', 'dt * 2 + time', 'random() + random()', 'A.missing + 1', 'A.s + 1',
    'false && A.missing', 'true || A.missing', 'A.b ? A.missing : 0', 'A.x != 3', '-A.s',
  ]
  const fields: Record<string, number | string | boolean> = { x: 3, s: 'hi', b: true }
  function env(): EvalEnv & { draws: number } {
    let seed = 1
    const e = {
      dt: 0.5,
      time: 10,
      draws: 0,
      rand: { uniform: () => { e.draws++; seed = (seed * 16807) % 2147483647; return seed / 2147483647 } },
      resolveField: (c: string, f: string) => (c === 'A' ? fields[f] : undefined),
    }
    return e
  }
  const run = (fn: (e: EvalEnv) => unknown, e: EvalEnv): unknown => {
    try {
      return { ok: fn(e) }
    } catch (err) {
      return { err: String(err) }
    }
  }
  for (const src of exprs) {
    it(src, () => {
      const parsed = parseExpression(src)
      if ('errors' in parsed) throw new Error(JSON.stringify(parsed.errors))
      const a = env()
      const b = env()
      expect(run(compileExpression(parsed.ast), b)).toEqual(run((e) => evaluate(parsed.ast, e), a))
      expect(b.draws).toBe(a.draws)
    })
  }
})
