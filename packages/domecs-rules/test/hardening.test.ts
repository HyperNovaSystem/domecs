import { describe, expect, it } from 'vitest'
import { OnChanged, createWorld, defineComponent, entry, type ComponentType } from '@domecs/core'
import { MAX_EXPRESSION_DEPTH, MAX_EXPRESSION_LENGTH, parseExpression } from '../src/parser.js'
import { compileRule, installRules, type RuleDef } from '../src/rules.js'

// 2026-10-13 engine review R1 (O-66), R2/R5 (O-67), R3 (O-68), R9 (O-69):
// rule data cannot overflow the stack or reach prototypes, writes are
// checked and atomic, and unchanged writes do not mark.

const Health = defineComponent<{ hp: number }>('RhHealth', { defaults: { hp: 10 } })
const Vel = defineComponent<{ x: number; y: number }>('RhVel', { defaults: { x: 0, y: 0 } })
const Flag = defineComponent<{ on: boolean }>('RhFlag', { defaults: { on: false } })

const types: ComponentType<any>[] = [Health, Vel, Flag]
const resolve = (name: string): ComponentType<any> | undefined => types.find((t) => t.name === name)

function rule(actions: RuleDef['actions'], extra: Partial<RuleDef> = {}): RuleDef {
  return { name: 'r', schedule: 'tick', query: ['RhHealth'], actions, ...extra }
}

describe('O-66: expression limits', () => {
  const cases: Array<[string, string]> = [
    ['deep parentheses', '('.repeat(4000) + '1' + ')'.repeat(4000)],
    ['many unary minuses', '-'.repeat(15000) + '1'],
    ['a long flat sum', Array.from({ length: 6000 }, () => '1').join(' + ')],
    ['nested ternaries', 'true ? '.repeat(3000) + '1' + ' : 0'.repeat(3000)],
    ['an over-long source', '1'.repeat(MAX_EXPRESSION_LENGTH + 1)],
  ]
  for (const [label, src] of cases) {
    it(`reports ${label} as a ParseError`, () => {
      const r = parseExpression(src)
      expect('errors' in r).toBe(true)
    })
  }

  it('accepts nesting up to the limit', () => {
    const depth = MAX_EXPRESSION_DEPTH - 2
    const r = parseExpression('('.repeat(depth) + '1' + ')'.repeat(depth))
    expect('ast' in r).toBe(true)
  })

  it('update() with an over-deep rule returns an error and keeps going', () => {
    const w = createWorld({ headless: true })
    const deep = '('.repeat(4000) + '1' + ')'.repeat(4000)
    const h = installRules(w, [], resolve)
    const errs = h.update([rule([{ set: 'RhHealth.hp', expr: deep }], { name: 'deep' }), rule([], { name: 'ok' })])
    expect(errs.has('deep')).toBe(true)
    expect(errs.has('ok')).toBe(false)
  })
})

describe('O-67: reads and writes', () => {
  it('rejects prototype field names at compile time', () => {
    for (const def of [
      rule([{ set: 'RhHealth.__proto__', expr: '1' }]),
      rule([{ set: 'RhHealth.hp', expr: 'RhHealth.constructor ? 1 : 0' }]),
      rule([], { when: 'RhHealth.prototype' }),
    ]) {
      expect(compileRule(def, resolve).rule).toBeNull()
    }
  })

  function run(actions: RuleDef['actions'], hp = 10): { hp: number; extra: unknown } {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Health, { hp })])
    installRules(w, [rule(actions)], resolve)
    w.stepOnce()
    const h = w.getComponent(id, Health)! as { hp: number } & Record<string, unknown>
    return { hp: h.hp, extra: h.hpp }
  }

  it('does not write a boolean into a number field', () => {
    expect(run([{ set: 'RhHealth.hp', expr: 'RhHealth.hp || 5' }]).hp).toBe(10)
  })

  it('does not add a field on a typo', () => {
    expect(run([{ set: 'RhHealth.hpp', expr: '1' }]).extra).toBeUndefined()
  })

  it('does not write a non-finite number', () => {
    expect(run([{ set: 'RhHealth.hp', expr: 'RhHealth.hp / 0' }]).hp).toBe(10)
  })

  it('still writes a valid value', () => {
    expect(run([{ set: 'RhHealth.hp', expr: 'RhHealth.hp - 1' }]).hp).toBe(9)
  })
})

describe('O-68: actions are atomic', () => {
  it('a failing later action leaves earlier writes undone', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Health, { hp: 10 })])
    installRules(
      w,
      [
        rule([
          { set: 'RhHealth.hp', expr: 'RhHealth.hp - 1' },
          { set: 'RhHealth.hp', expr: 'RhFlag.on ? 0 : RhHealth.hp' },
        ]),
      ],
      resolve,
    )
    w.stepOnce()
    expect(w.getComponent(id, Health)!.hp).toBe(10)
  })

  it('actions apply in order: later actions read earlier writes', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Health, { hp: 10 })])
    installRules(
      w,
      [
        rule([
          { set: 'RhHealth.hp', expr: '100' },
          { set: 'RhHealth.hp', expr: 'RhHealth.hp - 1' },
        ]),
      ],
      resolve,
    )
    w.stepOnce()
    expect(w.getComponent(id, Health)!.hp).toBe(99)
  })

  it('a field set back to its value by a later action does not mark', () => {
    const w = createWorld({ headless: true })
    w.spawn([entry(Health, { hp: 10 })])
    let fired = 0
    w.system('watch', { schedule: 'reactive', reactsTo: OnChanged(Health) }, () => void fired++)
    installRules(
      w,
      [
        rule([
          { set: 'RhHealth.hp', expr: '5' },
          { set: 'RhHealth.hp', expr: 'RhHealth.hp + 5' },
        ]),
      ],
      resolve,
    )
    for (let i = 0; i < 3; i++) w.stepOnce()
    expect(fired).toBe(0)
  })
})

describe('R9: unchanged writes do not mark', () => {
  it('a clamp at rest does not fire OnChanged', () => {
    const w = createWorld({ headless: true })
    w.spawn([entry(Health, { hp: 0 })])
    let fired = 0
    w.system('watch', { schedule: 'reactive', reactsTo: OnChanged(Health) }, () => void fired++)
    installRules(w, [rule([{ set: 'RhHealth.hp', expr: 'max(RhHealth.hp, 0)' }])], resolve)
    for (let i = 0; i < 5; i++) w.stepOnce()
    expect(fired).toBe(0)
  })
})

describe('review follow-ups', () => {
  const Opt = defineComponent<{ x: number; t: number | null }>('RhOpt', { defaults: { x: 1, t: null } })
  const resolve2 = (name: string): ComponentType<any> | undefined =>
    [...types, Opt].find((t) => t.name === name)

  it('a null field accepts a number', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Opt, { x: 1, t: null })])
    installRules(
      w,
      [{ name: 'n', schedule: 'tick', query: ['RhOpt'], actions: [{ set: 'RhOpt.t', expr: '5' }, { set: 'RhOpt.x', expr: '2' }] }],
      resolve2,
    )
    w.stepOnce()
    expect(w.getComponent(id, Opt)).toEqual({ x: 2, t: 5 })
  })

  it('a missing target component skips the whole entity', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Opt, { x: 1, t: null })])
    installRules(
      w,
      [{ name: 'm', schedule: 'tick', query: ['RhOpt'], actions: [{ set: 'RhOpt.x', expr: '2' }, { set: 'RhVel.y', expr: '3' }] }],
      resolve2,
    )
    w.stepOnce()
    expect(w.getComponent(id, Opt)!.x).toBe(1)
  })

  it('mixed unary and parentheses parse up to the AST limit', () => {
    const n = Math.floor((MAX_EXPRESSION_DEPTH - 2) / 2)
    expect('ast' in parseExpression('-('.repeat(n) + '1' + ')'.repeat(n))).toBe(true)
  })
})
