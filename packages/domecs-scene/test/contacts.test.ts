import { describe, expect, it } from 'vitest'
import {
  createWorld,
  defineComponent,
  defineResource,
  entry,
  hashSnapshot,
  validateEventPayload,
} from '@domecs/core'
import type { ComponentEntry, ComponentType, Entity, World, WorldSnapshot } from '@domecs/core'
import { installRules, type RuleDef } from '@domecs/rules'
import { Contact, ContactState, installContacts, type ContactsOptions } from '../src/index.js'

// Spec §6.2 (G7, O-85), plan E15.1: overlap events for rules. A fixed
// system (priority 150) rebuilds a spatial grid from positions, diffs the
// sorted overlapping pairs against the snapshotted ContactState resource and
// emits Contact { a, b, phase } — end, then begin, then stay, each by (a, b).

const Pos = defineComponent<{ x: number; y: number }>('CtPos', { defaults: { x: 0, y: 0 } })
const Vel = defineComponent<{ vx: number; vy: number }>('CtVel', { defaults: { vx: 0, vy: 0 } })
const Body = defineComponent<{ r: number }>('CtBody', { defaults: { r: 1 } })
const Player = defineComponent<{ p: number }>('CtPlayer', { defaults: { p: 1 } })
const Enemy = defineComponent<{ e: number }>('CtEnemy', { defaults: { e: 1 } })
const Pickup = defineComponent<{ k: number }>('CtPickup', { defaults: { k: 1 } })
const Hp = defineComponent<{ hp: number }>('CtHp', { defaults: { hp: 10 } })
const Dmg = defineComponent<{ amount: number }>('CtDmg', { defaults: { amount: 1 } })

type Row = [number, number, string] // a, b, phase
/** Durable log of delivered contacts, so it is part of the snapshot hash. */
const ContactLog = defineResource<{ rows: Array<[number, number, number, string]> }>('CtLog', {
  default: () => ({ rows: [] }),
})

const strict = (w: World): string => hashSnapshot(w.snapshot({ pendingEvents: true }), { includeChanges: true })
const step = (w: World): void => w.step(w.time.fixedStep)

/** Installs movement, the contacts plugin and a logger of delivered events. */
function setup(w: World, options: Partial<ContactsOptions> = {}): { next(): Row[] } {
  w.system('ct:move', { schedule: 'fixed', query: [Pos, Vel] }, (ctx) => {
    for (const e of ctx.entities) {
      const p = e.CtPos as { x: number; y: number }
      const v = e.CtVel as { vx: number; vy: number }
      p.x += v.vx
      p.y += v.vy
      // Bounce inside a 40 × 40 box so contacts begin and end repeatedly.
      if (p.x < 0 || p.x > 40) v.vx = -v.vx
      if (p.y < 0 || p.y > 40) v.vy = -v.vy
      ctx.world.markChanged(e.id, Pos)
    }
  })
  // An event system with triggers runs only on ticks that deliver one.
  const buffer: Row[] = []
  w.system('ct:log', { schedule: 'event', triggers: [Contact] }, (ctx) => {
    const log = ctx.world.getResource(ContactLog)!
    for (const c of ctx.events.of(Contact)) {
      buffer.push([c.a, c.b, c.phase])
      log.rows.push([ctx.world.time.tick, c.a, c.b, c.phase])
    }
  })
  const used = w.use(
    installContacts({
      position: { component: Pos },
      radius: { component: Body, field: 'r' },
      pairs: [
        [Player, Enemy],
        [Player, Pickup],
      ],
      stay: true,
      ...options,
    }),
  )
  expect(used.ok).toBe(true)
  /** One fixed step; returns the contacts delivered in it (emitted the step before). */
  const next = (): Row[] => {
    step(w)
    return buffer.splice(0)
  }
  return { next }
}

/** A seeded scene of 30 bouncing entities; test-local LCG (not engine code). */
function populate(w: World, seed = 12345): void {
  let s = seed >>> 0
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
  for (let i = 0; i < 30; i++) {
    const bag: ComponentEntry<any>[] = [
      entry(Pos, { x: next() * 40, y: next() * 40 }),
      entry(Vel, { vx: (next() - 0.5) * 3, vy: (next() - 0.5) * 3 }),
      entry(Body, { r: 1 + next() * 2 }),
    ]
    const kind = i % 3
    if (kind === 0) bag.push(entry(Player, { p: 1 }))
    else if (kind === 1) bag.push(entry(Enemy, { e: 1 }))
    else bag.push(entry(Pickup, { k: 1 }))
    if (i === 8) bag.push(entry(Enemy, { e: 1 })) // a pickup that is also an enemy (deduped pairs)
    if (i === 9) bag.push(entry(Enemy, { e: 1 })) // a player that is also an enemy (both directions)
    w.spawn(bag)
  }
}

/** Brute-force oracle: the sorted, de-duplicated overlapping pairs. */
function oracle(w: World, pairs: ReadonlyArray<readonly [ComponentType<any>, ComponentType<any>]>): Array<[Entity, Entity]> {
  const bodies: Array<{ id: Entity; x: number; y: number; r: number }> = []
  for (const { id, value } of w.iterEntitiesWith(Pos)) {
    const b = w.getComponent(id, Body)
    if (!b) continue
    bodies.push({ id, x: value.x, y: value.y, r: b.r })
  }
  const keys = new Set<string>()
  const out: Array<[Entity, Entity]> = []
  const add = (a: Entity, b: Entity) => {
    const k = `${a},${b}`
    if (keys.has(k)) return
    keys.add(k)
    out.push([a, b])
  }
  for (const p of bodies) {
    for (const q of bodies) {
      if (p.id === q.id) continue
      const dx = q.x - p.x
      const dy = q.y - p.y
      const reach = p.r + q.r
      if (!(dx * dx + dy * dy <= reach * reach)) continue
      for (const [A, B] of pairs) {
        if (!w.has(p.id, A) || !w.has(q.id, B)) continue
        if (A === B && !(p.id < q.id)) continue
        add(p.id, q.id)
      }
    }
  }
  return out.sort((s, t) => s[0] - t[0] || s[1] - t[1])
}

function diff(prev: Array<[Entity, Entity]>, cur: Array<[Entity, Entity]>, stay: boolean): Row[] {
  const key = (p: [Entity, Entity]) => `${p[0]},${p[1]}`
  const prevKeys = new Set(prev.map(key))
  const curKeys = new Set(cur.map(key))
  return [
    ...prev.filter((p) => !curKeys.has(key(p))).map(([a, b]): Row => [a, b, 'end']),
    ...cur.filter((p) => !prevKeys.has(key(p))).map(([a, b]): Row => [a, b, 'begin']),
    ...(stay ? cur.filter((p) => prevKeys.has(key(p))).map(([a, b]): Row => [a, b, 'stay']) : []),
  ]
}

const PAIRS = [
  [Player, Enemy],
  [Player, Pickup],
] as const

describe('installContacts (spec §6.2)', () => {
  it('test 1: begin, stay and end sequences match a brute-force oracle', () => {
    for (const stay of [true, false]) {
      const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
      const { next } = setup(w, { stay })
      const delivered: Row[][] = []
      populate(w)
      let prev: Array<[Entity, Entity]> = []
      const expected: Row[][] = []
      let begins = 0
      let ends = 0
      for (let i = 0; i < 200; i++) {
        delivered.push(next())
        const cur = oracle(w, PAIRS)
        const rows = diff(prev, cur, stay)
        begins += rows.filter((r) => r[2] === 'begin').length
        ends += rows.filter((r) => r[2] === 'end').length
        expected.push(rows)
        prev = cur
        expect(w.getResource(ContactState)!.pairs).toEqual(cur)
      }
      delivered.push(next()) // deliver the last step's events
      // delivered[k] holds the events emitted in step k-1 (next-tick delivery).
      expect(delivered[0]).toEqual([])
      expect(delivered.slice(1)).toEqual(expected)
      expect(begins).toBeGreaterThan(20)
      expect(ends).toBeGreaterThan(20)
    }
  })

  it('an entity holding both tags of a pair appears on either side; duplicate pairs are emitted once', () => {
    const w = createWorld({ headless: true })
    const { next } = setup(w, { radius: 1, stay: false })
    const delivered: Row[][] = []
    const p = w.spawn([entry(Pos, { x: 0, y: 0 }), entry(Player, { p: 1 }), entry(Enemy, { e: 1 })])
    const q = w.spawn([entry(Pos, { x: 1, y: 0 }), entry(Player, { p: 1 }), entry(Enemy, { e: 1 }), entry(Pickup, { k: 1 })])
    delivered.push(next())
    delivered.push(next())
    expect(delivered[1]).toEqual([
      [p, q, 'begin'],
      [q, p, 'begin'],
    ])
  })

  it('test 2: same-tag pairs are canonical (a < b) and emitted once', () => {
    const w = createWorld({ headless: true })
    const { next } = setup(w, { radius: 1, pairs: [[Enemy, Enemy]], stay: true })
    const delivered: Row[][] = []
    const a = w.spawn([entry(Pos, { x: 0, y: 0 }), entry(Enemy, { e: 1 })])
    const b = w.spawn([entry(Pos, { x: 1.5, y: 0 }), entry(Enemy, { e: 1 })])
    const c = w.spawn([entry(Pos, { x: 3, y: 0 }), entry(Enemy, { e: 1 })])
    w.spawn([entry(Pos, { x: 0, y: 0 }), entry(Player, { p: 1 })]) // not an Enemy
    delivered.push(next())
    delivered.push(next())
    delivered.push(next())
    expect(delivered[1]).toEqual([
      [a, b, 'begin'],
      [b, c, 'begin'],
    ])
    expect(delivered[2]).toEqual([
      [a, b, 'stay'],
      [b, c, 'stay'],
    ])
    expect(w.getResource(ContactState)!.pairs).toEqual([
      [a, b],
      [b, c],
    ])
  })

  it('test 3: a despawned entity ends its contacts once', () => {
    const w = createWorld({ headless: true })
    const { next } = setup(w, { radius: 1, stay: false })
    const delivered: Row[][] = []
    const p = w.spawn([entry(Pos, { x: 0, y: 0 }), entry(Player, { p: 1 })])
    const e = w.spawn([entry(Pos, { x: 1, y: 0 }), entry(Enemy, { e: 1 })])
    const f = w.spawn([entry(Pos, { x: 2, y: 0 }), entry(Enemy, { e: 1 })])
    const k = w.spawn([entry(Pos, { x: 0, y: 1 }), entry(Pickup, { k: 1 })])
    delivered.push(next())
    w.despawn(e)
    delivered.push(next())
    delivered.push(next())
    delivered.push(next())
    expect(delivered[1]).toEqual([
      [p, e, 'begin'],
      [p, f, 'begin'],
      [p, k, 'begin'],
    ])
    expect(delivered[2]).toEqual([[p, e, 'end']])
    expect(delivered[3]).toEqual([])
    expect(w.getResource(ContactState)!.pairs).toEqual([
      [p, f],
      [p, k],
    ])
  })

  it('an entity that keeps one tag and loses another ends only the lost pairs', () => {
    const w = createWorld({ headless: true })
    const { next } = setup(w, { radius: 1, stay: false, pairs: [[Player, Enemy]] })
    const x = w.spawn([entry(Pos, { x: 0, y: 0 }), entry(Player, { p: 1 }), entry(Enemy, { e: 1 })])
    const y = w.spawn([entry(Pos, { x: 1, y: 0 }), entry(Enemy, { e: 1 })])
    next()
    expect(next()).toEqual([[x, y, 'begin']])
    w.removeComponent(x, Player) // x still holds Enemy, so it stays a candidate
    expect(next()).toEqual([])
    expect(next()).toEqual([[x, y, 'end']])
    w.addComponent(x, Player, { p: 1 })
    next()
    expect(next()).toEqual([[x, y, 'begin']])
  })

  it('test 3b: despawning every collider still ends the contacts', () => {
    const w = createWorld({ headless: true })
    const { next } = setup(w, { radius: 1, stay: true })
    const p = w.spawn([entry(Pos, { x: 0, y: 0 }), entry(Player, { p: 1 })])
    const e = w.spawn([entry(Pos, { x: 1, y: 0 }), entry(Enemy, { e: 1 })])
    next()
    expect(next()).toEqual([[p, e, 'begin']])
    w.despawn(p)
    w.despawn(e)
    expect(next()).toEqual([[p, e, 'stay']])
    expect(next()).toEqual([[p, e, 'end']])
    expect(next()).toEqual([])
    expect(w.getResource(ContactState)!.pairs).toEqual([])
  })

  it('a lost tag or radius component ends the contact; bad positions and radii are not colliders', () => {
    const w = createWorld({ headless: true })
    const { next } = setup(w, { stay: false })
    const delivered: Row[][] = []
    const p = w.spawn([entry(Pos, { x: 0, y: 0 }), entry(Body, { r: 1 }), entry(Player, { p: 1 })])
    const e = w.spawn([entry(Pos, { x: 1, y: 0 }), entry(Body, { r: 1 }), entry(Enemy, { e: 1 })])
    w.spawn([entry(Pos, { x: 0, y: 0 }), entry(Enemy, { e: 1 })]) // no Body: not a collider
    w.spawn([entry(Pos, { x: 0, y: 0 }), entry(Body, { r: -1 }), entry(Enemy, { e: 1 })])
    w.spawn([entry(Pos, { x: 0, y: 0 }), entry(Body, { r: Number.NaN }), entry(Enemy, { e: 1 })])
    w.spawn([entry(Pos, { x: Number.NaN, y: 0 }), entry(Body, { r: 5 }), entry(Enemy, { e: 1 })])
    w.spawn([entry(Pos, { x: Number.POSITIVE_INFINITY, y: 0 }), entry(Body, { r: 5 }), entry(Enemy, { e: 1 })])
    w.spawn([entry(Pos, { x: 0, y: 0 }), entry(Body, { r: Number.POSITIVE_INFINITY }), entry(Enemy, { e: 1 })])
    delivered.push(next())
    w.removeComponent(e, Enemy)
    delivered.push(next())
    w.addComponent(e, Enemy, { e: 1 })
    delivered.push(next())
    w.removeComponent(e, Body)
    delivered.push(next())
    delivered.push(next())
    expect(delivered.slice(1)).toEqual([[[p, e, 'begin']], [[p, e, 'end']], [[p, e, 'begin']], [[p, e, 'end']]])
  })

  it('touching counts: dist² <= (ra + rb)², and radii are read live', () => {
    const w = createWorld({ headless: true })
    const { next } = setup(w, { stay: false })
    const delivered: Row[][] = []
    const p = w.spawn([entry(Pos, { x: 0, y: 0 }), entry(Body, { r: 1 }), entry(Player, { p: 1 })])
    const e = w.spawn([entry(Pos, { x: 3, y: 4 }), entry(Body, { r: 3.5 }), entry(Enemy, { e: 1 })])
    delivered.push(next())
    w.getComponent(e, Body)!.r = 4 // exactly touching: 5² <= (1 + 4)²
    delivered.push(next())
    w.getComponent(p, Body)!.r = 0.5
    delivered.push(next())
    delivered.push(next())
    expect(delivered.slice(1)).toEqual([[], [[p, e, 'begin']], [[p, e, 'end']]])
  })

  it('results never depend on cellSize', () => {
    const run = (cellSize: number | undefined): string => {
      const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
      setup(w, cellSize === undefined ? {} : { cellSize })
      populate(w, 99)
      for (let i = 0; i < 120; i++) step(w)
      return JSON.stringify(w.getResource(ContactLog)) + strict(w)
    }
    const base = run(undefined)
    for (const cellSize of [0.25, 1, 7, 64, 1e6]) expect(run(cellSize)).toBe(base)
  })

  it('test 4: a snapshot with begin/end in flight restores to identical events and strict hashes', () => {
    const build = (): World => {
      const w = createWorld({ headless: true, seed: [5, 6, 7, 8] })
      setup(w)
      return w
    }
    const live = build()
    populate(live, 777)
    const forks: Array<{ at: number; world: World }> = []
    let lossy: World | undefined
    for (let i = 0; i < 160; i++) {
      step(live)
      const inFlight = live.pendingEvents().filter((e) => e.type === Contact)
      const phases = new Set(inFlight.map((e) => (e.payload as { phase: string }).phase))
      if (phases.has('begin') || phases.has('end')) {
        if (forks.length < 8 && i % 9 === 0) {
          const snap: WorldSnapshot = live.snapshot({ pendingEvents: true })
          const fork = build()
          fork.restore(snap)
          expect(strict(fork)).toBe(strict(live))
          forks.push({ at: i, world: fork })
        }
        if (!lossy && i > 20) {
          lossy = build()
          lossy.restore(live.snapshot()) // control: in-flight contacts dropped
        }
      }
      for (const f of forks) {
        if (f.world === forks[forks.length - 1]!.world && f.at === i) continue
        step(f.world)
        expect(strict(f.world), `fork@${f.at} tick ${i}`).toBe(strict(live))
      }
      if (lossy) step(lossy)
    }
    expect(forks.length).toBeGreaterThanOrEqual(4)
    for (const f of forks) expect(f.world.getResource(ContactLog)).toEqual(live.getResource(ContactLog))
    expect(lossy).toBeDefined()
    expect(JSON.stringify(lossy!.getResource(ContactLog))).not.toBe(JSON.stringify(live.getResource(ContactLog)))
  })

  it('test 5: contact damage through an event rule', () => {
    const w = createWorld({ headless: true, seed: [1, 1, 1, 1] })
    w.system('ct:move', { schedule: 'fixed', query: [Pos, Vel] }, (ctx) => {
      for (const e of ctx.entities) {
        ;(e.CtPos as { x: number }).x += (e.CtVel as { vx: number }).vx
        ctx.world.markChanged(e.id, Pos)
      }
    })
    expect(
      w.use(installContacts({ position: { component: Pos }, radius: 1, pairs: [[Player, Enemy]] })).ok,
    ).toBe(true)
    const types: ComponentType<any>[] = [Pos, Hp, Dmg, Player, Enemy]
    const damage: RuleDef = {
      name: 'contactDamage',
      schedule: 'event',
      on: 'Contact',
      self: 'event.a',
      other: 'event.b',
      query: ['CtHp'],
      when: "event.phase == 'begin'",
      actions: [{ set: 'CtHp.hp', expr: 'CtHp.hp - (other.CtDmg.amount ?? 1)' }],
    }
    const errors = installRules(w, [], (n) => types.find((t) => t.name === n)).update([damage])
    expect([...errors]).toEqual([])

    const player = w.spawn([entry(Pos, { x: 0, y: 0 }), entry(Player, { p: 1 }), entry(Hp, { hp: 10 })])
    // Two enemies sweep across the player; one stands still out of reach.
    w.spawn([entry(Pos, { x: -10, y: 0 }), entry(Vel, { vx: 1, vy: 0 }), entry(Enemy, { e: 1 }), entry(Dmg, { amount: 3 })])
    w.spawn([entry(Pos, { x: 30, y: 0 }), entry(Vel, { vx: -1, vy: 0 }), entry(Enemy, { e: 1 })])
    w.spawn([entry(Pos, { x: 0, y: 50 }), entry(Enemy, { e: 1 }), entry(Dmg, { amount: 100 })])

    const hp: number[] = []
    for (let i = 0; i < 40; i++) {
      step(w)
      hp.push(w.getComponent(player, Hp)!.hp)
    }
    // First enemy: begins at x = -2 (step 8), damage applies on delivery (step 9).
    expect(hp.indexOf(7)).toBe(8)
    expect(hp[hp.length - 1]).toBe(6)
    expect(new Set(hp)).toEqual(new Set([10, 7, 6]))
  })

  it('defaults: fixed schedule, priority 150 (the contacts band), one system named for the plugin', () => {
    const w = createWorld({ headless: true })
    w.use(installContacts({ position: { component: Pos }, radius: 1, pairs: [[Player, Enemy]] }))
    const sys = w.describe().systems.filter((s) => s.name.startsWith('domecs-scene:contacts'))
    expect(sys).toHaveLength(1)
    expect(sys[0]).toMatchObject({ name: 'domecs-scene:contacts', schedule: 'fixed', priority: 150 })

    const t = createWorld({ headless: true })
    t.use(
      installContacts({
        position: { component: Pos },
        radius: 1,
        pairs: [[Player, Enemy]],
        schedule: 'tick',
        priority: 7,
        name: 'hits',
      }),
    )
    expect(t.describe().systems.find((s) => s.name === 'hits')).toMatchObject({ schedule: 'tick', priority: 7 })
    const p = t.spawn([entry(Pos, { x: 0, y: 0 }), entry(Player, { p: 1 })])
    const e = t.spawn([entry(Pos, { x: 0, y: 0 }), entry(Enemy, { e: 1 })])
    t.stepOnce()
    expect(t.getResource(ContactState)!.pairs).toEqual([[p, e]])
  })

  it('a stepOnce never runs the default fixed contacts system', () => {
    const w = createWorld({ headless: true })
    w.use(installContacts({ position: { component: Pos }, radius: 1, pairs: [[Player, Enemy]] }))
    w.spawn([entry(Pos, { x: 0, y: 0 }), entry(Player, { p: 1 })])
    w.spawn([entry(Pos, { x: 0, y: 0 }), entry(Enemy, { e: 1 })])
    w.stepOnce()
    expect(w.getResource(ContactState)!.pairs).toEqual([])
    step(w)
    expect(w.getResource(ContactState)!.pairs).toHaveLength(1)
  })

  it('registers Contact (declared schema) and ContactState by name', () => {
    const w = createWorld({ headless: true })
    w.use(installContacts({ position: { component: Pos }, radius: 1, pairs: [[Player, Enemy]] }))
    expect(w.lookupEvent('Contact')).toBe(Contact)
    expect(w.lookupResource('ContactState')).toBe(ContactState)
    expect(w.describe().events.map((e) => e.name)).toContain('Contact')
    expect(validateEventPayload(Contact, { a: 1, b: 2, phase: 'begin' })).toBeNull()
    expect(validateEventPayload(Contact, { a: 1, b: 2, phase: 'touch' })).not.toBeNull()
    expect(validateEventPayload(Contact, { a: 1, b: 2, phase: 'end', extra: 1 })).not.toBeNull()
    // Registering touches no snapshot state.
    const fresh = createWorld({ headless: true })
    expect(hashSnapshot(w.snapshot())).toBe(hashSnapshot(fresh.snapshot()))
  })

  it('one contacts plugin per world; disposing stops detection', () => {
    const w = createWorld({ headless: true })
    const used = w.use(installContacts({ position: { component: Pos }, radius: 1, pairs: [[Player, Enemy]] }))
    expect(used.ok).toBe(true)
    expect(() =>
      w.use(installContacts({ position: { component: Pos }, radius: 1, pairs: [[Player, Pickup]], name: 'second' })),
    ).toThrow(/contacts/)
    w.spawn([entry(Pos, { x: 0, y: 0 }), entry(Player, { p: 1 })])
    w.spawn([entry(Pos, { x: 0, y: 0 }), entry(Enemy, { e: 1 })])
    if (used.ok) used.value()
    step(w)
    expect(w.getResource(ContactState)!.pairs).toEqual([])
    expect(w.describe().systems.some((s) => s.name.startsWith('domecs-scene:contacts'))).toBe(false)
  })

  it('rejects invalid options at the call', () => {
    const base: ContactsOptions = { position: { component: Pos }, radius: 1, pairs: [[Player, Enemy]] }
    expect(() => installContacts({ ...base, radius: -1 })).toThrow(RangeError)
    expect(() => installContacts({ ...base, radius: Number.NaN })).toThrow(RangeError)
    expect(() => installContacts({ ...base, radius: Number.POSITIVE_INFINITY })).toThrow(RangeError)
    expect(() => installContacts({ ...base, cellSize: 0 })).toThrow(RangeError)
    expect(() => installContacts({ ...base, schedule: 'event' as 'fixed' })).toThrow(/schedule/)
    expect(() => installContacts({ ...base, priority: Number.NaN })).toThrow(/priority/)
    expect(() => installContacts({ ...base, pairs: [[Player]] as never })).toThrow(/pairs/)
    expect(() => installContacts({ ...base, pairs: [] })).toThrow(/pairs/)
    expect(() => installContacts({ ...base, radius: { component: Body } as never })).toThrow(/radius/)
  })

  it('rejects options that are not component types (e.g. names) instead of never detecting anything', () => {
    const base: ContactsOptions = { position: { component: Pos }, radius: 1, pairs: [[Player, Enemy]] }
    // Rules name components by string; passing a name here must fail loudly.
    expect(() => installContacts({ ...base, pairs: [[Player, 'CtEnemy']] as never })).toThrow(TypeError)
    expect(() => installContacts({ ...base, pairs: [['CtPlayer', Enemy]] as never })).toThrow(/pairs/)
    expect(() => installContacts({ ...base, pairs: [[Player, {}]] as never })).toThrow(/pairs/)
    expect(() => installContacts({ ...base, position: { component: 'CtPos' } as never })).toThrow(/position/)
    expect(() => installContacts({ ...base, position: { component: Pos, x: 0 } as never })).toThrow(/position/)
    expect(() => installContacts({ ...base, position: { component: Pos, y: '' } })).toThrow(/position/)
    expect(() => installContacts({ ...base, radius: { component: 'CtBody', field: 'r' } as never })).toThrow(/radius/)
    expect(() => installContacts({ ...base, radius: { component: Body, field: '' } })).toThrow(/radius/)
    expect(() => installContacts({ ...base, name: '' })).toThrow(/name/)
    expect(() => installContacts({ ...base, name: 7 as never })).toThrow(/name/)
    expect(() => installContacts({ ...base, stay: 'yes' as never })).toThrow(/stay/)
    // Valid custom fields still install.
    const w = createWorld({ headless: true })
    const P2 = defineComponent<{ px: number; py: number }>('CtPos2', { defaults: { px: 0, py: 0 } })
    expect(w.use(installContacts({ ...base, position: { component: P2, x: 'px', y: 'py' } })).ok).toBe(true)
  })
})
