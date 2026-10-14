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
  it('rejects arithmetic on a field whose default is a string', () => {
    const r = compileRule(rule({ actions: [{ set: 'FtHp.hp', expr: 'FtName.value + 1' }] }), resolve)
    expect(r.rule).toBeNull()
    expect(r.errors).toEqual([
      { rule: 'r', position: 0, message: 'Expected a number for "+", got string' },
    ])
  })

  it('rejects a write of the wrong kind to a field with a default', () => {
    const r = compileRule(rule({ actions: [{ set: 'FtHp.hp', expr: 'FtHp.hp > 1' }] }), resolve)
    expect(r.errors[0]?.message).toBe('Cannot set FtHp.hp: expected a number, got boolean')
    const r2 = compileRule(rule({ when: '-"a" > 0', actions: [] }), resolve)
    expect(r2.errors[0]).toMatchObject({ position: 1, message: 'Expected a number for unary "-", got string' })
  })

  it('accepts what it cannot know: fields without defaults, mixed ternaries, ==', () => {
    for (const expr of ['FtLoose.v', 'FtHp.hp > 1 ? 1 : 2', 'FtLoose.v + 1']) {
      expect(compileRule(rule({ actions: [{ set: 'FtHp.hp', expr }] }), resolve).errors).toEqual([])
    }
    expect(compileRule(rule({ when: 'FtName.value == 3', actions: [] }), resolve).errors).toEqual([])
    expect(compileRule(rule({ actions: [{ set: 'FtLoose.v', expr: '"s"' }] }), resolve).errors).toEqual([])
  })
})
