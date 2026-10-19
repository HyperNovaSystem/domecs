import { describe, expect, it } from 'vitest'
import {
  createRng,
  createWorld,
  defineComponent,
  deriveStream,
  entry,
  hashSnapshot,
  seedToState,
  type ComponentType,
  type World,
} from '@domecs/core'
import { compileRule, installRules, type InstallRulesOptions, type RuleDef } from '../src/index.js'

// §4.4 (G6; O-77): `rng: 'own'` gives a rule its own stream, so adding,
// removing or editing one rule does not change another rule's draws.

const A = defineComponent<{ v: number }>('RngA', { defaults: { v: 0 } })
const B = defineComponent<{ v: number }>('RngB', { defaults: { v: 0 } })
const resolve = (n: string): ComponentType<any> | undefined => (n === 'RngA' ? A : n === 'RngB' ? B : undefined)
const ruleA: RuleDef = { name: 'A', schedule: 'tick', query: ['RngA'], actions: [{ set: 'RngA.v', expr: 'random()' }] }
const ruleB: RuleDef = { name: 'B', schedule: 'tick', query: ['RngB'], actions: [{ set: 'RngB.v', expr: 'random()' }] }

/** Run 10 ticks and return rule B's value after each. */
function bValues(defs: RuleDef[], options: InstallRulesOptions, update = false): number[] {
  const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
  w.spawn([entry(A, { v: 0 })])
  const b = w.spawn([entry(B, { v: 0 })])
  const h = installRules(w, defs, resolve, options)
  const out: number[] = []
  for (let i = 0; i < 10; i++) {
    if (update) h.update(defs)
    w.stepOnce()
    out.push(w.getComponent(b, B)!.v)
  }
  return out
}

describe('rules — rng option (§4.4)', () => {
  it("1: the probe — B's draws are unchanged by A under 'own', changed under 'shared'", () => {
    const sharedWith = bValues([ruleA, ruleB], {})
    const sharedWithout = bValues([ruleB], {})
    expect(sharedWith).not.toEqual(sharedWithout) // red baseline: one shared stream
    const ownWith = bValues([ruleA, ruleB], { rng: 'own' })
    const ownWithout = bValues([ruleB], { rng: 'own' })
    expect(ownWith).toEqual(ownWithout)
    const stream = createRng(deriveStream(seedToState([1, 2, 3, 4]), 'rule:B'))
    expect(ownWith).toEqual(Array.from({ length: 10 }, () => stream.uniform()))
  })

  it('2: update(defs) every tick leaves own sequences unchanged', () => {
    expect(bValues([ruleA, ruleB], { rng: 'own' }, true)).toEqual(bValues([ruleA, ruleB], { rng: 'own' }))
  })

  it("RuleDef.rng overrides the install default; describe() reports each rule's mode", () => {
    const w = createWorld({ headless: true })
    installRules(w, [{ ...ruleA, rng: 'shared' }, ruleB], resolve, { rng: 'own' })
    const modes = new Map(w.describe().systems.map((s) => [s.name, s.rng]))
    expect(modes.get('rule:A')).toBe('shared')
    expect(modes.get('rule:B')).toBe('own')
    const w2 = createWorld({ headless: true })
    installRules(w2, [{ ...ruleA, rng: 'own' }, ruleB], resolve)
    const modes2 = new Map(w2.describe().systems.map((s) => [s.name, s.rng]))
    expect(modes2.get('rule:A')).toBe('own')
    expect(modes2.get('rule:B')).toBe('shared')
    // the per-rule override is what decides B's draws
    expect(bValues([ruleA, { ...ruleB, rng: 'own' }], {})).toEqual(bValues([{ ...ruleB, rng: 'own' }], {}))
  })

  it("switching a rule's mode keeps live and fork equal (strict hash)", () => {
    const build = (): World => {
      const w = createWorld({ headless: true, seed: 3 })
      w.spawn([entry(A, { v: 0 })])
      w.spawn([entry(B, { v: 0 })])
      return w
    }
    const live = build()
    const h = installRules(live, [ruleA, ruleB], resolve, { rng: 'own' })
    for (let i = 0; i < 10; i++) live.stepOnce()
    h.update([ruleA, { ...ruleB, rng: 'shared' }])
    for (let i = 0; i < 10; i++) live.stepOnce()
    const snap = live.snapshot({ pendingEvents: true })
    const fork = build()
    installRules(fork, [ruleA, { ...ruleB, rng: 'shared' }], resolve, { rng: 'own' })
    fork.restore(snap)
    const strict = (w: World): string => hashSnapshot(w.snapshot({ pendingEvents: true }), { includeChanges: true })
    for (let i = 0; i < 50; i++) {
      live.stepOnce()
      fork.stepOnce()
      expect(strict(fork)).toBe(strict(live))
    }
  })

  it("an unknown RuleDef.rng is a RuleError on field 'rng'", () => {
    const r = compileRule({ ...ruleA, rng: 'mine' as 'own' }, resolve)
    expect(r.rule).toBeNull()
    expect(r.errors).toEqual([
      { rule: 'A', position: -1, message: 'Unknown rng "mine" (expected "shared" or "own")', field: 'rng' },
    ])
    const w = createWorld({ headless: true })
    const errors = installRules(w, [{ ...ruleA, rng: 'mine' as 'own' }], resolve).update([{ ...ruleA, rng: 'mine' as 'own' }])
    expect(errors.get('A')?.[0]?.field).toBe('rng')
  })

  it('an unknown InstallRulesOptions.rng throws at installRules', () => {
    const w = createWorld({ headless: true })
    expect(() => installRules(w, [ruleA], resolve, { rng: 'mine' as 'own' })).toThrow(/rng must be 'shared' or 'own'/)
    expect(w.describe().systems.some((s) => s.name === 'rule:A')).toBe(false)
  })
})
