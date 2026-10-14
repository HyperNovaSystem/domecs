import { describe, expect, it } from 'vitest'
import { Faulted, createWorld, defineComponent, entry, type ComponentType } from '@domecs/core'
import { compileRule, installRules, type RuleDef } from '../src/rules.js'

const Hp = defineComponent<{ hp: number }>('FtHp', { defaults: { hp: 10 } })
const Name = defineComponent<{ value: string }>('FtName', { defaults: { value: 'x' } })
const Loose = defineComponent<{ v?: number | string }>('FtLoose')

const types = new Map<string, ComponentType<any>>([Hp, Name, Loose].map((t) => [t.name, t]))
const resolve = (name: string) => types.get(name)

function rule(over: Partial<RuleDef>): RuleDef {
  return { name: 'r', schedule: 'tick', query: ['FtHp'], actions: [], ...over }
}

// O-68 (R4): rule failures are reported, not swallowed.
describe('rules — runtime failures become entity faults', () => {
  it('faults the entity it could not run on, and still runs the others', () => {
    const w = createWorld({ headless: true })
    installRules(w, [rule({
      name: 'heal',
      query: ['FtHp'],
      actions: [{ set: 'FtHp.hp', expr: 'FtHp.hp + FtLoose.v' }],
    })], resolve)
    const ok = w.spawn([entry(Hp, { hp: 1 }), entry(Loose, { v: 2 })])
    const bad = w.spawn([entry(Hp, { hp: 1 })]) // no FtLoose
    w.stepOnce()
    expect(w.getComponent(ok, Hp)!.hp).toBe(3)
    expect(w.getComponent(bad, Hp)!.hp).toBe(1)
    expect(w.has(ok, Faulted)).toBe(false)
    const faults = w.getComponent(bad, Faulted)!.faults
    expect(faults).toHaveLength(1)
    expect(faults[0]).toMatchObject({
      kind: 'rule_eval_failed',
      source: 'rule:heal',
      recoverable: true,
      detail: { rule: 'heal' },
    })
    expect(String((faults[0]!.detail as { message: string }).message)).toMatch(/FtLoose\.v/)
    // Failing again next tick collapses into the one entry.
    w.stepOnce()
    expect(w.getComponent(bad, Faulted)!.faults).toHaveLength(1)
  })

  it('a rejected write is a fault too', () => {
    const w = createWorld({ headless: true })
    installRules(w, [rule({ actions: [{ set: 'FtHp.hp', expr: 'FtHp.hp / 0' }] })], resolve)
    const id = w.spawn([entry(Hp, { hp: 1 })])
    w.stepOnce()
    expect(w.getComponent(id, Hp)!.hp).toBe(1)
    expect(w.getComponent(id, Faulted)!.faults[0]!.kind).toBe('rule_eval_failed')
  })

  it('an error that is not a rule failure propagates', () => {
    const w = createWorld({ headless: true })
    installRules(w, [rule({ actions: [{ set: 'FtHp.hp', expr: 'FtHp.hp + 1' }] })], resolve)
    const id = w.spawn([entry(Hp, { hp: 1 })])
    Object.defineProperty(w.getComponent(id, Hp)!, 'hp', {
      get() { throw new TypeError('getter bug') },
    })
    expect(() => w.stepOnce()).toThrow('getter bug')
  })
})

describe('rules — compile-time type errors', () => {
  it('rejects a literal of the wrong kind in arithmetic', () => {
    const r = compileRule(rule({ actions: [{ set: 'FtHp.hp', expr: 'FtHp.hp + "1"' }] }), resolve)
    expect(r.rule).toBeNull()
    expect(r.errors).toEqual([
      { rule: 'r', position: 10, message: 'Expected a number for "+", got string' },
    ])
    const r2 = compileRule(rule({ when: '-"a" > 0', actions: [] }), resolve)
    expect(r2.errors[0]).toMatchObject({ position: 1, message: 'Expected a number for unary "-", got string' })
    const r3 = compileRule(rule({ when: '(1 < 2) * 3 > 0', actions: [] }), resolve)
    expect(r3.errors[0]?.message).toBe('Expected a number for "*", got boolean')
  })

  it('accepts what may run fine: fields of any default, short-circuited and branch code, ==', () => {
    const ok = [
      'FtName.value + 1', // a field's kind is not fixed by its default
      'FtLoose.v',
      'FtHp.hp > 1 ? 1 : 2',
      'FtName.value == "num" || FtName.value + 1 > 0',
      'FtHp.hp > 0 ? FtHp.hp : "x" + 1',
    ]
    for (const expr of ok) {
      expect(compileRule(rule({ actions: [{ set: 'FtHp.hp', expr }] }), resolve).errors).toEqual([])
    }
    expect(compileRule(rule({ when: 'FtName.value == 3', actions: [] }), resolve).errors).toEqual([])
    expect(compileRule(rule({ actions: [{ set: 'FtHp.hp', expr: '"s"' }] }), resolve).errors).toEqual([])
  })
})

describe('rules — values errors cannot print (O-68 review)', () => {
  it('a BigInt field faults the entity instead of crashing the step', () => {
    const Bag = defineComponent<{ o: unknown }>('FtBag', { defaults: { o: null } })
    types.set(Bag.name, Bag)
    const w = createWorld({ headless: true })
    installRules(w, [rule({ actions: [{ set: 'FtHp.hp', expr: 'FtHp.hp + FtBag.o' }] })], resolve)
    const bad = w.spawn([entry(Hp, { hp: 1 }), entry(Bag, { o: 5n })])
    const good = w.spawn([entry(Hp, { hp: 1 }), entry(Bag, { o: 2 })])
    expect(() => w.stepOnce()).not.toThrow()
    expect(w.getComponent(good, Hp)!.hp).toBe(3)
    expect(w.getComponent(bad, Faulted)!.faults[0]!.kind).toBe('rule_eval_failed')
  })
})
