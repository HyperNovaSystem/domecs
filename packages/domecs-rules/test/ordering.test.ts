import { describe, expect, it } from 'vitest'
import { createWorld, defineComponent, entry, hashSnapshot, type ComponentType, type World } from '@domecs/core'
import { compileRule, installRules, parseExpression, type RuleDef } from '../src/index.js'

const Log = defineComponent<{ s: string }>('OrLog', { defaults: { s: '' } })
const resolve = (n: string): ComponentType<any> | undefined => (n === 'OrLog' ? Log : undefined)
const append = (name: string, ch: string, priority?: number): RuleDef => ({
  name, schedule: 'tick', query: ['OrLog'], actions: [{ set: 'OrLog.s', expr: `"${ch}"` }],
  ...(priority !== undefined ? { priority } : {}),
})

// O-69: ordering and validation.
describe('rules — ordering and validation (O-69)', () => {
  it('runs equal-priority rules in defs order and honours priority (R6)', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Log, { s: '' })])
    const h = installRules(w, [append('a', 'A'), append('b', 'B')], resolve)
    w.stepOnce()
    expect(w.getComponent(id, Log)!.s).toBe('B') // b ran last
    h.update([append('b', 'B'), append('a', 'A')])
    w.stepOnce()
    expect(w.getComponent(id, Log)!.s).toBe('A')
    h.update([append('b', 'B', -1), append('a', 'A', -2)])
    w.stepOnce()
    expect(w.getComponent(id, Log)!.s).toBe('B') // a (-2) then b (-1)
  })

  it('reports an unknown schedule and a duplicate name (R7, R8)', () => {
    const bad = compileRule({ ...append('x', 'X'), schedule: 'frame' as 'tick' }, resolve)
    expect(bad.errors[0]?.message).toMatch(/Unknown schedule "frame"/)
    const w = createWorld({ headless: true })
    const errors = installRules(w, [], resolve).update([append('d', 'A'), append('d', 'B')])
    expect(errors.get('d')?.[0]?.message).toMatch(/Duplicate rule name "d"/)
    expect(w.describe().systems.filter((s) => s.name === 'rule:d')).toHaveLength(1)
  })

  it('rejects over-long literals and unknown escapes (R11)', () => {
    expect(parseExpression('1' + '0'.repeat(400))).toEqual({ errors: [{ position: 0, message: 'Number literal out of range' }] })
    expect(parseExpression('"a\\qb"')).toEqual({ errors: [{ position: 2, message: 'Unknown escape "\\q"' }] })
  })
})

// E3.2 (§4.3; O-76): installRules(…, { order: 'stable', orderBase }).
const P = defineComponent<{ x: number }>('OrdP', { defaults: { x: 0 } })
const W = defineComponent<{ x: number }>('OrdW', { defaults: { x: 0 } })
const N = defineComponent<{ v: number }>('OrdN', { defaults: { v: 0 } })
const byName: Record<string, ComponentType<any>> = { OrdP: P, OrdW: W, OrdN: N }
const resolveOrd = (n: string): ComponentType<any> | undefined => byName[n]
const strict = (w: World): string => hashSnapshot(w.snapshot(), { includeChanges: true })

/** Rule `k`: N.v = N.v * 10 + k, so after one tick N.v spells the run order. */
const digit = (name: string, k: number, extra: Partial<RuleDef> = {}): RuleDef => ({
  name, schedule: 'tick', query: ['OrdN'], actions: [{ set: 'OrdN.v', expr: `OrdN.v * 10 + ${k}` }], ...extra,
})
/** A priority-0, order-0 non-rule system that appends digit 9. */
function nine(w: World): void {
  w.system('nine', { query: [N] }, (ctx) => {
    for (const e of ctx.entities) {
      ;(e as unknown as { OrdN: { v: number } }).OrdN.v = (e as unknown as { OrdN: { v: number } }).OrdN.v * 10 + 9
      w.markChanged(e.id, N)
    }
  })
}
const ruleSystems = (w: World) => w.describe().systems.filter((s) => s.name.startsWith('rule:'))
function runOnce(w: World, id: number): number {
  w.getComponent(id, N)!.v = 0
  w.markChanged(id, N)
  w.stepOnce()
  return w.getComponent(id, N)!.v
}

describe('rules — stable ordering option (E3.2)', () => {
  // The critic probe (order2.mjs): one tick rule P.x += 1 and one priority-0
  // copy system W.x = P.x registered after it.
  const probeDefs: RuleDef[] = [
    { name: 'inc', schedule: 'tick', query: ['OrdP'], actions: [{ set: 'OrdP.x', expr: 'OrdP.x + 1' }] },
  ]
  function probe(order: 'registration' | 'stable', noopUpdate: boolean): World {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    w.spawn([entry(P, { x: 0 }), entry(W, { x: 0 })])
    const h = installRules(w, probeDefs, resolveOrd, { order })
    w.system('copy', { query: [P, W] }, (ctx) => {
      for (const e of ctx.entities) {
        const v = e as unknown as { OrdP: { x: number }; OrdW: { x: number } }
        v.OrdW.x = v.OrdP.x
        w.markChanged(e.id, W)
      }
    })
    if (noopUpdate) h.update(probeDefs)
    for (let i = 0; i < 5; i++) w.stepOnce()
    return w
  }

  it("critic probe: 'registration' differs after a no-op update (documents the hazard)", () => {
    const fresh = probe('registration', false)
    const updated = probe('registration', true)
    const [fp] = fresh.listEntities([P])
    const [up] = updated.listEntities([P])
    expect([fresh.getComponent(fp!, P)!.x, fresh.getComponent(fp!, W)!.x]).toEqual([5, 5])
    expect([updated.getComponent(up!, P)!.x, updated.getComponent(up!, W)!.x]).toEqual([5, 4])
    expect(strict(updated)).not.toBe(strict(fresh))
  })

  it("critic probe: 'stable' gives equal strict hashes after a no-op update", () => {
    expect(strict(probe('stable', true))).toBe(strict(probe('stable', false)))
  })

  it('reordering defs via update reorders runs; non-rule order-0 systems run first', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(N, { v: 0 })])
    const h = installRules(w, [digit('a', 1), digit('b', 2)], resolveOrd, { order: 'stable' })
    nine(w)
    expect(runOnce(w, id)).toBe(912)
    h.update([digit('b', 2), digit('a', 1)])
    expect(runOnce(w, id)).toBe(921)
  })

  it('a rule added later sits at its defs index, not at the end', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(N, { v: 0 })])
    const h = installRules(w, [digit('a', 1), digit('c', 3)], resolveOrd, { order: 'stable' })
    expect(runOnce(w, id)).toBe(13)
    h.update([digit('a', 1), digit('b', 2), digit('c', 3)])
    expect(runOnce(w, id)).toBe(123)
    h.update([digit('b', 2), digit('a', 1), digit('c', 3)])
    expect(runOnce(w, id)).toBe(213)
  })

  it('rule i registers with order orderBase + i in the de-duplicated defs', () => {
    const w = createWorld({ headless: true })
    const bad: RuleDef = { name: 'bad', schedule: 'tick', query: ['Nope'], actions: [] }
    const errors = installRules(w, [digit('a', 1), digit('a', 5), bad, digit('c', 3)], resolveOrd, {
      order: 'stable',
      orderBase: 10,
    }).update([digit('a', 1), digit('a', 5), bad, digit('c', 3)])
    expect(errors.get('a')?.[0]?.message).toMatch(/Duplicate/)
    expect(errors.has('bad')).toBe(true)
    const orders = Object.fromEntries(ruleSystems(w).map((s) => [s.name, s.order]))
    // The duplicate takes no index; a def that fails to compile keeps its
    // slot, so fixing it later does not shift the rules after it.
    expect(orders).toEqual({ 'rule:a': 10, 'rule:c': 12 })
  })

  it('orderBase defaults to 1; a negative orderBase runs rules before order-0 systems', () => {
    const w1 = createWorld({ headless: true })
    installRules(w1, [digit('a', 1)], resolveOrd, { order: 'stable' })
    expect(w1.describe().systems.find((s) => s.name === 'rule:a')!.order).toBe(1)

    const w2 = createWorld({ headless: true })
    const id = w2.spawn([entry(N, { v: 0 })])
    nine(w2)
    installRules(w2, [digit('a', 1), digit('b', 2)], resolveOrd, { order: 'stable', orderBase: -10 })
    expect(runOnce(w2, id)).toBe(129)
  })

  it("'registration' (the default) registers rules with order 0", () => {
    const w = createWorld({ headless: true })
    installRules(w, [digit('a', 1), digit('b', 2)], resolveOrd)
    expect(ruleSystems(w).map((s) => s.order)).toEqual([0, 0])
  })

  it('rejects an unknown order mode and a non-finite orderBase', () => {
    const w = createWorld({ headless: true })
    expect(() => installRules(w, [], resolveOrd, { order: 'fifo' as 'stable' })).toThrow(/order/)
    expect(() => installRules(w, [], resolveOrd, { order: 'stable', orderBase: NaN })).toThrow(/orderBase/)
    expect(() => installRules(w, [], resolveOrd, { order: 'stable', orderBase: Infinity })).toThrow(/orderBase/)
  })

  // fix(E3): orderBase + i must stay exact, or two rules share an order key
  // and tie-break by registration index again (the O-76 hazard, silently).
  it('rejects an orderBase so large that orderBase + i would collide', () => {
    const w = createWorld({ headless: true })
    const defs = [digit('a', 1), digit('b', 2), digit('c', 3)]
    // MAX_SAFE_INTEGER + 1 === MAX_SAFE_INTEGER + 2 in doubles.
    expect(() => installRules(w, defs, resolveOrd, { order: 'stable', orderBase: Number.MAX_SAFE_INTEGER })).toThrow(/orderBase/)
    expect(() => installRules(w, defs, resolveOrd, { order: 'stable', orderBase: -(2 ** 53) })).toThrow(/orderBase/)
    expect(ruleSystems(w)).toHaveLength(0)
  })

  it('accepts orderBase up to ±2^51 with distinct, increasing keys', () => {
    for (const orderBase of [2 ** 51, -(2 ** 51), 2 ** 51 - 0.5]) {
      const w = createWorld({ headless: true })
      installRules(w, [digit('a', 1), digit('b', 2), digit('c', 3), digit('d', 4)], resolveOrd, { order: 'stable', orderBase })
      const keys = ruleSystems(w).map((s) => s.order)
      for (let i = 1; i < keys.length; i++) expect(keys[i]!).toBeGreaterThan(keys[i - 1]!)
    }
  })

  describe('fork contract: live world after updates == fresh build restored', () => {
    const fixedHalf: RuleDef = {
      name: 'half', schedule: 'fixed', query: ['OrdP'], actions: [{ set: 'OrdP.x', expr: 'OrdP.x * 0.5 + 1' }],
    }
    const jitter: RuleDef = {
      name: 'jitter', schedule: 'tick', query: ['OrdP'], actions: [{ set: 'OrdP.x', expr: 'OrdP.x + random()' }],
    }
    const mix: RuleDef = {
      name: 'mix', schedule: 'tick', query: ['OrdP', 'OrdN'], actions: [{ set: 'OrdN.v', expr: 'OrdN.v * 0.75 - OrdP.x' }],
    }
    const scale: RuleDef = {
      name: 'scale', schedule: 'tick', query: ['OrdP'], actions: [{ set: 'OrdP.x', expr: 'OrdP.x * 1.5 - random()' }],
    }
    const versions: RuleDef[][] = [
      [jitter, fixedHalf],
      [mix, jitter, fixedHalf, scale],
      [scale, mix, fixedHalf],
      [fixedHalf, jitter, scale, mix],
    ]

    function build(order: 'registration' | 'stable', defs: RuleDef[]) {
      const w = createWorld({ headless: true, seed: [9, 8, 7, 6] })
      for (let i = 0; i < 3; i++) w.spawn([entry(P, { x: i }), entry(W, { x: 0 }), entry(N, { v: i * 2 })])
      const h = installRules(w, defs, resolveOrd, { order })
      // A priority-0 user system in the rule band, registered after the rules.
      w.system('nudge', { query: [P] }, (ctx) => {
        for (const e of ctx.entities) {
          const v = e as unknown as { OrdP: { x: number } }
          v.OrdP.x = v.OrdP.x * 0.9 + ctx.rand.uniform()
          w.markChanged(e.id, P)
        }
      })
      // Stand-in for composeTransforms({ priority: 100 }).
      w.system('compose', { priority: 100, query: [P, W] }, (ctx) => {
        for (const e of ctx.entities) {
          const v = e as unknown as { OrdP: { x: number }; OrdW: { x: number } }
          v.OrdW.x = v.OrdP.x * 2
          w.markChanged(e.id, W)
        }
      })
      return { w, h }
    }

    function forkDiverges(order: 'registration' | 'stable'): boolean {
      const live = build(order, versions[0]!)
      const dt = live.w.time.fixedStep
      for (let t = 1; t <= 30; t++) {
        live.w.step(dt)
        if (t % 10 === 0) live.h.update(versions[t / 10]!)
      }
      const fork = build(order, versions[3]!)
      fork.w.restore(live.w.snapshot())
      expect(strict(fork.w)).toBe(strict(live.w))
      for (let t = 0; t < 120; t++) {
        live.w.step(dt)
        fork.w.step(dt)
        if (strict(fork.w) !== strict(live.w)) return true
      }
      return false
    }

    it("'stable': equal strict hashes for 120 ticks (fixed, tick and random() rules)", () => {
      expect(forkDiverges('stable')).toBe(false)
    })

    it("'registration': the same scenario diverges (control)", () => {
      expect(forkDiverges('registration')).toBe(true)
    })
  })
})
