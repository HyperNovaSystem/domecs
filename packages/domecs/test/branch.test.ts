import { describe, expect, it } from 'vitest'
import {
  createBranch,
  createRecorder,
  createWorld,
  defineComponent,
  defineEvent,
  entry,
  hashSnapshot,
  runBranch,
} from '../src/index.js'
import type { ActLog, BranchRun, SystemicFault, World, WorldSnapshot } from '../src/index.js'

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

// ---------------------------------------------------------------------------
// runBranch (E20.2)
// ---------------------------------------------------------------------------

function branch(from: WorldSnapshot, s: (w: World) => void = setup): World {
  const r = createBranch(s, from)
  if (!r.ok) throw new Error(`branch failed: ${r.error.kind}`)
  return r.value.world
}

function run(w: World, options: Parameters<typeof runBranch>[1]): BranchRun {
  const r = runBranch(w, options)
  if (!r.ok) throw new Error(`runBranch failed: ${JSON.stringify(r.error)}`)
  return r.value
}

const statsOf = (w: World): { t: number; hits: number; r: number; fixed: number } =>
  w.getComponent(w.listEntities([Stats])[0]!, Stats)!

const probes = {
  r: (w: World) => statsOf(w).r,
  fixed: (w: World) => statsOf(w).fixed,
  hits: (w: World) => statsOf(w).hits,
}

/** A live world at tick 30 with an undelivered Hit, its snapshot, and the live world carried on to tick 120. */
function liveAt30(): { live: World; snap: WorldSnapshot } {
  const live = source()
  steps(live, 30)
  live.emit(Hit, { amount: 3 })
  const snap = live.snapshot({ pendingEvents: true })
  return { live, snap }
}

describe('runBranch (§7.2)', () => {
  it('a branch from the tick-30 snapshot stepped 90 ends at the live tick-120 hash (test 1)', () => {
    const { live, snap } = liveAt30()
    steps(live, 90)
    const w = branch(snap)
    const out = run(w, { steps: 90 })
    expect(out.ticks).toBe(90)
    expect(out.stoppedBy).toBe('steps')
    expect(w.time.tick).toBe(120)
    expect(out.finalHash).toBe(strict(live))
    expect(statsOf(w).hits).toBe(3)
    expect(out.samples).toEqual([])
    expect(out.keyframes).toEqual([])
    expect(out.hashes).toEqual([])
    expect(out.faults).toEqual([])
  })

  it('two branches from one snapshot are identical; one extra own-stream system leaves the others unchanged (test 2)', () => {
    const { snap } = liveAt30()
    const opts = { steps: 40, probes, hashEvery: 10 }
    const a = run(branch(snap), opts)
    const b = run(branch(snap), opts)
    expect(b).toEqual(a)
    let extraDraws = 0
    const withExtra = (w: World): void => {
      setup(w)
      w.system('extra', { rng: 'own' }, (ctx) => {
        extraDraws += ctx.rand.uniform()
      })
    }
    const c = run(branch(snap, withExtra), opts)
    expect(extraDraws).toBeGreaterThan(0)
    expect(c.samples).toEqual(a.samples)
  })

  it('runBranch(60) + runBranch(60) equals runBranch(120) (test 3)', () => {
    const { snap } = liveAt30()
    const once = branch(snap)
    const whole = run(once, { steps: 120, hashEvery: 20 })
    const twice = branch(snap)
    const first = run(twice, { steps: 60, hashEvery: 20 })
    const second = run(twice, { steps: 60, hashEvery: 20 })
    expect(second.finalHash).toBe(whole.finalHash)
    expect([...first.hashes, ...second.hashes]).toEqual(whole.hashes)
    expect(first.ticks + second.ticks).toBe(120)
  })

  it('until and shouldStop set stoppedBy and the tick, sampling the final tick (test 4)', () => {
    const { snap } = liveAt30()
    const untilRun = run(branch(snap), {
      steps: 100,
      probes,
      sampleEvery: 7,
      until: (w) => w.time.tick === 50,
    })
    expect(untilRun.stoppedBy).toBe('until')
    expect(untilRun.ticks).toBe(20)
    expect(untilRun.samples.map((s) => s.tick)).toEqual([37, 44, 50])

    let polls = 0
    const cancelled = branch(snap)
    const cancelRun = run(cancelled, {
      steps: 100,
      probes,
      sampleEvery: 7,
      shouldStop: () => ++polls > 10,
    })
    expect(cancelRun.stoppedBy).toBe('cancelled')
    expect(cancelRun.ticks).toBe(10)
    expect(cancelled.time.tick).toBe(40)
    expect(cancelRun.samples.map((s) => s.tick)).toEqual([37, 40])

    const stepsRun = run(branch(snap), { steps: 30, probes, sampleEvery: 7 })
    expect(stepsRun.stoppedBy).toBe('steps')
    expect(stepsRun.samples.map((s) => s.tick)).toEqual([37, 44, 51, 58, 60])
    // The last sample is not taken twice when the final step is a multiple.
    const even = run(branch(snap), { steps: 28, probes, sampleEvery: 7 })
    expect(even.samples.map((s) => s.tick)).toEqual([37, 44, 51, 58])
    // Probes sample every step by default; values are the probes' results.
    const every = run(branch(snap), { steps: 3, probes })
    expect(every.samples.map((s) => s.tick)).toEqual([31, 32, 33])
    expect(Object.keys(every.samples[0]!.values)).toEqual(['r', 'fixed', 'hits'])
    expect(every.samples[2]!.values.hits).toBe(3)
  })

  it('zero steps or an immediate cancel still samples the current state', () => {
    const { snap } = liveAt30()
    const zero = run(branch(snap), { steps: 0, probes })
    expect(zero).toMatchObject({ ticks: 0, stoppedBy: 'steps' })
    expect(zero.samples.map((s) => s.tick)).toEqual([30])
    const cancelled = run(branch(snap), { steps: 10, probes, shouldStop: () => true })
    expect(cancelled).toMatchObject({ ticks: 0, stoppedBy: 'cancelled' })
    expect(cancelled.samples.map((s) => s.tick)).toEqual([30])
  })

  it('dt: null steps with stepOnce; a dt steps with step(dt)', () => {
    const { snap } = liveAt30()
    const a = branch(snap)
    run(a, { steps: 5, dt: null })
    const b = branch(snap)
    for (let i = 0; i < 5; i++) b.stepOnce()
    expect(strict(a)).toBe(strict(b))
    const c = branch(snap)
    run(c, { steps: 5, dt: 1 / 30 })
    const d = branch(snap)
    steps(d, 5, 1 / 30)
    expect(strict(c)).toBe(strict(d))
  })

  it('keyframes and hashes every k steps of the call are strict and restorable', () => {
    const { live, snap } = liveAt30()
    const liveHashes: Array<{ tick: number; hash: string }> = []
    for (let i = 1; i <= 30; i++) {
      live.step(1 / 60)
      if (i % 10 === 0) liveHashes.push({ tick: live.time.tick, hash: strict(live) })
    }
    const out = run(branch(snap), { steps: 30, keyframeEvery: 15, hashEvery: 10 })
    expect(out.hashes).toEqual(liveHashes)
    expect(out.keyframes.map((k) => k.tick)).toEqual([45, 60])
    // A keyframe restores to the state the branch had at that tick.
    const resumed = branch(out.keyframes[0]!.snapshot)
    const rest = run(resumed, { steps: 15 })
    expect(rest.finalHash).toBe(out.finalHash)
  })

  it('a log with acts at ticks equals a live world receiving the same acts (test 5)', () => {
    const { live, snap } = liveAt30()
    const rec = createRecorder(live)
    for (let i = 0; i < 40; i++) {
      if (i % 6 === 0) live.action(Hit, { amount: i + 1 })
      if (i === 20) live.setScale(2)
      if (i % 4 === 0) live.stepOnce()
      else live.step(1 / 60)
    }
    const log = rec.stop()
    // action() also steps the world (it consumes a turn), so there are more frames than loop turns.
    expect(log.frames.length).toBe(live.time.tick - 30)
    expect(log.frames.filter((f) => f.acts !== undefined).length).toBe(7)
    const out = run(branch(snap), { steps: log.frames.length, log })
    expect(out.finalHash).toBe(strict(live))
    // Without the log the branch does not reach the live state.
    expect(run(branch(snap), { steps: log.frames.length }).finalHash).not.toBe(strict(live))

    // A hand-written log: only the frames that carry acts; the other steps use dt.
    const live2 = liveAt30().live
    steps(live2, 10)
    live2.emit(Hit, { amount: 7 })
    steps(live2, 15)
    live2.action(Hit, { amount: 1 }) // emits, then takes its turn with stepOnce()
    steps(live2, 5)
    expect(live2.time.tick).toBe(61)
    const sparse: ActLog = {
      format: 'domecs-actlog',
      version: 1,
      startTick: 30,
      fixedStep: 1 / 60,
      startScale: 1,
      baseHash: '',
      frames: [
        { tick: 40, dt: 1 / 60, acts: [{ event: 'BrHit', payload: { amount: 7 }, via: 'emit' }] },
        { tick: 55, dt: null, acts: [{ event: 'BrHit', payload: { amount: 1 }, via: 'action' }] },
      ],
    }
    const out2 = run(branch(snap), { steps: 31, log: JSON.parse(JSON.stringify(sparse)) as ActLog })
    expect(out2.finalHash).toBe(strict(live2))
  })

  it('log errors are ReplayError values, not throws', () => {
    const { snap } = liveAt30()
    const base: ActLog = {
      format: 'domecs-actlog',
      version: 1,
      startTick: 30,
      fixedStep: 1 / 60,
      startScale: 1,
      baseHash: '',
      frames: [{ tick: 32, dt: 1 / 60, acts: [{ event: 'BrNope', via: 'emit' }] }],
    }
    const w = branch(snap)
    expect(runBranch(w, { steps: 5, log: base })).toEqual({
      ok: false,
      error: { kind: 'unknown_event', event: 'BrNope', tick: 32 },
    })
    const rejected = { ...base, frames: [{ tick: 30, dt: null, acts: [{ event: 'BrHit', payload: { amount: 'x' }, via: 'action' as const }] }] }
    const r = runBranch(branch(snap), { steps: 5, log: rejected })
    expect(r.ok === false && r.error.kind).toBe('rejected_payload')
    const bad = { ...base, version: 2 } as unknown as ActLog
    const r2 = runBranch(branch(snap), { steps: 5, log: bad })
    expect(r2.ok === false && r2.error.kind).toBe('invalid_log')
    const otherStep = { ...base, frames: [], fixedStep: 1 / 30 }
    const r3 = runBranch(branch(snap), { steps: 5, log: otherStep })
    expect(r3.ok === false && r3.error.kind).toBe('invalid_log')
  })

  it('collects faults from signals.faultRaised for the call only (test 6)', () => {
    const { snap } = liveAt30()
    const faulty = (w: World): void => {
      setup(w)
      w.system('flaky', {}, (ctx) =>
        ctx.time.tick % 5 === 0
          ? { errors: [{ error: { kind: 'persist_io', op: 'save', cause: { message: `at ${ctx.time.tick}` } }, recoverable: true }] }
          : undefined,
      )
    }
    const w = branch(snap, faulty)
    const later: SystemicFault[] = []
    const first = run(w, { steps: 10 })
    expect(first.faults.map((f) => f.source)).toEqual(['flaky', 'flaky'])
    expect(first.faults.map((f) => f.entry.kind)).toEqual(['persist_io', 'persist_io'])
    const second = run(w, { steps: 5 })
    expect(second.faults).toHaveLength(1)
    // No subscription is left behind.
    w.signals.faultRaised.subscribe((f) => later.push(f))
    steps(w, 5)
    expect(later).toHaveLength(1)
  })

  it('probe values are copies of plain data', () => {
    const { snap } = liveAt30()
    const out = run(branch(snap), { steps: 2, probes: { stats: (w) => statsOf(w) as unknown as never } })
    const first = out.samples[0]!.values.stats as { fixed: number }
    expect(first).not.toBe(out.samples[1]!.values.stats)
    expect(first.fixed).toBeLessThan((out.samples[1]!.values.stats as { fixed: number }).fixed)
  })

  it('a probe that mutates the world is flagged at the first sample', () => {
    const { snap } = liveAt30()
    const w = branch(snap)
    expect(() =>
      runBranch(w, {
        steps: 5,
        probes: {
          ok: (x) => statsOf(x).r,
          bad: (x) => {
            const id = x.listEntities([Stats])[0]!
            x.getComponent(id, Stats)!.hits += 1
            x.markChanged(id, Stats)
            return 0
          },
        },
      }),
    ).toThrow(/probe "bad" changed the world/)
  })

  it('rejects malformed options with a TypeError', () => {
    const { snap } = liveAt30()
    const w = branch(snap)
    expect(() => runBranch(w, { steps: -1 })).toThrow(TypeError)
    expect(() => runBranch(w, { steps: 1.5 })).toThrow(TypeError)
    expect(() => runBranch(w, { steps: 1, dt: 0 })).toThrow(TypeError)
    expect(() => runBranch(w, { steps: 1, sampleEvery: 0, probes })).toThrow(TypeError)
    expect(() => runBranch(w, { steps: 1, keyframeEvery: 2.5 })).toThrow(TypeError)
    expect(() => runBranch(w, { steps: 1, hashEvery: -3 })).toThrow(TypeError)
    // A bad cadence is a bad option whether or not probes are given.
    expect(() => runBranch(w, { steps: 1, sampleEvery: 0 })).toThrow(TypeError)
    expect(() => runBranch(w, { steps: 1, sampleEvery: 2.5 })).toThrow(TypeError)
    expect(w.time.tick).toBe(30)
  })
})
