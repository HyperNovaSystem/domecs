import { describe, expect, it } from 'vitest'
import {
  Faulted,
  createWorld,
  defineComponent,
  dmath,
  entry,
  hashSnapshot,
  type ComponentEntry,
  type ComponentType,
  type World,
} from '@domecs/core'
import { parseExpression } from '../src/parser.js'
import { compileExpression, evaluate, RuleEvalError, type EvalEnv } from '../src/evaluator.js'
import { compileRule, installRules, type InstallRulesOptions, type RuleDef } from '../src/rules.js'

// Spec §5.2 (G1, O-82), plan E10.3: cross-entity reads, selectors,
// aggregates, spatial forms, math and `??` in the evaluator and installRules.

const Pos = defineComponent<{ x: number; y: number }>('XePos', { defaults: { x: 0, y: 0 } })
const Vel = defineComponent<{ x: number; y: number }>('XeVel', { defaults: { x: 0, y: 0 } })
const Player = defineComponent<Record<string, never>>('XePlayer', { defaults: {} })
const Enemy = defineComponent<Record<string, never>>('XeEnemy', { defaults: {} })
const Coin = defineComponent<Record<string, never>>('XeCoin', { defaults: {} })
const Seeker = defineComponent<Record<string, never>>('XeSeeker', { defaults: {} })
const Hp = defineComponent<{ hp: number }>('XeHp', { defaults: { hp: 10 } })
const Out = defineComponent<{ a: number; b: number; c: number; d: number }>('XeOut', {
  defaults: { a: 0, b: 0, c: 0, d: 0 },
})
const Flag = defineComponent<{ on: boolean }>('XeFlag', { defaults: { on: false } })
const Loose = defineComponent<{ v?: number | string }>('XeLoose')
const Link = defineComponent<{ prev: number }>('XeLink', { defaults: { prev: -1 } })
const Dead = defineComponent<Record<string, never>>('XeDead', { defaults: {} })

const TYPES: ComponentType<any>[] = [Pos, Vel, Player, Enemy, Coin, Seeker, Hp, Out, Flag, Loose, Link, Dead]
const resolve = (name: string): ComponentType<any> | undefined => TYPES.find((t) => t.name === name)
const SPATIAL: InstallRulesOptions = { spatial: { component: 'XePos', cellSize: 4 } }

function world(): World {
  return createWorld({ headless: true, seed: [1, 2, 3, 4] })
}

function rule(over: Partial<RuleDef>): RuleDef {
  return { name: 'r', schedule: 'tick', query: ['XeOut'], actions: [], ...over }
}

/** mulberry32 for test inputs. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000
  }
}

function faultsOf(w: World, id: number): string[] {
  const f = w.getComponent(id, Faulted)
  return f ? f.faults.map((x) => String((x.detail as { message: string }).message)) : []
}

describe('E10.3 chase: first(S).C.f against a hand-computed oracle', () => {
  it('enemies close 10% of the gap to the player every tick', () => {
    const w = world()
    installRules(
      w,
      [
        // The player moves first (priority -1), then enemies chase it.
        { name: 'walk', schedule: 'tick', priority: -1, query: ['XePlayer', 'XePos'], actions: [{ set: 'XePos.x', expr: 'XePos.x + 1' }] },
        {
          name: 'chase',
          schedule: 'tick',
          query: ['XeEnemy', 'XePos', 'XeVel'],
          actions: [
            { set: 'XeVel.x', expr: '(first(XePlayer).XePos.x - XePos.x) * 0.1' },
            { set: 'XePos.x', expr: 'XePos.x + XeVel.x' },
          ],
        },
      ],
      resolve,
    )
    const starts = [-7.5, 3.25, 40]
    const enemies = starts.map((x) => w.spawn([entry(Enemy, {}), entry(Pos, { x, y: 0 }), entry(Vel, { x: 0, y: 0 })]))
    w.spawn([entry(Player, {}), entry(Pos, { x: 0, y: 0 })])
    let p = 0
    const e = [...starts]
    for (let t = 0; t < 50; t++) {
      w.stepOnce()
      p = p + 1
      for (let i = 0; i < e.length; i++) {
        const v = (p - e[i]!) * 0.1
        e[i] = e[i]! + v
      }
    }
    enemies.forEach((id, i) => expect(w.getComponent(id, Pos)!.x).toBe(e[i]))
  })
})

describe('E10.3 nearest against a brute-force oracle', () => {
  it('500 seeded entities with ties and maxDistance', () => {
    const w = world()
    installRules(
      w,
      [
        rule({
          name: 'near',
          query: ['XeSeeker', 'XePos', 'XeOut'],
          actions: [
            { set: 'XeOut.a', expr: 'nearest(XeCoin).id ?? -1' },
            { set: 'XeOut.b', expr: 'nearest(XeCoin, 3).id ?? -1' },
            { set: 'XeOut.c', expr: 'countWithin(XeCoin, 3)' },
            { set: 'XeOut.d', expr: 'distanceTo(nearest(XeCoin)) ?? -1' },
          ],
        }),
      ],
      resolve,
      SPATIAL,
    )
    const next = rng(0x5eed)
    const pts: Array<{ id: number; x: number; y: number; coin: boolean; seeker: boolean }> = []
    for (let i = 0; i < 500; i++) {
      // integer lattice: many exact ties
      const x = Math.floor(next() * 40) - 20
      const y = Math.floor(next() * 40) - 20
      const coin = next() < 0.5
      const seeker = !coin || next() < 0.3 // some entities are both
      const bag: ComponentEntry<any>[] = [entry(Pos, { x, y })]
      if (coin) bag.push(entry(Coin, {}))
      if (seeker) bag.push(entry(Seeker, {}), entry(Out, { a: 0, b: 0, c: 0, d: 0 }))
      pts.push({ id: w.spawn(bag), x, y, coin, seeker })
    }
    w.stepOnce()
    let checked = 0
    for (const s of pts) {
      if (!s.seeker) continue
      let best: number | undefined
      let bestD2 = Infinity
      let within = 0
      for (const c of pts) {
        if (!c.coin || c.id === s.id) continue
        const d2 = (c.x - s.x) ** 2 + (c.y - s.y) ** 2
        if (d2 < bestD2 || (d2 === bestD2 && c.id < best!)) {
          best = c.id
          bestD2 = d2
        }
        if (d2 <= 9) within++
      }
      const out = w.getComponent(s.id, Out)!
      expect(out.a).toBe(best ?? -1)
      expect(out.b).toBe(bestD2 <= 9 ? best : -1)
      expect(out.c).toBe(within)
      expect(out.d).toBe(best === undefined ? -1 : Math.sqrt(bestD2))
      checked++
    }
    expect(checked).toBeGreaterThan(250)
  })
})

describe('E10.3 aggregates', () => {
  const aggRules = (writeHp: boolean, query = ['XeOut']): RuleDef[] => [
    rule({
      name: 'agg',
      query,
      actions: [
        ...(writeHp ? [{ set: 'XeHp.hp', expr: 'XeHp.hp' }] : []),
        { set: 'XeOut.a', expr: 'sum(XeEnemy, XeHp.hp)' },
        { set: 'XeOut.b', expr: 'avg(XeEnemy, XeHp.hp) ?? -1' },
        { set: 'XeOut.c', expr: 'minOf(XeEnemy, XeHp.hp) * 1000 + maxOf(XeEnemy, XeHp.hp) ?? -1' },
        { set: 'XeOut.d', expr: 'count(XeEnemy) * 10 + (exists(XeCoin) ? 1 : 0)' },
      ],
    }),
  ]

  it('empty sets: sum 0, count 0, avg/minOf/maxOf no value', () => {
    const w = world()
    installRules(w, aggRules(false), resolve)
    const id = w.spawn([entry(Out, { a: 9, b: 9, c: 9, d: 9 })])
    w.stepOnce()
    expect(w.getComponent(id, Out)).toEqual({ a: 0, b: -1, c: -1, d: 0 })
  })

  it('members without the field are skipped; aggregates include self', () => {
    const w = world()
    installRules(w, aggRules(false), resolve)
    w.spawn([entry(Enemy, {}), entry(Hp, { hp: 4 })])
    w.spawn([entry(Enemy, {})]) // no XeHp: skipped
    w.spawn([entry(Coin, {})])
    const self = w.spawn([entry(Enemy, {}), entry(Hp, { hp: 2 }), entry(Out, { a: 0, b: 0, c: 0, d: 0 })])
    w.stepOnce()
    expect(w.getComponent(self, Out)).toEqual({ a: 6, b: 3, c: 2004, d: 31 })
    expect(faultsOf(w, self)).toEqual([])
  })

  it('a non-number member value faults the entity', () => {
    const w = world()
    installRules(w, [rule({ name: 'agg', actions: [{ set: 'XeOut.a', expr: 'sum(XeEnemy, XeLoose.v)' }] })], resolve)
    w.spawn([entry(Enemy, {}), entry(Loose, { v: 'x' })])
    const id = w.spawn([entry(Out, { a: 5, b: 0, c: 0, d: 0 })])
    w.stepOnce()
    expect(w.getComponent(id, Out)!.a).toBe(5)
    expect(faultsOf(w, id).join()).toMatch(/Expected a number for sum\(\)/)
  })

  it('memoized and non-memoized paths give identical results', () => {
    const run = (writeHp: boolean): unknown[] => {
      const w = world()
      // Both variants run on the same entities; only the write target differs.
      installRules(w, aggRules(writeHp, ['XeOut', 'XeHp']), resolve)
      const next = rng(0xa66)
      const outs: number[] = []
      for (let i = 0; i < 60; i++) {
        const bag: ComponentEntry<any>[] = []
        if (next() < 0.6) bag.push(entry(Enemy, {}))
        if (next() < 0.7) bag.push(entry(Hp, { hp: Math.floor(next() * 100) / 4 }))
        if (next() < 0.4) bag.push(entry(Coin, {}))
        if (next() < 0.5) bag.push(entry(Out, { a: 0, b: 0, c: 0, d: 0 }))
        const id = w.spawn(bag.length ? bag : [entry(Coin, {})])
        if (bag.some((b) => b[0] === Out)) outs.push(id)
      }
      for (let t = 0; t < 3; t++) w.stepOnce()
      return outs.map((id) => w.getComponent(id, Out))
    }
    expect(run(true)).toEqual(run(false))
  })

  it('compileExpression memoizes a marked aggregate once per environment', () => {
    const parsed = parseExpression('sum(S, C.f)')
    if ('errors' in parsed) throw new Error('parse')
    let calls = 0
    const mk = (): EvalEnv => ({
      dt: 0,
      time: 0,
      rand: { uniform: () => 0 },
      resolveField: () => undefined,
      self: 1,
      members: () => {
        calls++
        return [2, 3]
      },
      readField: (e) => e * 10,
    })
    const memo = compileExpression(parsed.ast, { memoize: () => true })
    const env = mk()
    expect([memo(env), memo(env), memo(env)]).toEqual([50, 50, 50])
    expect(calls).toBe(1)
    expect(memo(mk())).toBe(50) // a new environment (run) recomputes
    expect(calls).toBe(2)
    const plain = compileExpression(parsed.ast)
    plain(env)
    plain(env)
    expect(calls).toBe(4)
  })
})

describe('E10.3 ?? and no value', () => {
  it('?? catches no value only; type errors propagate', () => {
    const w = world()
    installRules(
      w,
      [
        rule({ name: 'a', actions: [{ set: 'XeOut.a', expr: 'XeLoose.v * 2 ?? 7' }] }),
        rule({ name: 'b', actions: [{ set: 'XeOut.b', expr: 'first(XeCoin).XeHp.hp ?? 8' }] }),
        rule({ name: 'c', actions: [{ set: 'XeOut.c', expr: 'entity(999).XeHp.hp ?? entity(998).id ?? 9' }] }),
      ],
      resolve,
    )
    const missing = w.spawn([entry(Out, { a: 0, b: 0, c: 0, d: 0 })])
    const stringy = w.spawn([entry(Out, { a: 0, b: 0, c: 0, d: 0 }), entry(Loose, { v: 'oops' })])
    w.stepOnce()
    expect(w.getComponent(missing, Out)).toMatchObject({ a: 7, b: 8, c: 9 })
    expect(w.getComponent(stringy, Out)!.a).toBe(0)
    expect(faultsOf(w, stringy).join()).toMatch(/Expected a number/)
  })

  it('without ??, no value is the existing rule_eval_failed fault on the entity', () => {
    const w = world()
    installRules(w, [rule({ name: 'a', actions: [{ set: 'XeOut.a', expr: 'first(XeCoin).id' }] })], resolve)
    const id = w.spawn([entry(Out, { a: 1, b: 0, c: 0, d: 0 })])
    w.stepOnce()
    expect(w.getComponent(id, Out)!.a).toBe(1)
    const f = w.getComponent(id, Faulted)!.faults[0]!
    expect(f).toMatchObject({ kind: 'rule_eval_failed', source: 'rule:a' })
  })

  it('no-value errors are RuleEvalErrors (instanceof holds)', () => {
    const parsed = parseExpression('Missing.f')
    if ('errors' in parsed) throw new Error('parse')
    const env: EvalEnv = { dt: 0, time: 0, rand: { uniform: () => 0 }, resolveField: () => undefined }
    expect(() => evaluate(parsed.ast, env)).toThrow(RuleEvalError)
  })
})

describe('E10.3 selectors and reads', () => {
  it('first(S) skips self; entity(n) reads by id; dead or non-integer ids', () => {
    const w = world()
    installRules(
      w,
      [
        rule({
          name: 'sel',
          query: ['XeOut', 'XeCoin'],
          actions: [
            { set: 'XeOut.a', expr: 'first(XeCoin).id' },
            { set: 'XeOut.b', expr: 'entity(first(XeCoin).id).XeHp.hp' },
            { set: 'XeOut.c', expr: 'self.id' },
            { set: 'XeOut.d', expr: 'entity(XeLink.prev).id ?? -1' },
          ],
        }),
      ],
      resolve,
    )
    const a = w.spawn([entry(Coin, {}), entry(Hp, { hp: 3 }), entry(Out, { a: 0, b: 0, c: 0, d: 0 }), entry(Link, { prev: 99 })])
    const b = w.spawn([entry(Coin, {}), entry(Hp, { hp: 4 }), entry(Out, { a: 0, b: 0, c: 0, d: 0 }), entry(Link, { prev: a })])
    const gone = w.spawn([entry(Dead, {})])
    w.despawn(gone)
    w.stepOnce()
    expect(w.getComponent(a, Out)).toEqual({ a: b, b: 4, c: a, d: -1 })
    expect(w.getComponent(b, Out)).toEqual({ a, b: 3, c: b, d: a })
  })

  it('entity(1.5) is a type error, not no value', () => {
    const w = world()
    installRules(w, [rule({ name: 's', actions: [{ set: 'XeOut.a', expr: 'entity(1.5).id ?? 3' }] })], resolve)
    const id = w.spawn([entry(Out, { a: 0, b: 0, c: 0, d: 0 })])
    w.stepOnce()
    expect(w.getComponent(id, Out)!.a).toBe(0)
    expect(faultsOf(w, id).join()).toMatch(/integer/)
  })

  it('has([e,] C), tick, self.C.f', () => {
    const w = world()
    installRules(
      w,
      [
        rule({
          name: 'h',
          query: ['XeOut'],
          actions: [
            { set: 'XeOut.a', expr: 'has(XeFlag) ? 1 : 0' },
            { set: 'XeOut.b', expr: 'has(first(XeCoin), XeHp) ? 1 : 0' },
            { set: 'XeOut.c', expr: 'tick' },
            { set: 'XeOut.d', expr: 'self.XeOut.c * 10' },
          ],
        }),
      ],
      resolve,
    )
    w.spawn([entry(Coin, {}), entry(Hp, { hp: 1 })])
    const id = w.spawn([entry(Out, { a: 0, b: 0, c: 0, d: 0 }), entry(Flag, { on: true })])
    w.stepOnce()
    w.stepOnce()
    const tick = w.time.tick
    expect(w.getComponent(id, Out)).toEqual({ a: 1, b: 1, c: tick, d: tick * 10 })
  })

  it('a member read on another entity is an own property only (O-67)', () => {
    const w = world()
    installRules(w, [rule({ name: 'm', actions: [{ set: 'XeOut.a', expr: 'first(XeCoin).XeLoose.v ?? -1' }] })], resolve)
    w.spawn([entry(Coin, {}), entry(Loose, {})]) // v absent: no own property
    const id = w.spawn([entry(Out, { a: 0, b: 0, c: 0, d: 0 })])
    w.stepOnce()
    expect(w.getComponent(id, Out)!.a).toBe(-1)
  })
})

describe('E10.3 read timing (Gauss–Seidel)', () => {
  const chain: RuleDef = rule({
    name: 'chain',
    query: ['XeLink', 'XeHp'],
    actions: [{ set: 'XeHp.hp', expr: '(entity(XeLink.prev).XeHp.hp ?? 0) + 1' }],
  })

  it('entity k sees the committed writes of lower ids from the same run', () => {
    const w = world()
    installRules(w, [chain], resolve)
    let prev = -1
    const ids: number[] = []
    for (let i = 0; i < 6; i++) {
      prev = w.spawn([entry(Link, { prev }), entry(Hp, { hp: 0 })])
      ids.push(prev)
    }
    w.stepOnce()
    // ascending ids, each committed before the next reads it: 1, 2, 3, ...
    expect(ids.map((id) => w.getComponent(id, Hp)!.hp)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('live and fork reach equal strict hashes', () => {
    const build = (): World => {
      const w = world()
      installRules(w, [chain, { ...rule({ name: 'near', query: ['XeSeeker', 'XePos', 'XeOut'], actions: [
        { set: 'XeOut.a', expr: 'countWithin(XeCoin, 6) + (nearest(XeCoin).XeHp.hp ?? 0)' },
        { set: 'XePos.x', expr: 'XePos.x + sign(first(XeCoin).XePos.x - XePos.x) * 0.5 ?? XePos.x' },
      ] }) }], resolve, { ...SPATIAL, rng: 'own' })
      return w
    }
    const live = build()
    const next = rng(0xf0c)
    let prev = -1
    for (let i = 0; i < 40; i++) {
      const bag: ComponentEntry<any>[] = [entry(Pos, { x: Math.floor(next() * 30), y: Math.floor(next() * 30) })]
      if (i % 3 === 0) bag.push(entry(Coin, {}), entry(Hp, { hp: i }), entry(Link, { prev }))
      else bag.push(entry(Seeker, {}), entry(Out, { a: 0, b: 0, c: 0, d: 0 }))
      const id = live.spawn(bag)
      if (i % 3 === 0) prev = id
    }
    for (let t = 0; t < 10; t++) live.stepOnce()
    // Non-vacuous: the cross-entity rules ran and changed state.
    const outs = live.listEntities([Out]).map((id) => live.getComponent(id, Out)!.a)
    expect(outs.some((a) => a > 0)).toBe(true)
    expect(live.listEntities([Hp]).map((id) => live.getComponent(id, Hp)!.hp)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
    const fork = build()
    fork.restore(live.snapshot({ pendingEvents: true }))
    for (let t = 0; t < 10; t++) {
      live.stepOnce()
      fork.stepOnce()
      expect(hashSnapshot(fork.snapshot(), { includeChanges: true })).toBe(hashSnapshot(live.snapshot(), { includeChanges: true }))
    }
  })
})

describe('E10.3 without', () => {
  it('excludes holders of the listed components', () => {
    const w = world()
    installRules(w, [rule({ name: 'w', query: ['XeOut'], without: ['XeFlag'], actions: [{ set: 'XeOut.a', expr: '1' }] })], resolve)
    const plain = w.spawn([entry(Out, { a: 0, b: 0, c: 0, d: 0 })])
    const flagged = w.spawn([entry(Out, { a: 0, b: 0, c: 0, d: 0 }), entry(Flag, { on: false })])
    w.stepOnce()
    expect(w.getComponent(plain, Out)!.a).toBe(1)
    expect(w.getComponent(flagged, Out)!.a).toBe(0)
  })

  it('an unknown name reports field { without: i }', () => {
    const r = compileRule(rule({ name: 'w', without: ['XeFlag', 'Nope'] }), resolve)
    expect(r.rule).toBeNull()
    expect(r.errors).toEqual([
      { rule: 'w', position: -1, message: 'Unknown component "Nope" referenced in without', field: { without: 1 } },
    ])
  })
})

describe('E10.3 compile-time checks', () => {
  it('spatial forms without the spatial option are compile errors on the right part', () => {
    const r = compileRule(
      rule({
        name: 's',
        when: 'XeOut.a > 0 && countWithin(XeCoin, 2) > 1',
        actions: [
          { set: 'XeOut.a', expr: '1' },
          { set: 'XeOut.b', expr: 'distanceTo(first(XeCoin))' },
          { set: 'XeOut.c', expr: 'nearest(XeCoin).id' },
        ],
      }),
      resolve,
    )
    expect(r.rule).toBeNull()
    expect(r.errors.map((e) => [e.field, e.position])).toEqual([
      ['when', 15],
      [{ action: 1, part: 'expr' }, 0],
      [{ action: 2, part: 'expr' }, 0],
    ])
    expect(r.errors[0]!.message).toMatch(/spatial/)
    expect(compileRule(rule({ name: 's', actions: [{ set: 'XeOut.a', expr: 'nearest(XeCoin).id' }] }), resolve, SPATIAL).errors).toEqual([])
  })

  it('every component name is resolved: sets, member reads, has targets, aggregate fields', () => {
    const r = compileRule(
      rule({
        name: 'u',
        when: 'count(Nope1) > 0',
        actions: [
          { set: 'XeOut.a', expr: 'first(XeCoin).Nope2.x' },
          { set: 'XeOut.b', expr: 'has(Nope3) ? 1 : 0' },
          { set: 'XeOut.c', expr: 'sum(XeCoin, Nope4.v)' },
          { set: 'XeOut.d', expr: 'first(XeCoin).XeHp.constructor' },
        ],
      }),
      resolve,
    )
    expect(r.errors.map((e) => [e.field, e.position, e.message])).toEqual([
      ['when', 0, 'Unknown component "Nope1" referenced in "when"'],
      [{ action: 0, part: 'expr' }, 0, 'Unknown component "Nope2" referenced in action "XeOut.a" expr'],
      [{ action: 1, part: 'expr' }, 0, 'Unknown component "Nope3" referenced in action "XeOut.b" expr'],
      [{ action: 2, part: 'expr' }, 0, 'Unknown component "Nope4" referenced in action "XeOut.c" expr'],
      [{ action: 3, part: 'expr' }, 0, 'Field name "constructor" is not allowed'],
    ])
  })

  it('kinds: has/exists are boolean, count/countWithin/distanceTo are numbers', () => {
    const bad = compileRule(rule({ name: 'k', actions: [{ set: 'XeOut.a', expr: 'has(XeFlag) + 1' }] }), resolve)
    expect(bad.errors.map((e) => e.message)).toEqual(['Expected a number for "+", got boolean'])
    const bad2 = compileRule(rule({ name: 'k', actions: [{ set: 'XeOut.a', expr: 'exists(XeCoin) * 2' }] }), resolve)
    expect(bad2.errors).toHaveLength(1)
    const bad3 = compileRule(rule({ name: 'k', actions: [{ set: 'XeOut.a', expr: 'entity("x").id' }] }), resolve)
    expect(bad3.errors.map((e) => e.message)).toEqual(['Expected a number for entity(), got string'])
    const good = compileRule(
      rule({ name: 'k', actions: [{ set: 'XeOut.a', expr: 'count(XeCoin) + first(XeCoin).id + (first(XeCoin).XeHp.hp ?? 0)' }] }),
      resolve,
    )
    expect(good.errors).toEqual([])
  })

  it('installRules validates the spatial option', () => {
    const w = world()
    expect(() => installRules(w, [], resolve, { spatial: { component: '' } })).toThrow(/spatial/)
    expect(() => installRules(w, [], resolve, { spatial: { component: 'XePos', cellSize: 0 } })).toThrow(/cellSize/)
    expect(() => installRules(w, [], resolve, { spatial: { component: 'XePos', x: '__proto__' } })).toThrow(/spatial/)
  })

  it('a missing hook is "not available in this environment" (not no value)', () => {
    const env: EvalEnv = { dt: 0, time: 0, rand: { uniform: () => 0 }, resolveField: () => undefined }
    for (const src of ['count(S) ?? 1', 'tick ?? 1', 'self.id ?? 1', 'first(S).id ?? 1']) {
      const parsed = parseExpression(src)
      if ('errors' in parsed) throw new Error('parse')
      expect(() => evaluate(parsed.ast, env), src).toThrow(/not available in this environment/)
      expect(() => compileExpression(parsed.ast)(env), src).toThrow(/not available in this environment/)
    }
  })
})

describe('E10.3 math', () => {
  const env = (vals: Record<string, number>): EvalEnv => ({
    dt: 0,
    time: 0,
    rand: { uniform: () => 0 },
    resolveField: (c, f) => vals[`${c}.${f}`],
  })
  const both = (src: string, vals: Record<string, number> = {}): unknown => {
    const parsed = parseExpression(src)
    if ('errors' in parsed) throw new Error(`parse ${src}`)
    const a = evaluate(parsed.ast, env(vals))
    const b = compileExpression(parsed.ast)(env(vals))
    expect(Object.is(a, b), src).toBe(true)
    return a
  }

  it('sqrt sign round ceil lerp distance are exact JS arithmetic', () => {
    expect(both('sqrt(2)')).toBe(Math.sqrt(2))
    expect(both('sign(0 - 3)')).toBe(-1)
    expect(Object.is(both('sign(P.z)', { 'P.z': -0 }), -0)).toBe(true)
    expect(both('round(2.5)')).toBe(3)
    expect(both('round(0 - 2.5)')).toBe(-2)
    expect(both('ceil(1.2)')).toBe(2)
    expect(both('lerp(10, 20, 0.25)')).toBe(12.5)
    expect(both('lerp(P.a, P.b, P.t)', { 'P.a': 0.1, 'P.b': 0.7, 'P.t': 0.3 })).toBe(0.1 + (0.7 - 0.1) * 0.3)
    expect(both('distance(1, 2, 4, 6)')).toBe(5)
  })

  it('atan2, pow and hypot equal dmath bit for bit (evaluate, compileExpression, installRules)', () => {
    const next = rng(0xa7)
    const triples: Array<[number, number]> = []
    for (let i = 0; i < 1000; i++) {
      const a = (next() * 2 - 1) * 10 ** Math.floor(next() * 6 - 2)
      const b = (next() * 2 - 1) * 10 ** Math.floor(next() * 6 - 2)
      triples.push([a, b])
    }
    for (const [a, b] of triples.slice(0, 200)) {
      const vals = { 'P.a': a, 'P.b': b }
      expect(Object.is(both('atan2(P.a, P.b)', vals), dmath.atan2(a, b))).toBe(true)
      expect(Object.is(both('hypot(P.a, P.b)', vals), dmath.hypot(a, b))).toBe(true)
      const pw = both('pow(P.a, P.b)', vals) as number
      expect(Object.is(pw, dmath.pow(a, b)) || (Number.isNaN(pw) && Number.isNaN(dmath.pow(a, b)))).toBe(true)
    }
    const w = world()
    installRules(
      w,
      [
        // Separate rules: a non-finite d (pow overflow) is a rejected write
        // that skips its whole rule on that entity.
        rule({ name: 'm1', query: ['XeOut'], actions: [{ set: 'XeOut.c', expr: 'atan2(XeOut.a, XeOut.b)' }] }),
        rule({ name: 'm2', query: ['XeOut'], actions: [{ set: 'XeOut.d', expr: 'hypot(XeOut.a, XeOut.b) + pow(abs(XeOut.a), XeOut.b)' }] }),
      ],
      resolve,
    )
    const ids = triples.map(([a, b]) => w.spawn([entry(Out, { a, b, c: 0, d: 0 })]))
    w.stepOnce()
    const wrong: string[] = []
    ids.forEach((id, i) => {
      const [a, b] = triples[i]!
      const o = w.getComponent(id, Out)!
      if (!Object.is(o.c, dmath.atan2(a, b))) wrong.push(`atan2(${a}, ${b})`)
      const d = dmath.hypot(a, b) + dmath.pow(Math.abs(a), b)
      if (Number.isFinite(d) && !Object.is(o.d, d)) wrong.push(`hypot/pow(${a}, ${b})`)
    })
    expect(wrong.slice(0, 5)).toEqual([])
  })
})
