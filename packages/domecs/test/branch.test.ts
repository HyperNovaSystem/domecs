import { describe, expect, it } from 'vitest'
import {
  createBranch,
  createWorld,
  defineComponent,
  defineEvent,
  entry,
  hashSnapshot,
} from '../src/index.js'
import type { World, WorldSnapshot } from '../src/index.js'

// §7.2 (G3; O-81): a branch is a fresh headless world built by the source's
// setup and restored from one of its snapshots, stepped without touching the
// live world.

const strict = (w: World): string => hashSnapshot(w.snapshot({ pendingEvents: true }), { includeChanges: true })

const Body = defineComponent<{ x: number; v: number }>('BrBody', { defaults: { x: 0, v: 1 } })
const Stats = defineComponent<{ t: number; hits: number; r: number; fixed: number }>('BrStats', {
  defaults: { t: 0, hits: 0, r: 0, fixed: 0 },
})
const Hit = defineEvent<{ amount: number }>('BrHit', { schema: { fields: { amount: { kind: 'number' } } } })

/** The source's setup: tick, fixed, event and own-stream systems; spawns nothing. */
function setup(w: World): void {
  w.register(Hit, Body, Stats)
  w.system('move', { schedule: 'fixed', query: [Body] }, (ctx) => {
    for (const e of ctx.entities) {
      e.BrBody!.x += e.BrBody!.v * ctx.time.fixedStep
      w.markChanged(e.id, Body)
    }
    for (const id of w.listEntities([Stats])) w.getComponent(id, Stats)!.fixed += 1
  })
  w.system('clock', { query: [Stats] }, (ctx) => {
    for (const e of ctx.entities) {
      e.BrStats!.t += ctx.time.scaledDelta
      w.markChanged(e.id, Stats)
    }
  })
  w.system('noise', { rng: 'own', query: [Stats] }, (ctx) => {
    for (const e of ctx.entities) e.BrStats!.r = ctx.rand.uniform()
  })
  w.system('hits', { schedule: 'event', triggers: [Hit] }, (ctx) => {
    for (const h of ctx.events.of(Hit)) {
      for (const id of w.listEntities([Stats])) w.getComponent(id, Stats)!.hits += h.amount
    }
  })
}

function source(seed: [number, number, number, number] = [9, 8, 7, 6]): World {
  const w = createWorld({ headless: true, seed })
  setup(w)
  w.spawn([entry(Body, { x: 0, v: 2 })])
  w.spawn([entry(Body, { x: 5, v: -1 }), entry(Stats, { t: 0, hits: 0, r: 0, fixed: 0 })])
  return w
}

function steps(w: World, n: number, dt = 1 / 60): void {
  for (let i = 0; i < n; i++) w.step(dt)
}

describe('createBranch (§7.2)', () => {
  it('builds a headless world, runs setup, restores the snapshot and returns setup output', () => {
    const live = source()
    steps(live, 30)
    live.emit(Hit, { amount: 2 })
    const snap = live.snapshot({ pendingEvents: true })
    const r = createBranch((w) => {
      setup(w)
      return { tag: 'built', entities: w.listEntities([Body]).length }
    }, snap)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // setup ran before the restore (it spawns nothing; the restore brings the entities).
    expect(r.value.setup).toEqual({ tag: 'built', entities: 0 })
    expect(r.value.world.time.tick).toBe(30)
    expect(r.value.world.time.scale).toBe(1)
    expect(strict(r.value.world)).toBe(strict(live))
    // The live world is untouched by the branch stepping.
    const before = strict(live)
    steps(r.value.world, 5)
    expect(strict(live)).toBe(before)
  })

  it('fixedStep defaults to from.fixedStep, then 1/60; the option overrides', () => {
    const live = source()
    steps(live, 3)
    const snap = live.snapshot({ pendingEvents: true })
    expect(snap.fixedStep).toBeUndefined()
    const plain = createBranch(setup, snap)
    expect(plain.ok && plain.value.world.time.fixedStep).toBe(1 / 60)
    const opt = createBranch(setup, snap, { fixedStep: 1 / 30 })
    expect(opt.ok && opt.value.world.time.fixedStep).toBe(1 / 30)
    const withStep: WorldSnapshot = { ...snap, fixedStep: 1 / 120 }
    const fromSnap = createBranch(setup, withStep)
    expect(fromSnap.ok && fromSnap.value.world.time.fixedStep).toBe(1 / 120)
  })

  it('seed is the root for own streams when `from` has no rngRoot (a v2 snapshot)', () => {
    const seed: [number, number, number, number] = [4, 3, 2, 1]
    const live = source(seed)
    const snap = live.snapshot({ pendingEvents: true })
    const { rngRoot: _root, rngStreams: _streams, ...rest } = snap
    const v2: WorldSnapshot = { ...rest, version: 2 }
    const draw = (w: World): number => {
      w.step(1 / 60)
      return w.getComponent(w.listEntities([Stats])[0]!, Stats)!.r
    }
    const expected = draw(live)
    const seeded = createBranch(setup, v2, { seed })
    expect(seeded.ok && draw(seeded.value.world)).toBe(expected)
    const unseeded = createBranch(setup, v2)
    expect(unseeded.ok && draw(unseeded.value.world)).not.toBe(expected)
  })

  it('a setup with an enabled once system and from.tick > 0 is once_systems (test 7)', () => {
    const live = source()
    steps(live, 2)
    const snap = live.snapshot({ pendingEvents: true })
    const withOnce = (w: World): void => {
      setup(w)
      w.system('boot', { schedule: 'once' }, () => {})
      w.system('boot2', { schedule: 'once' }, () => {})
      w.system('off', { schedule: 'once' }, () => {}).disable()
    }
    expect(createBranch(withOnce, snap)).toEqual({ ok: false, error: { kind: 'once_systems', names: ['boot', 'boot2'] } })
    // At tick 0 the source had not run them either.
    const atZero = source().snapshot({ pendingEvents: true })
    expect(createBranch(withOnce, atZero).ok).toBe(true)
  })

  it('a source at scale 2 matches createBranch(…, { scale: 2 }), not the default (test 8)', () => {
    const live = source()
    live.setScale(2)
    steps(live, 10)
    const snap = live.snapshot({ pendingEvents: true })
    steps(live, 20)
    const scaled = createBranch(setup, snap, { scale: 2 })
    const plain = createBranch(setup, snap)
    if (!scaled.ok || !plain.ok) throw new Error('branch failed')
    expect(scaled.value.world.time.scale).toBe(2)
    expect(plain.value.world.time.scale).toBe(1)
    steps(scaled.value.world, 20)
    steps(plain.value.world, 20)
    expect(strict(scaled.value.world)).toBe(strict(live))
    expect(strict(plain.value.world)).not.toBe(strict(live))
  })

  it('a snapshot that fails validation is restore_failed with a serialized cause, no throw (test 6)', () => {
    const live = source()
    const snap = live.snapshot({ pendingEvents: true })
    const bad = { ...snap, entities: 'nope' } as unknown as WorldSnapshot
    const r = createBranch(setup, bad)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('restore_failed')
    if (r.error.kind !== 'restore_failed') return
    expect(typeof r.error.cause.message).toBe('string')
    expect(r.error.cause.message.length).toBeGreaterThan(0)
    // The cause is plain data.
    expect(JSON.parse(JSON.stringify(r.error.cause))).toEqual(r.error.cause)
  })

  it('a throwing setup propagates', () => {
    const snap = source().snapshot({ pendingEvents: true })
    expect(() =>
      createBranch(() => {
        throw new Error('setup bug')
      }, snap),
    ).toThrow('setup bug')
  })
})
