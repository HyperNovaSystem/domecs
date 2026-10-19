import { describe, expect, it } from 'vitest'
import { canonicalJson, hashSnapshot } from '../src/canonical.js'
import { defineComponent } from '../src/component.js'
import { mergeSortedRuns, SortedIdSet } from '../src/id-set.js'
import { defineEvent } from '../src/events.js'
import { Has, OnAdded, OnRemoved, Where } from '../src/query.js'
import { defineResource } from '../src/resource.js'
import { ok } from '../src/result.js'
import type { WorldSnapshot } from '../src/snapshot.js'
import { entry, type Entity } from '../src/types.js'
import { createWorld, type World } from '../src/world.js'

// O-40: a restored world continues exactly like the live one — the clock
// resumes from the snapshot's `scaledTime`, and query iteration follows
// ascending entity id (SPEC §8) on both the live and the restored side.

const Body = defineComponent<{ x: number }>('RcBody', { defaults: { x: 0 } })
const Hot = defineComponent<{ heat: number }>('RcHot', { defaults: { heat: 0 } })
const Tally = defineComponent<{ slow: number; ignitions: number; seq: number }>('RcTally', {
  defaults: { slow: 0, ignitions: 0, seq: 0 },
})
const Mark = defineComponent<{ r: number }>('RcMark', { defaults: { r: 0 } })

// Non-ms-exact and multi-fixed-step frames, cycled.
const DTS = [1 / 60, 0.021, 1 / 144, 0.0333, 0.004, 0.05, 0.0171]

/**
 * Registers a sim whose future depends on everything restore must carry:
 * fixed-step phase (a divisor-rate fixed system), per-entity RNG draws in
 * query order over entities that join out of id order, spawns/despawns, and
 * an order-sensitive reactive hash. No closure state, no `once` systems.
 */
function build(w: World): void {
  const tally = (): { slow: number; ignitions: number; seq: number } =>
    w.getComponent(w.listEntities([Tally])[0]!, Tally)!

  w.system('physics', { schedule: 'fixed', query: [Body] }, ({ entities }) => {
    for (const e of entities) w.getComponent(e.id, Body)!.x += 1
  })
  w.system('slow', { schedule: 'fixed', rateHz: 20 }, () => {
    tally().slow += 1
  })
  w.system('ignite', {}, ({ rand }) => {
    const bodies = w.listEntities([Body])
    const pick = bodies[rand.uniformInt(bodies.length)]!
    if (w.has(pick, Hot)) w.removeComponent(pick, Hot)
    else w.addComponent(pick, Hot, { heat: 0 })
  })
  w.system('heat', { query: [Body, Hot] }, ({ entities, rand }) => {
    for (const e of entities) w.getComponent(e.id, Hot)!.heat += rand.uniformInt(100)
  })
  w.system('churn', {}, ({ time }) => {
    if (time.tick % 5 === 0) w.spawn([entry(Body, { x: 0 })])
    if (time.tick % 7 === 0) {
      const bodies = w.listEntities([Body])
      if (bodies.length > 3) w.despawn(bodies[1]!)
    }
  })
  w.system('ignitions', { schedule: 'reactive', reactsTo: OnAdded(Hot) }, ({ entities }) => {
    const t = tally()
    for (const e of entities) {
      t.ignitions += 1
      t.seq = (t.seq * 31 + e.id) % 1_000_000_007
    }
  })
}

function seedWorld(w: World): void {
  w.spawn([entry(Tally, { slow: 0, ignitions: 0, seq: 0 })])
  for (let i = 0; i < 6; i++) w.spawn([entry(Body, { x: i })])
}

interface Frame {
  snap: string
  elapsed: number
  fixedAccumulator: number
}

function run(w: World, from: number, steps: number): Frame[] {
  const frames: Frame[] = []
  for (let i = 0; i < steps; i++) {
    w.step(DTS[(from + i) % DTS.length]!)
    frames.push({
      snap: JSON.stringify(w.snapshot()),
      elapsed: w.time.elapsed,
      fixedAccumulator: w.time.fixedAccumulator,
    })
  }
  return frames
}

describe('restore continuity — lockstep (O-40)', () => {
  it('a fresh twin restored from a JSON round-tripped snapshot tracks the live world', () => {
    const live = createWorld({ headless: true, seed: 11 })
    build(live)
    seedWorld(live)
    run(live, 0, 25)
    const snap = JSON.parse(JSON.stringify(live.snapshot())) as WorldSnapshot
    const expected = run(live, 25, 40)

    const twin = createWorld({ headless: true, seed: 999 })
    build(twin)
    twin.restore(snap)
    const actual = run(twin, 25, 40)

    expect(actual).toEqual(expected)
  })

  it('rewinding the same world replays the identical future', () => {
    const w = createWorld({ headless: true, seed: 5 })
    build(w)
    seedWorld(w)
    run(w, 0, 25)
    const snap = w.snapshot()
    const first = run(w, 25, 40)
    w.restore(snap)
    const second = run(w, 25, 40)
    expect(second).toEqual(first)
  })
})

describe('restore continuity — clock (O-40)', () => {
  it('resumes elapsed, accumulator, and fixed-step phase', () => {
    const mk = (): { w: World; fired: () => number } => {
      const w = createWorld({ headless: true })
      w.system('count', { schedule: 'fixed' }, () => {
        const id = w.listEntities([Mark])[0]!
        w.getComponent(id, Mark)!.r += 1
      })
      return { w, fired: () => w.getComponent(w.listEntities([Mark])[0]!, Mark)!.r }
    }
    const a = mk()
    a.w.spawn([entry(Mark, { r: 0 })])
    for (let i = 0; i < 3; i++) a.w.step(0.01)
    const snap = a.w.snapshot()
    expect(snap.scaledTime).toBeCloseTo(0.03)

    const b = mk()
    b.w.restore(snap)
    expect(b.w.time.elapsed).toBe(a.w.time.elapsed)
    expect(b.w.time.fixedAccumulator).toBe(a.w.time.fixedAccumulator)

    a.w.step(0.01)
    b.w.step(0.01)
    expect(b.fired()).toBe(a.fired())
    expect(b.w.time.elapsed).toBe(a.w.time.elapsed)
  })

  it('keeps a divisor-rate fixed system on the live phase', () => {
    const mk = (): { w: World; fires: number[] } => {
      const w = createWorld({ headless: true, fixedStep: 1 / 60 })
      const fires: number[] = []
      w.system('every3', { schedule: 'fixed', rateHz: 20 }, ({ time }) => {
        fires.push(time.tick)
      })
      return { w, fires }
    }
    const a = mk()
    for (let i = 0; i < 4; i++) a.w.step(1 / 60) // 4 fixed steps: phase 1 of 3
    const snap = a.w.snapshot()
    a.fires.length = 0
    for (let i = 0; i < 6; i++) a.w.step(1 / 60)

    const b = mk()
    b.w.restore(snap)
    for (let i = 0; i < 6; i++) b.w.step(1 / 60)
    expect(b.fires).toEqual(a.fires)
  })

  it('starts the clock at zero for snapshots without scaledTime (older builds)', () => {
    const w = createWorld({ headless: true })
    w.step(0.5)
    const { scaledTime: _omit, ...legacy } = w.snapshot()
    w.step(0.5)
    w.restore(legacy)
    expect(w.time.elapsed).toBe(0)
    expect(w.time.fixedAccumulator).toBe(0)
    w.step(0.25)
    expect(w.time.elapsed).toBe(0.25)
  })

  it('rejects an invalid scaledTime before touching the world', () => {
    const w = createWorld({ headless: true })
    const e = w.spawn([entry(Mark, { r: 7 })])
    w.step(0.1)
    const good = w.snapshot()
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, '3' as unknown as number]) {
      expect(() => w.restore({ ...good, entities: [], scaledTime: bad })).toThrow(/scaledTime/)
      expect(w.getComponent(e, Mark)).toEqual({ r: 7 })
      expect(w.time.tick).toBe(1)
      expect(w.time.elapsed).toBe(0.1)
    }
  })

  it('re-derives the fixed-step count when the restoring world uses another fixedStep', () => {
    const live = createWorld({ headless: true, fixedStep: 1 / 60 })
    for (let i = 0; i < 600; i++) live.step(1 / 60) // 10 s of scaled time
    const snap = live.snapshot()

    for (const fixedStep of [1 / 120, 1 / 30]) {
      const w = createWorld({ headless: true, fixedStep })
      let n = 0
      w.system('f', { schedule: 'fixed' }, () => {
        n += 1
      })
      w.restore(snap)
      w.step(fixedStep)
      expect(n).toBe(1) // no catch-up burst, no stall
      expect(w.time.elapsed).toBeCloseTo(10 + fixedStep, 2)
    }
  })
})

describe('restore continuity — fixed-step backlog (O-40)', () => {
  // A tickStart hook that pauses lets time advance without running the
  // frame's fixed steps; the live world runs them after resume.
  function mk(): { w: World; fired: () => number; pauseNext: () => void } {
    const w = createWorld({ headless: true, fixedStep: 0.1 })
    let fired = 0
    let pauseNext = false
    w.system('count', { schedule: 'fixed' }, () => {
      fired += 1
    })
    w.signals.tickStart.subscribe(() => {
      if (pauseNext) {
        pauseNext = false
        w.pause()
      }
    })
    return { w, fired: () => fired, pauseNext: () => (pauseNext = true) }
  }

  it('records owed steps and runs them after resume, like the live world', () => {
    const live = mk()
    live.pauseNext()
    live.w.step(0.25) // 2 steps due, none run
    const snap = live.w.snapshot()
    expect(snap.fixedBacklog).toBe(2)
    expect(snap.fixedStep).toBe(0.1)

    const twin = mk()
    twin.w.restore(JSON.parse(JSON.stringify(snap)) as WorldSnapshot)
    expect(twin.w.time.fixedAccumulator).toBe(live.w.time.fixedAccumulator)

    for (const { w } of [live, twin]) {
      w.resume()
      w.step(0.05)
    }
    expect(twin.fired()).toBe(live.fired())
    expect(live.fired()).toBe(3)
  })

  it('carries the owed time, not the step count, into a world with another fixedStep', () => {
    const live = mk()
    live.w.step(0.25) // 2 steps run, 0.05 s left over
    live.pauseNext()
    live.w.step(0.25) // 3 more due, none run: 0.3 s owed
    const snap = live.w.snapshot()
    expect(snap.fixedBacklog).toBe(3)
    const owed = live.w.time.fixedAccumulator
    expect(owed).toBeCloseTo(0.3, 9)
    live.w.resume()
    live.w.step(0.05)
    const liveRan = (live.fired() - 2) * 0.1 // fixed time run after resume

    for (const fixedStep of [0.05, 0.2]) {
      const w = createWorld({ headless: true, fixedStep })
      let n = 0
      w.system('count', { schedule: 'fixed' }, () => {
        n += 1
      })
      w.restore(snap)
      expect(w.time.fixedAccumulator).toBeCloseTo(owed, 9)
      w.step(0.05)
      // Same fixed time run plus left over as the live world, in other steps.
      expect(n * fixedStep + w.time.fixedAccumulator).toBeCloseTo(
        liveRan + live.w.time.fixedAccumulator,
        9,
      )
    }
  })

  it('omits fixedBacklog and fixedStep after an ordinary tick', () => {
    const { w } = mk()
    w.step(0.25)
    const snap = w.snapshot()
    expect('fixedBacklog' in snap).toBe(false)
    expect('fixedStep' in snap).toBe(false)
  })

  it('rejects an invalid fixedBacklog or fixedStep', () => {
    const { w } = mk()
    const snap = w.snapshot()
    for (const bad of [-1, 1.5, Number.NaN, null as unknown as number]) {
      expect(() => w.restore({ ...snap, fixedBacklog: bad })).toThrow(/fixedBacklog/)
    }
    for (const bad of [0, -0.1, Number.POSITIVE_INFINITY, null as unknown as number]) {
      expect(() => w.restore({ ...snap, fixedBacklog: 1, fixedStep: bad })).toThrow(/fixedStep/)
    }
  })
})

describe('restore — validation before anything is touched (O-40)', () => {
  it('rejects scaledTime: null instead of reading it as absent', () => {
    const w = createWorld({ headless: true })
    const e = w.spawn([entry(Mark, { r: 1 })])
    const snap = w.snapshot()
    expect(() =>
      w.restore({ ...snap, entities: [], scaledTime: null as unknown as number }),
    ).toThrow(/scaledTime/)
    expect(w.getComponent(e, Mark)).toEqual({ r: 1 })
  })

  it('keeps pending events, and drops what onRestore emitted, when the envelope is invalid', () => {
    const Ping = defineEvent<number>('RcPing')
    const w = createWorld({ headless: true })
    w.use({
      name: 'rc-spy',
      install: () =>
        ok({
          onRestore: (snap: WorldSnapshot) => {
            w.emit(Ping, 99)
            return snap
          },
        }),
    })
    const pings: number[] = []
    w.on(Ping, (n) => pings.push(n))
    const snap = w.snapshot()
    w.emit(Ping, 7)
    expect(() => w.restore({ ...snap, scaledTime: -1 })).toThrow(/scaledTime/)
    w.stepOnce()
    expect(pings).toEqual([7])

    // A valid restore discards the pending event and keeps the hook's.
    w.emit(Ping, 8)
    w.restore(snap)
    w.stepOnce()
    expect(pings).toEqual([7, 99])
  })

  it('keeps pending events when an onRestore hook throws', () => {
    const Ping = defineEvent<number>('RcPingThrow')
    const w = createWorld({ headless: true })
    w.use({
      name: 'rc-throw',
      install: () =>
        ok({
          onRestore: (): WorldSnapshot => {
            throw new Error('hook failed')
          },
        }),
    })
    const pings: number[] = []
    w.on(Ping, (n) => pings.push(n))
    const snap = w.snapshot()
    w.emit(Ping, 7)
    expect(() => w.restore(snap)).toThrow(/hook failed/)
    w.stepOnce()
    expect(pings).toEqual([7])
  })

  it('validates the envelope the onRestore hooks produce, so a codec plugin round-trips', () => {
    // onSnapshot encodes a resource value its validator would reject;
    // onRestore decodes it. Only the decoded envelope must be valid.
    const Hp = defineResource<number>('RcCodecHp', {
      default: 10,
      validate: (v) => (typeof v === 'number' ? true : 'must be a number'),
    })
    const codec = {
      name: 'rc-codec',
      install: () =>
        ok({
          onSnapshot: (snap: WorldSnapshot): WorldSnapshot => ({
            ...snap,
            resources: { ...snap.resources, RcCodecHp: `hp:${String(snap.resources?.RcCodecHp)}` },
          }),
          onRestore: (snap: WorldSnapshot): WorldSnapshot => ({
            ...snap,
            resources: {
              ...snap.resources,
              RcCodecHp: Number(String(snap.resources?.RcCodecHp).slice(3)),
            },
          }),
        }),
    }
    const w = createWorld({ headless: true })
    w.use(codec)
    w.setResource(Hp, 5)
    const snap = w.snapshot()
    expect(snap.resources?.RcCodecHp).toBe('hp:5')
    w.setResource(Hp, 6)
    w.restore(snap)
    expect(w.getResource(Hp)).toBe(5)
  })
})

describe('query iteration order — ascending entity id (SPEC §8, O-40)', () => {
  function outOfOrder(): { w: World; ids: Entity[] } {
    const w = createWorld({ headless: true })
    const ids = [w.spawn(), w.spawn(), w.spawn(), w.spawn()]
    // Join Mark in reverse id order.
    for (const id of [...ids].reverse()) w.addComponent(id, Mark, { r: 0 })
    return { w, ids }
  }

  it('live query().entities iterates by id, not join order', () => {
    const { w, ids } = outOfOrder()
    const q = w.query([Mark])
    expect(q.entities.map((v) => v.id)).toEqual(ids)
    const late = w.query([Mark])
    w.removeComponent(ids[1]!, Mark)
    w.addComponent(ids[1]!, Mark, { r: 1 })
    expect(late.entities.map((v) => v.id)).toEqual(ids)
  })

  it('live order matches the order after restore, so RNG draws match', () => {
    const roll = (w: World): void => {
      w.system('roll', { query: [Mark] }, ({ entities, rand }) => {
        for (const e of entities) w.getComponent(e.id, Mark)!.r = rand.uniformInt(1000)
      })
    }
    const { w: live } = outOfOrder()
    roll(live)
    const snap = live.snapshot()
    live.stepOnce()

    const twin = createWorld({ headless: true })
    roll(twin)
    twin.restore(snap)
    twin.stepOnce()
    expect(twin.snapshot().entities).toEqual(live.snapshot().entities)
  })

  it('listEntities / selectViews return ascending ids across archetypes', () => {
    const w = createWorld({ headless: true })
    const a = w.spawn([entry(Mark, { r: 0 })])
    const b = w.spawn([entry(Mark, { r: 0 }), entry(Hot, { heat: 0 })])
    const c = w.spawn([entry(Mark, { r: 0 })])
    w.addComponent(a, Hot, { heat: 0 }) // a now joins b's archetype after it
    expect(w.listEntities([Mark])).toEqual([a, b, c])
    expect(w.selectViews(Has(Mark)).map((v) => v.id)).toEqual([a, b, c])
    expect(w.listEntities([Hot])).toEqual([a, b])
  })

  it('iterEntitiesWith yields ascending ids, live and after restore', () => {
    const { w, ids } = outOfOrder()
    expect([...w.iterEntitiesWith(Mark)].map((x) => x.id)).toEqual(ids)
    const twin = createWorld({ headless: true })
    twin.restore(w.snapshot())
    expect([...twin.iterEntitiesWith(Mark)].map((x) => x.id)).toEqual(ids)
  })

  it('Where predicates run in id order across archetypes, so rand-drawing predicates match after restore', () => {
    const pick = (w: World): { ids: Entity[]; visited: Entity[]; count: number } => {
      const visited: Entity[] = []
      const where = Where(Mark, () => w.rand.uniformInt(2) === 0)
      const ids = w.listEntities(where)
      const count = w.countEntities(
        Where(Mark, (m) => {
          visited.push(m.r)
          return true
        }),
      )
      return { ids, visited, count }
    }
    const live = createWorld({ headless: true, seed: 42 })
    const a = live.spawn([entry(Mark, { r: 0 })])
    const b = live.spawn([entry(Mark, { r: 1 }), entry(Hot, { heat: 0 })])
    live.addComponent(a, Hot, { heat: 0 }) // a joins b's archetype after b
    live.spawn([entry(Mark, { r: 2 })])
    const snap = live.snapshot()
    const twin = createWorld({ headless: true })
    twin.restore(snap)
    const l = pick(live)
    const t = pick(twin)
    expect(l.visited).toEqual([0, 1, 2])
    expect(t).toEqual(l)
    expect(b).toBeGreaterThan(a)
  })

  it('OnRemoved deltas list despawned entities by id', () => {
    const w = createWorld({ headless: true })
    const ids = [0, 1, 2, 3, 4, 5].map(() => w.spawn([entry(Mark, { r: 0 })]))
    let seen: Entity[] = []
    w.system('kill', {}, () => {
      if (w.time.tick === 1) {
        w.despawn(ids[5]!)
        w.despawn(ids[2]!)
      }
    })
    w.system('removed', { schedule: 'reactive', reactsTo: OnRemoved(Mark) }, ({ entities }) => {
      seen = entities.map((e) => e.id)
    })
    w.stepOnce()
    expect(seen).toEqual([ids[2], ids[5]])
  })
})

describe('SortedIdSet', () => {
  it('iterates ascending regardless of insertion order', () => {
    const s = new SortedIdSet()
    for (const id of [5, 1, 9, 3, 7]) s.add(id)
    expect([...s]).toEqual([1, 3, 5, 7, 9])
    expect(s.size).toBe(5)
    expect(s.has(3)).toBe(true)
  })

  it('handles delete, re-add of a stale id, and duplicates', () => {
    const s = new SortedIdSet()
    for (const id of [1, 5, 9]) s.add(id)
    s.delete(5)
    s.add(5) // below tail 9 and still present (stale) in the sorted run
    s.add(5) // duplicate add is a no-op
    s.add(3)
    s.delete(3)
    s.add(3)
    expect([...s]).toEqual([1, 3, 5, 9])
    expect(s.size).toBe(4)
    s.delete(9)
    s.add(10)
    s.add(2)
    expect([...s]).toEqual([1, 2, 3, 5, 10])
    expect(s.delete(42)).toBe(false)
    s.clear()
    expect([...s]).toEqual([])
    expect(s.size).toBe(0)
  })

  it('iterates the members as of the call', () => {
    const s = new SortedIdSet()
    for (const id of [1, 3, 5]) s.add(id)
    const seen: number[] = []
    for (const id of s) {
      seen.push(id)
      if (id === 1) {
        s.delete(3) // still yielded: it was a member when iteration began
        s.add(9) // tail append: not yielded
        s.add(2) // late insert: not yielded
      }
    }
    expect(seen).toEqual([1, 3, 5])
    expect([...s]).toEqual([1, 2, 5, 9])
  })

  it('keeps the backlog bounded for a set nobody iterates', () => {
    const s = new SortedIdSet()
    for (let id = 0; id < 1000; id++) s.add(id)
    for (let round = 0; round < 200; round++) {
      for (let id = 0; id < 1000; id += 7) {
        s.delete(id)
        s.add(id)
      }
    }
    const internals = s as unknown as { sorted: number[]; late: number[]; gone: number[] }
    expect(internals.late.length + internals.gone.length).toBeLessThanOrEqual(64 + 500 + 1)
    expect(internals.sorted.length).toBeLessThan(2000)
    expect([...s]).toEqual(Array.from({ length: 1000 }, (_, i) => i))
  })

  it('matches a reference model under random operations', () => {
    let state = 0x9e3779b9
    const next = (n: number): number => {
      // xorshift32 — integer-exact, unlike a float LCG.
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return (state >>> 0) % n
    }
    const s = new SortedIdSet()
    const model = new Set<number>()
    let reads = 0
    for (let i = 0; i < 20_000; i++) {
      const id = next(200)
      const op = next(10)
      if (op < 5) {
        s.add(id)
        model.add(id)
      } else if (op < 9) {
        expect(s.delete(id)).toBe(model.delete(id))
      } else {
        reads += 1
        expect([...s]).toEqual([...model].sort((a, b) => a - b))
      }
      expect(s.size).toBe(model.size)
    }
    expect(reads).toBeGreaterThan(1000)
  })
})

describe('mergeSortedRuns', () => {
  it('merges dense and sparse disjoint runs into ascending order', () => {
    const dense = [[0, 4, 8], [1, 5], [], [2, 3, 6, 7]]
    expect(mergeSortedRuns(dense)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    const sparse = [[5, 1000], [3, 70_000], [900]]
    expect(mergeSortedRuns(sparse)).toEqual([3, 5, 900, 1000, 70_000])
    expect(mergeSortedRuns([])).toEqual([])
    expect(mergeSortedRuns([[], []])).toEqual([])
    const only = [1, 2]
    const copy = mergeSortedRuns([only])
    expect(copy).toEqual([1, 2])
    expect(copy).not.toBe(only)
  })
})

// E18.1 (found by the 2.3 fork-equivalence suite): an entity's component
// order was the order its archetype was first built in, which is history:
// live, the order components were added; after a restore from canonicalJson
// text (sorted keys), name order. A despawn records one removal mark per
// component in that order, so a fork restored from text and the live world
// carried the same marks in different orders and their strict hashes
// differed. Archetypes now keep their component names sorted.
describe('component order within an entity — by name, not history (E18.1)', () => {
  const Zeta = defineComponent<{ z: number }>('RcZeta', { defaults: { z: 0 } })
  const Alpha = defineComponent<{ a: number }>('RcAlpha', { defaults: { a: 0 } })
  const Mid = defineComponent<{ m: number }>('RcMid', { defaults: { m: 0 } })

  const build = (): World => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    // An OnRemoved reader keeps removal marks in the snapshot until it runs.
    w.system('reader', { query: OnRemoved(Alpha) }, () => {})
    return w
  }
  const strict = (w: World): string => hashSnapshot(w.snapshot(), { includeChanges: true })

  it('a despawn after a restore from canonicalJson text records removals like the live world', () => {
    const live = build()
    const id = live.spawn([entry(Zeta, { z: 1 }), entry(Mid, { m: 2 }), entry(Alpha, { a: 3 })])
    live.stepOnce()
    const fork = build()
    fork.restore(JSON.parse(canonicalJson(live.snapshot())) as WorldSnapshot)
    expect(strict(fork)).toBe(strict(live))
    live.despawn(id)
    fork.despawn(id)
    expect(live.snapshot().changes?.marks).toEqual([
      ['removed', 'RcAlpha', id],
      ['removed', 'RcMid', id],
      ['removed', 'RcZeta', id],
    ])
    expect(strict(fork)).toBe(strict(live))
  })

  it('archetype(), componentRemoved and snapshot keys follow names, whatever the add order', () => {
    const w = build()
    const a = w.spawn([entry(Zeta, { z: 0 }), entry(Alpha, { a: 0 })])
    const b = w.spawn([entry(Alpha, { a: 0 })])
    w.addComponent(b, Mid, { m: 0 })
    w.addComponent(b, Zeta, { z: 0 })
    expect(w.archetype(a).map((t) => t.name)).toEqual(['RcAlpha', 'RcZeta'])
    expect(w.archetype(b).map((t) => t.name)).toEqual(['RcAlpha', 'RcMid', 'RcZeta'])
    expect(Object.keys(w.snapshot().entities.find((e) => e.id === a)!.components)).toEqual(['RcAlpha', 'RcZeta'])
    const removed: string[] = []
    w.signals.componentRemoved.subscribe(({ type }) => void removed.push(type.name))
    w.despawn(b)
    expect(removed).toEqual(['RcAlpha', 'RcMid', 'RcZeta'])
  })
})
