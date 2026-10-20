import { describe, expect, it } from 'vitest'
import {
  createRecorder,
  createWorld,
  decodeInput,
  defineComponent,
  defineEvent,
  definePlugin,
  defineResource,
  encodeInput,
  entry,
  hashSnapshot,
  replay,
} from '../src/index.js'
import type { ActLog, InputSnapshot, World, WorldSnapshot } from '../src/index.js'

const strict = (w: World): string => hashSnapshot(w.snapshot({ pendingEvents: true }), { includeChanges: true })

// §7.1 (G4; O-80): act logs record what entered a world from outside, so a
// fresh world restored from the base replays to the same strict hashes.

function fullInput(): InputSnapshot {
  return {
    keys: new Set(['KeyW', 'ArrowLeft', 'Space']),
    keyDelta: { pressed: new Set(['Space', 'KeyA']), released: new Set(['KeyD']) },
    mods: { ctrl: true, alt: false, shift: true, meta: false },
    pointer: { x: 12.5, y: -3, buttons: 1, delta: { x: 2, y: -1 }, wheel: 40, entered: [7, 3] },
    gamepads: [
      { index: 0, axes: [0.5, -0.25], buttons: [{ pressed: true, value: 1 }, { pressed: false, value: 0.2 }] },
    ],
    focus: { activeTag: 'INPUT', consumesKeys: true },
  }
}

function emptyInputSnapshot(): InputSnapshot {
  return {
    keys: new Set(),
    keyDelta: { pressed: new Set(), released: new Set() },
    mods: { ctrl: false, alt: false, shift: false, meta: false },
    pointer: { x: 0, y: 0, buttons: 0, delta: { x: 0, y: 0 }, wheel: 0, entered: [] },
    gamepads: [],
    focus: { activeTag: '', consumesKeys: false },
  }
}

describe('encodeInput / decodeInput (§7.1 test 2)', () => {
  it('encodes every part with sorted key arrays', () => {
    const json = encodeInput(fullInput())
    expect(json).toEqual({
      keys: ['ArrowLeft', 'KeyW', 'Space'],
      pressed: ['KeyA', 'Space'],
      released: ['KeyD'],
      mods: { ctrl: true, alt: false, shift: true, meta: false },
      pointer: { x: 12.5, y: -3, buttons: 1, delta: { x: 2, y: -1 }, wheel: 40, entered: [7, 3] },
      gamepads: [
        { index: 0, axes: [0.5, -0.25], buttons: [{ pressed: true, value: 1 }, { pressed: false, value: 0.2 }] },
      ],
      focus: { activeTag: 'INPUT', consumesKeys: true },
    })
  })

  it('omits empty pressed/released and parts equal to the empty input', () => {
    expect(encodeInput(emptyInputSnapshot())).toEqual({ keys: [] })
    const onlyKeys = { ...emptyInputSnapshot(), keys: new Set(['b', 'a']) }
    expect(encodeInput(onlyKeys)).toEqual({ keys: ['a', 'b'] })
    const json = encodeInput({ ...emptyInputSnapshot(), pointer: { ...emptyInputSnapshot().pointer, x: -0 } })
    expect(Object.is(json.pointer?.x, -0)).toBe(true)
  })

  it('round-trips: decodeInput(encodeInput(x)) deep-equals x, with Sets rebuilt', () => {
    for (const input of [fullInput(), emptyInputSnapshot()]) {
      const back = decodeInput(encodeInput(input))
      expect(back).toEqual(input)
      expect(back.keys).toBeInstanceOf(Set)
      expect(back.keyDelta.pressed).toBeInstanceOf(Set)
      expect(back.keyDelta.released).toBeInstanceOf(Set)
    }
  })

  it('survives JSON.parse(JSON.stringify(…))', () => {
    const json = encodeInput(fullInput())
    const parsed = JSON.parse(JSON.stringify(json)) as typeof json
    expect(parsed).toEqual(json)
    expect(decodeInput(parsed)).toEqual(fullInput())
  })

  it('copies: the encoded value shares nothing with the snapshot, and vice versa', () => {
    const input = fullInput()
    const json = encodeInput(input)
    ;(input.pointer.entered as number[]).push(99)
    ;(input.gamepads[0]!.axes as number[])[0] = 9
    expect(json.pointer?.entered).toEqual([7, 3])
    expect(json.gamepads?.[0]?.axes).toEqual([0.5, -0.25])
    const decoded = decodeInput(json)
    ;(decoded.pointer.entered as number[]).push(1)
    expect(json.pointer?.entered).toEqual([7, 3])
  })
})

// ---------------------------------------------------------------------------
// Recorder (E19.2)
// ---------------------------------------------------------------------------

const Score = defineComponent<{ n: number; hits: number }>('RpScore', { defaults: { n: 0, hits: 0 } })
const Hit = defineEvent<{ amount: number }>('RpHit', {
  schema: { fields: { amount: { kind: 'number' } } },
})
const Echo = defineEvent<{ from: string }>('RpEcho')
const Tick = defineEvent<void>('RpTick')
const Level = defineResource<{ n: number }>('RpLevel', { default: { n: 0 } })

function inputWith(keys: string[], pressed: string[] = []): InputSnapshot {
  return { ...emptyInputSnapshot(), keys: new Set(keys), keyDelta: { pressed: new Set(pressed), released: new Set() } }
}

describe('createRecorder (§7.1 capture)', () => {
  it('sets startTick, fixedStep, startScale and a strict baseHash at creation', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4], fixedStep: 1 / 30 })
    w.spawn([entry(Score, { n: 1, hits: 0 })])
    w.stepOnce()
    w.emit(Echo, { from: 'pending' })
    w.setScale(2)
    const rec = createRecorder(w)
    const log = rec.peek()
    expect(log.format).toBe('domecs-actlog')
    expect(log.version).toBe(1)
    expect(log.startTick).toBe(1)
    expect(log.fixedStep).toBe(1 / 30)
    expect(log.startScale).toBe(2)
    expect(log.baseHash).toBe(strict(w))
    expect(log.frames).toEqual([])
    expect(log.gaps).toBeUndefined()
    expect(log.checkpoints).toBeUndefined()
  })

  it('records external emits with via into the next frame; dt is null for stepOnce', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    w.register(Hit, Echo)
    const rec = createRecorder(w)
    w.emit(Echo, { from: 'outside' })
    w.action(Hit, { amount: 3 })
    w.turn(Echo, { from: 'turn' }, 1 / 60)
    w.step(1 / 60)
    const log = rec.stop()
    expect(log.frames).toEqual([
      { tick: 0, dt: null, input: { keys: [] }, acts: [
        { event: 'RpEcho', payload: { from: 'outside' }, via: 'emit' },
        { event: 'RpHit', payload: { amount: 3 }, via: 'action' },
      ] },
      { tick: 1, dt: 1 / 60, acts: [{ event: 'RpEcho', payload: { from: 'turn' }, via: 'emit' }] },
      { tick: 2, dt: 1 / 60 },
    ])
  })

  it('does not record emits from systems or on handlers (test 4)', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    w.system('sys', {}, (ctx) => {
      ctx.events.emit(Echo, { from: 'ctx' })
      w.emit(Echo, { from: 'world' })
    })
    w.on(Hit, () => w.emit(Echo, { from: 'handler' }))
    const rec = createRecorder(w)
    w.emit(Hit, { amount: 1 })
    w.stepOnce()
    w.stepOnce()
    const log = rec.stop()
    const acts = log.frames.flatMap((f) => f.acts ?? [])
    expect(acts).toEqual([{ event: 'RpHit', payload: { amount: 1 }, via: 'emit' }])
  })

  it('records void payloads without a payload field and copies payloads at emit time', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    const rec = createRecorder(w)
    const p = { from: 'a' }
    w.emit(Tick, undefined)
    w.emit(Echo, p)
    p.from = 'mutated'
    w.stepOnce()
    expect(rec.stop().frames[0]!.acts).toEqual([
      { event: 'RpTick', via: 'emit' },
      { event: 'RpEcho', payload: { from: 'a' }, via: 'emit' },
    ])
  })

  it('records plugin onTickStart emits during a full tick and during a heartbeat (half of test 9)', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    w.use(
      definePlugin({
        name: 'pinger',
        install: () => ({
          onTickStart(world, info) {
            world.emit(Echo, { from: info.heartbeat ? 'heartbeat' : `tick${world.time.tick}` })
          },
        }),
      }),
    )
    const rec = createRecorder(w)
    w.step(1 / 60) // tick 0 -> 1, plugin emits into this frame (delivered this tick)
    w.step(0) // heartbeat: emit carries to the next frame
    w.step(1 / 60)
    const log = rec.stop()
    expect(log.frames.map((f) => f.acts)).toEqual([
      [{ event: 'RpEcho', payload: { from: 'tick1' }, via: 'emit' }],
      [
        { event: 'RpEcho', payload: { from: 'heartbeat' }, via: 'emit' },
        { event: 'RpEcho', payload: { from: 'tick2' }, via: 'emit' },
      ],
    ])
  })

  it('reads scale on runTick entry; a tickStart pause is recorded as hookScale (half of test 10)', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    w.signals.tickStart.subscribe((t) => {
      if (t.tick === 50) w.setScale(0)
    })
    const rec = createRecorder(w)
    for (let i = 0; i < 52; i++) w.step(1 / 60)
    w.setScale(1)
    w.step(1 / 60)
    const log = rec.stop()
    // Frame 49 is the step that ends at tick 50: scale on entry was 1, so dt
    // is scaled by 1; the hook paused it before systems ran (hookScale). The
    // world ended that step paused, so frame 50 needs no scale of its own.
    expect(log.frames[49]).toEqual({ tick: 49, dt: 1 / 60, hookScale: 0 })
    expect(log.frames[50]).toEqual({ tick: 50, dt: 1 / 60 })
    expect(log.frames[51]).toEqual({ tick: 51, dt: 1 / 60 })
    expect(log.frames[52]).toEqual({ tick: 52, dt: 1 / 60, scale: 1 })
    expect(log.frames.filter((f) => f.scale !== undefined || f.hookScale !== undefined)).toHaveLength(2)
  })

  it('delta-encodes input read after plugin onTickStart', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    let next: InputSnapshot | null = null
    w.use(
      definePlugin({
        name: 'input-ish',
        install: () => ({
          onTickStart(world) {
            if (next) world.setInput(next)
          },
        }),
      }),
    )
    const rec = createRecorder(w)
    w.stepOnce() // empty input: first frame always carries input
    next = inputWith(['KeyA'], ['KeyA'])
    w.stepOnce()
    next = inputWith(['KeyA']) // fresh object, new content
    w.stepOnce()
    next = inputWith(['KeyA']) // fresh object, same content
    w.stepOnce()
    const log = rec.stop()
    expect(log.frames.map((f) => f.input)).toEqual([
      { keys: [] },
      { keys: ['KeyA'], pressed: ['KeyA'] },
      { keys: ['KeyA'] },
      undefined,
    ])
  })

  it('a heartbeat between acts does not split them, and setInput + heartbeat records nothing (test 6)', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    const rec = createRecorder(w)
    w.emit(Echo, { from: 'a' })
    w.step(0)
    w.setInput(inputWith(['KeyB']))
    w.step(0)
    w.emit(Echo, { from: 'b' })
    expect(rec.peek().frames).toEqual([])
    w.stepOnce()
    const log = rec.stop()
    expect(log.frames).toEqual([
      {
        tick: 0,
        dt: null,
        input: { keys: ['KeyB'] },
        acts: [
          { event: 'RpEcho', payload: { from: 'a' }, via: 'emit' },
          { event: 'RpEcho', payload: { from: 'b' }, via: 'emit' },
        ],
      },
    ])
    expect(log.gaps).toBeUndefined()
  })

  it('records gaps: out-of-tick mutations, unserializable payloads, restore (half of test 3)', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    const id = w.spawn([entry(Score, { n: 0, hits: 0 })])
    const base = w.snapshot({ pendingEvents: true })
    const kinds: Array<[string, () => void]> = [
      ['spawn', () => void w.spawn()],
      ['despawn', () => w.despawn(w.spawn())],
      ['addComponent', () => w.addComponent(w.spawn(), Score, { n: 1, hits: 0 })],
      ['removeComponent', () => w.removeComponent(id, Score)],
      ['markChanged', () => {
        w.getComponent(id, Score)!.n = 5
        w.markChanged(id, Score)
      }],
      ['setResource', () => w.setResource(Level, { n: 2 })],
      ['markResourceChanged', () => w.markResourceChanged(Level)],
    ]
    for (const [label, mutate] of kinds) {
      w.restore(base)
      const rec = createRecorder(w)
      w.stepOnce()
      mutate()
      w.stepOnce()
      expect(rec.stop().gaps, label).toEqual([{ tick: 1, reason: 'out_of_tick_mutation' }])
    }

    w.restore(base)
    const rec = createRecorder(w)
    w.emit(Echo, { from: new Date(0) } as unknown as { from: string })
    w.stepOnce()
    w.restore(base)
    const log = rec.stop()
    expect(log.gaps).toEqual([
      { tick: 0, reason: 'unserializable_payload' },
      { tick: 1, reason: 'restore' },
    ])
    expect(log.frames[0]!.acts).toBeUndefined()
  })

  it('an unencodable event already pending at creation is a gap at startTick', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    w.spawn([entry(Score, { n: 0, hits: 0 })])
    w.stepOnce()
    w.emit(Echo, { from: new Date(0) } as unknown as { from: string })
    const rec = createRecorder(w)
    w.stepOnce()
    // The queue cannot enter the base hash or the log, so a replay never
    // receives that event: the log does not describe the world from its start.
    expect(rec.stop().gaps).toEqual([{ tick: 1, reason: 'unserializable_payload' }])
  })

  it('mutations inside a tick (systems) record no gap; a heartbeat mutation does', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    w.system('spawner', {}, (ctx) => void ctx.world.spawn([entry(Score, { n: 1, hits: 0 })]))
    let hb = false
    w.use(definePlugin({ name: 'hb', install: () => ({ onTickStart(world, info) { if (info.heartbeat && hb) world.spawn() } }) }))
    const rec = createRecorder(w)
    w.stepOnce()
    w.stepOnce()
    expect(rec.peek().gaps).toBeUndefined()
    hb = true
    w.step(0)
    expect(rec.stop().gaps).toEqual([{ tick: 2, reason: 'out_of_tick_mutation' }])
  })

  it('restore drops acts the restore abandoned and keeps onRestore emits', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    w.use(definePlugin({ name: 'r', install: () => ({ onRestore(s) { w.emit(Echo, { from: 'hook' }); return s } }) }))
    const base = w.snapshot({ pendingEvents: true })
    const rec = createRecorder(w)
    w.emit(Echo, { from: 'abandoned' })
    w.restore(base)
    w.stepOnce()
    expect(rec.stop().frames[0]!.acts).toEqual([{ event: 'RpEcho', payload: { from: 'hook' }, via: 'emit' }])
  })

  it('a failed restore records no gap and keeps the pending acts', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    const rec = createRecorder(w)
    w.emit(Echo, { from: 'kept' })
    expect(() => w.restore({ version: 999 } as never)).toThrow()
    w.stepOnce()
    const log = rec.stop()
    expect(log.gaps).toBeUndefined()
    expect(log.frames[0]!.acts).toEqual([{ event: 'RpEcho', payload: { from: 'kept' }, via: 'emit' }])
  })

  it('hashEvery: k appends strict-hash checkpoints at tick ends where tick % k === 0', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    w.spawn([entry(Score, { n: 0, hits: 0 })])
    w.system('count', { query: [Score] }, (ctx) => {
      for (const e of ctx.entities) {
        e.RpScore!.n += 1
        w.markChanged(e.id, Score)
      }
    })
    const seen: Array<{ tick: number; hash: string }> = []
    w.signals.tickEnd.subscribe((t) => void t)
    const rec = createRecorder(w, { hashEvery: 3 })
    for (let i = 0; i < 7; i++) {
      w.stepOnce()
      if (w.time.tick % 3 === 0) seen.push({ tick: w.time.tick, hash: strict(w) })
    }
    expect(rec.stop().checkpoints).toEqual(seen)
    expect(seen.map((c) => c.tick)).toEqual([3, 6])
  })

  it('peek returns a copy; stop detaches (active === false)', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    const rec = createRecorder(w)
    expect(rec.active).toBe(true)
    w.emit(Echo, { from: 'x' })
    w.stepOnce()
    const a = rec.peek()
    ;(a.frames as unknown[]).length = 0
    ;((rec.peek().frames[0]!.acts![0]!.payload as { from: string })).from = 'changed'
    expect(rec.peek().frames[0]!.acts![0]!.payload).toEqual({ from: 'x' })
    const log = rec.stop()
    expect(rec.active).toBe(false)
    w.emit(Echo, { from: 'after' })
    w.stepOnce()
    w.spawn()
    expect(rec.peek()).toEqual(log)
    expect(rec.stop()).toEqual(log)
  })

  it('createRecorder inside a tick throws', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    let thrown: unknown
    w.system('rec', {}, () => {
      try {
        createRecorder(w)
      } catch (e) {
        thrown = e
      }
    })
    w.stepOnce()
    expect(thrown).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// Replay (E19.3)
// ---------------------------------------------------------------------------

const Body = defineComponent<{ x: number; v: number }>('RpBody', { defaults: { x: 0, v: 1 } })
const Stats = defineComponent<{ t: number; hits: number; echoes: number; keys: number; r: number; fixed: number }>(
  'RpStats',
  { defaults: { t: 0, hits: 0, echoes: 0, keys: 0, r: 0, fixed: 0 } },
)

/** The same setup for the recording world and every replay world: tick, fixed, event and own-stream systems and an on handler. */
function build(w: World): void {
  w.register(Hit, Echo, Tick, Body, Stats)
  w.system('move', { schedule: 'fixed', query: [Body] }, (ctx) => {
    for (const e of ctx.entities) {
      e.RpBody!.x += e.RpBody!.v * ctx.time.fixedStep
      w.markChanged(e.id, Body)
    }
    for (const id of w.listEntities([Stats])) w.getComponent(id, Stats)!.fixed += 1
  })
  w.system('clock', { query: [Stats] }, (ctx) => {
    for (const e of ctx.entities) {
      const s = e.RpStats!
      s.t += ctx.time.scaledDelta
      if (ctx.input.keys.has('KeyA')) s.keys += 1
      if (ctx.input.keyDelta.pressed.has('Space')) s.keys += 10
      w.markChanged(e.id, Stats)
    }
  })
  w.system('noise', { rng: 'own', query: [Stats] }, (ctx) => {
    for (const e of ctx.entities) e.RpStats!.r = ctx.rand.uniform()
  })
  w.system('hits', { schedule: 'event', triggers: [Hit] }, (ctx) => {
    for (const h of ctx.events.of(Hit)) {
      for (const id of w.listEntities([Stats])) w.getComponent(id, Stats)!.hits += h.amount
      ctx.events.emit(Echo, { from: 'hit' })
    }
  })
  w.on(Echo, () => {
    for (const id of w.listEntities([Stats])) w.getComponent(id, Stats)!.echoes += 1
  })
  w.on(Tick, () => {
    for (const id of w.listEntities([Body])) w.getComponent(id, Body)!.v += 1
  })
}

function source(): World {
  const w = createWorld({ headless: true, seed: [9, 8, 7, 6] })
  build(w)
  w.spawn([entry(Body, { x: 0, v: 2 })])
  w.spawn([entry(Body, { x: 5, v: -1 }), entry(Stats, { t: 0, hits: 0, echoes: 0, keys: 0, r: 0, fixed: 0 })])
  w.step(1 / 60)
  w.stepOnce()
  return w
}

function fresh(): World {
  const w = createWorld({ headless: true, seed: [1, 1, 1, 1] })
  build(w)
  return w
}

/** 300 frames: acts, step(1/60), stepOnce, scale changes, input changes. */
function drive(w: World, frames = 300): void {
  for (let i = 0; i < frames; i++) {
    if (i % 13 === 0) w.setInput(inputWith(i % 26 === 0 ? ['KeyA'] : [], i % 39 === 0 ? ['Space'] : []))
    if (i === 100) w.setScale(2)
    if (i === 150) w.setScale(0)
    if (i === 160) w.setScale(0.5)
    if (i === 220) w.setScale(1)
    if (i % 17 === 0) w.emit(Tick, undefined)
    if (i % 7 === 0) {
      w.action(Hit, { amount: (i % 5) + 1 }, i % 2 === 0 ? {} : { dt: 1 / 60 })
      continue
    }
    if (i % 11 === 0) w.emit(Echo, { from: `outside-${i}` })
    if (i % 23 === 0) w.step(0)
    if (i % 3 === 0) w.stepOnce()
    else w.step(1 / 60)
  }
}

function record(frames = 300, hashEvery = 10): { live: World; base: WorldSnapshot; log: ActLog } {
  const live = source()
  const base = live.snapshot({ pendingEvents: true })
  const rec = createRecorder(live, { hashEvery })
  drive(live, frames)
  return { live, base, log: rec.stop() }
}

describe('replay (§7.1)', () => {
  it('300 mixed frames replay on a fresh world to equal hashes at every checkpoint and the end (test 1)', () => {
    const { live, base, log } = record()
    expect(log.frames).toHaveLength(300)
    expect(log.gaps).toBeUndefined()
    expect(log.checkpoints!.length).toBe(30)
    expect(log.frames.some((f) => f.scale !== undefined)).toBe(true)
    expect(log.frames.filter((f) => f.input !== undefined).length).toBeGreaterThan(3)

    const w = fresh()
    const seen: number[] = []
    const r = replay(w, log, { base, onFrame: (tick) => seen.push(tick) })
    expect(r).toEqual({ ok: true, value: { ticks: 300, hash: strict(live) } })
    expect(w.time.tick).toBe(live.time.tick)
    expect(seen).toHaveLength(300)
    expect(seen[0]).toBe(log.startTick + 1)
    // Every checkpoint was compared: a replay that stops checking would not see a tampered one.
    const tampered = { ...log, checkpoints: log.checkpoints!.map((c, i) => (i === 29 ? { ...c, hash: 'x' } : c)) }
    const r2 = replay(fresh(), tampered, { base })
    expect(r2).toEqual({ ok: false, error: { kind: 'diverged', tick: log.checkpoints![29]!.tick, expected: 'x', actual: log.checkpoints![29]!.hash } })
  })

  it('the stats really depend on the log: dropping an act diverges', () => {
    const { base, log } = record()
    const frames = log.frames.map((f, i) => (i === 7 ? { tick: f.tick, dt: f.dt } : f))
    const r = replay(fresh(), { ...log, frames }, { base })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('diverged')
  })

  it('replays into a world already at the base without `base`', () => {
    const { live, base, log } = record(60)
    const w = fresh()
    w.restore(base)
    expect(replay(w, log)).toEqual({ ok: true, value: { ticks: 60, hash: strict(live) } })
  })

  it('a log past an out_of_tick_mutation gap reports diverged at the next checkpoint (test 3)', () => {
    const live = source()
    const base = live.snapshot({ pendingEvents: true })
    const rec = createRecorder(live, { hashEvery: 5 })
    drive(live, 12)
    const id = live.listEntities([Stats])[0]!
    live.getComponent(id, Stats)!.hits = 999
    live.markChanged(id, Stats)
    const gapTick = live.time.tick
    drive(live, 12)
    const log = rec.stop()
    expect(log.gaps).toEqual([{ tick: gapTick, reason: 'out_of_tick_mutation' }])
    const next = log.checkpoints!.find((c) => c.tick > gapTick)!
    const r = replay(fresh(), log, { base })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('diverged')
      expect((r.error as { tick: number }).tick).toBe(next.tick)
    }
    // verify: false replays through it.
    expect(replay(fresh(), log, { base, verify: false }).ok).toBe(true)
  })

  it('emits from systems are not recorded, so replay does not double-emit (test 4)', () => {
    const { live, base, log } = record(40)
    const acts = log.frames.flatMap((f) => f.acts ?? [])
    expect(acts.some((a) => a.event === 'RpEcho' && (a.payload as { from: string }).from === 'hit')).toBe(false)
    const w = fresh()
    expect(replay(w, log, { base }).ok).toBe(true)
    const sid = (x: World) => x.listEntities([Stats])[0]!
    expect(w.getComponent(sid(w), Stats)!.echoes).toBe(live.getComponent(sid(live), Stats)!.echoes)
  })

  it('unknown or ambiguous names → unknown_event before any emit for that frame (test 5)', () => {
    const { base, log } = record(30)
    const i = log.frames.findIndex((f) => (f.acts ?? []).length > 0)
    const frame = log.frames[i]!
    const bad = {
      ...log,
      frames: log.frames.map((f, j) =>
        j === i ? { ...f, acts: [...frame.acts!, { event: 'RpNope', payload: {}, via: 'emit' as const }] } : f,
      ),
    }
    const w = fresh()
    const emitted: string[] = []
    w.on(Hit, () => emitted.push('hit'))
    const r = replay(w, bad, { base })
    expect(r).toEqual({ ok: false, error: { kind: 'unknown_event', event: 'RpNope', tick: frame.tick } })
    // The frame's other acts were not emitted.
    expect(w.pendingEvents().filter((e) => e.type.name === 'RpHit')).toEqual([])
    expect(w.time.tick).toBe(frame.tick)

    const twin = createWorld({ headless: true, seed: [1, 1, 1, 1] })
    build(twin)
    const Other = defineEvent<{ amount: number }>('RpHit')
    twin.on(Other, () => {})
    const r2 = replay(twin, log, { base })
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error).toMatchObject({ kind: 'unknown_event', event: 'RpHit' })
  })

  it("schema-invalid via 'action' → rejected_payload; the same payload via 'emit' replays unvalidated (test 5)", () => {
    const w0 = fresh()
    w0.spawn([entry(Stats, { t: 0, hits: 0, echoes: 0, keys: 0, r: 0, fixed: 0 })])
    const base = w0.snapshot({ pendingEvents: true })
    const rec = createRecorder(w0)
    w0.emit(Hit, { amount: 'lots' } as unknown as { amount: number })
    w0.stepOnce()
    const log = rec.stop()
    expect(log.frames[0]!.acts).toEqual([{ event: 'RpHit', payload: { amount: 'lots' }, via: 'emit' }])
    expect(replay(fresh(), log, { base })).toEqual({ ok: true, value: { ticks: 1, hash: strict(w0) } })

    const asAction = {
      ...log,
      frames: [{ ...log.frames[0]!, acts: [{ event: 'RpHit', payload: { amount: 'lots' }, via: 'action' as const }] }],
    }
    const r = replay(fresh(), asAction, { base })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatchObject({ kind: 'rejected_payload', event: 'RpHit', tick: 0 })
      expect((r.error as { reason: string }).reason).toMatch(/amount/)
    }
  })

  it('toTick stops after the frame that ends at that tick (test 7)', () => {
    const { live, base, log } = record(50)
    const target = log.startTick + 20
    const w = fresh()
    const r = replay(w, log, { base, toTick: target })
    expect(r.ok && r.value.ticks).toBe(20)
    expect(w.time.tick).toBe(target)
    // The same as a live world stopped there.
    const { live: live20 } = record(20)
    expect(r.ok && r.value.hash).toBe(strict(live20))
    void live
    expect(replay(fresh(), log, { base, toTick: log.startTick })).toEqual({
      ok: true,
      value: { ticks: 0, hash: strict((() => { const x = fresh(); x.restore(base); return x })()) },
    })
  })

  it('the JSON-parsed log replays identically (test 8)', () => {
    const { live, base, log } = record()
    const parsed = JSON.parse(JSON.stringify(log)) as ActLog
    expect(parsed).toEqual(log)
    const baseParsed = JSON.parse(JSON.stringify(base)) as WorldSnapshot
    expect(replay(fresh(), parsed, { base: baseParsed })).toEqual({ ok: true, value: { ticks: 300, hash: strict(live) } })
  })

  it('plugin onTickStart emits (full tick and heartbeat) replay on a world without the plugin (test 9)', () => {
    const live = source()
    live.use(
      definePlugin({
        name: 'stimulus',
        install: () => ({
          onTickStart(world, info) {
            if (info.heartbeat) world.emit(Hit, { amount: 100 })
            else if (world.time.tick % 4 === 0) world.emit(Echo, { from: 'plugin' })
          },
        }),
      }),
    )
    const base = live.snapshot({ pendingEvents: true })
    const rec = createRecorder(live, { hashEvery: 4 })
    for (let i = 0; i < 40; i++) {
      if (i % 9 === 0) live.step(0)
      live.step(1 / 60)
    }
    const log = rec.stop()
    expect(log.frames.flatMap((f) => f.acts ?? []).length).toBeGreaterThan(10)
    expect(replay(fresh(), log, { base })).toEqual({ ok: true, value: { ticks: 40, hash: strict(live) } })
  })

  it('a tickStart hook pausing at tick 50: replay reproduces the paused ticks without the hook (test 10)', () => {
    for (const via of ['signal', 'plugin'] as const) {
      const live = source()
      const pauseAt = live.time.tick + 50
      if (via === 'signal') {
        live.signals.tickStart.subscribe((t) => {
          if (t.tick === pauseAt) live.setScale(0)
        })
      } else {
        live.use(definePlugin({ name: 'pauser', install: () => ({ onTickStart(world, info) { if (!info.heartbeat && world.time.tick === pauseAt) world.pause() } }) }))
      }
      const base = live.snapshot({ pendingEvents: true })
      const rec = createRecorder(live, { hashEvery: 1 })
      for (let i = 0; i < 60; i++) live.step(1 / 60)
      live.resume()
      for (let i = 0; i < 10; i++) live.step(1 / 60)
      const log = rec.stop()
      const statsId = live.listEntities([Stats])[0]!
      const fixedAtPause = live.getComponent(statsId, Stats)!.fixed
      expect(fixedAtPause).toBeGreaterThan(0)
      const w = fresh()
      expect(replay(w, log, { base }), via).toEqual({ ok: true, value: { ticks: 70, hash: strict(live) } })
      // The pause tick needs its tick-start scale: the entry scale alone runs
      // that tick's systems. A plugin pauses before the event flush
      // (flushScale), a signal subscriber after it (hookScale).
      const field = via === 'plugin' ? 'flushScale' : 'hookScale'
      expect(log.frames.filter((f) => f.flushScale !== undefined || f.hookScale !== undefined), via).toHaveLength(1)
      expect(log.frames.filter((f) => f[field] !== undefined), via).toHaveLength(1)
      const stripped = { ...log, frames: log.frames.map(({ hookScale: _h, flushScale: _f, ...f }) => f) }
      const r = replay(fresh(), stripped, { base })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatchObject({ kind: 'diverged', tick: pauseAt })
    }
  })

  it('a scale a plugin sets at onTickStart is in place for the event flush, as it was live', () => {
    const Seen = defineResource<{ scales: number[] }>('RpSeenScale', { default: { scales: [] } })
    const setup = (w: World): World => {
      w.on(Echo, () => {
        const s = w.getResource(Seen) ?? { scales: [] }
        w.setResource(Seen, { scales: [...s.scales, w.time.scale] })
      })
      return w
    }
    const live = setup(createWorld({ headless: true, seed: [1, 2, 3, 4] }))
    live.use(definePlugin({ name: 'slow', install: () => ({ onTickStart(world, info) { if (!info.heartbeat && world.time.tick === 3) world.setScale(0.5) } }) }))
    const base = live.snapshot({ pendingEvents: true })
    const rec = createRecorder(live, { hashEvery: 1 })
    for (let i = 0; i < 5; i++) {
      live.emit(Echo, { from: `e${i}` })
      live.step(1 / 60)
    }
    const log = rec.stop()
    expect(live.getResource(Seen)!.scales).toEqual([1, 1, 0.5, 0.5, 0.5])
    const w = setup(createWorld({ headless: true, seed: [1, 2, 3, 4] }))
    expect(replay(w, log, { base })).toEqual({ ok: true, value: { ticks: 5, hash: strict(live) } })
    expect(w.getResource(Seen)!.scales).toEqual([1, 1, 0.5, 0.5, 0.5])
  })

  it('input a tickStart subscriber sets reaches the systems, not the event flush before it', () => {
    const Seen = defineResource<{ keys: string[][] }>('RpSeenKeys', { default: { keys: [] } })
    const KeyLog = defineResource<{ keys: string[][] }>('RpSystemKeys', { default: { keys: [] } })
    const setup = (w: World): World => {
      w.on(Echo, () => {
        const s = w.getResource(Seen) ?? { keys: [] }
        w.setResource(Seen, { keys: [...s.keys, [...w.input.keys]] })
      })
      w.system('keys', { schedule: 'tick' }, () => {
        const s = w.getResource(KeyLog) ?? { keys: [] }
        w.setResource(KeyLog, { keys: [...s.keys, [...w.input.keys]] })
      })
      return w
    }
    const live = setup(createWorld({ headless: true, seed: [1, 2, 3, 4] }))
    live.signals.tickStart.subscribe((t) => {
      if (t.tick === 3) live.setInput(inputWith(['KeyQ']))
    })
    const base = live.snapshot({ pendingEvents: true })
    const rec = createRecorder(live, { hashEvery: 1 })
    for (let i = 0; i < 4; i++) {
      live.emit(Echo, { from: `e${i}` })
      live.step(1 / 60)
    }
    const log = rec.stop()
    expect(live.getResource(Seen)!.keys).toEqual([[], [], [], ['KeyQ']])
    expect(live.getResource(KeyLog)!.keys).toEqual([[], [], ['KeyQ'], ['KeyQ']])
    const w = setup(createWorld({ headless: true, seed: [1, 2, 3, 4] }))
    expect(replay(w, log, { base })).toEqual({ ok: true, value: { ticks: 4, hash: strict(live) } })
  })

  it('base_mismatch when the world is not at the log base', () => {
    const { base, log } = record(10)
    const w = fresh()
    const r = replay(w, log)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatchObject({ kind: 'base_mismatch', expected: log.baseHash })
    void base
  })

  it('invalid_log when the replay world has a different fixedStep', () => {
    const { base, log } = record(10)
    const w = createWorld({ headless: true, seed: [1, 1, 1, 1], fixedStep: 1 / 30 })
    build(w)
    const r = replay(w, log, { base })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('invalid_log')
  })

  it('invalid_log for a wrong format/version or a malformed log; never throws for bad logs', () => {
    const { base, log } = record(10)
    const cases: unknown[] = [
      null,
      42,
      'log',
      [],
      { ...log, format: 'other' },
      { ...log, version: 2 },
      { ...log, frames: 'x' },
      { ...log, baseHash: 5 },
      { ...log, startScale: -1 },
      { ...log, startScale: Number.NaN },
      { ...log, frames: [null] },
      { ...log, frames: [{ tick: 'a', dt: null }] },
      { ...log, frames: [{ tick: 0, dt: 0 }] },
      { ...log, frames: [{ tick: 0, dt: -1 }] },
      { ...log, frames: [{ tick: 0, dt: Number.POSITIVE_INFINITY }] },
      { ...log, frames: [{ tick: 0, dt: null, scale: -2 }] },
      { ...log, frames: [{ tick: 0, dt: null, hookScale: 'x' }] },
      { ...log, frames: [{ tick: 0, dt: null, flushScale: -1 }] },
      { ...log, frames: [{ tick: 0, dt: null, resumeScale: 0 }] },
      { ...log, frames: [{ tick: 0, dt: null, scale: 2, resumeScale: 3 }] },
      { ...log, frames: [{ tick: 0, dt: null, hookInput: { keys: [1] } }] },
      { ...log, frames: [{ tick: 0, dt: null, acts: {} }] },
      { ...log, frames: [{ tick: 0, dt: null, acts: [{ event: 3, via: 'emit' }] }] },
      { ...log, frames: [{ tick: 0, dt: null, acts: [{ event: 'RpHit', via: 'shout' }] }] },
      { ...log, frames: [{ tick: 0, dt: null, input: {} }] },
      { ...log, frames: [{ tick: 0, dt: null, input: { keys: [1] } }] },
      { ...log, frames: [{ tick: 0, dt: null, input: { keys: [], pointer: { x: 0 } } }] },
      { ...log, frames: [{ tick: 0, dt: null, input: { keys: [], gamepads: [{ index: 0, axes: [], buttons: [{}] }] } }] },
      { ...log, frames: [{ tick: 0, dt: null, input: { keys: [], mods: { ctrl: 1 } } }] },
      { ...log, frames: [{ tick: 0, dt: null, input: { keys: [], focus: { activeTag: 1 } } }] },
      { ...log, checkpoints: [{ tick: 1 }] },
      { ...log, gaps: 'none' },
    ]
    for (const bad of cases) {
      const w = fresh()
      let r
      expect(() => (r = replay(w, bad as ActLog, { base }))).not.toThrow()
      expect(r, JSON.stringify(bad)?.slice(0, 120)).toMatchObject({ ok: false, error: { kind: 'invalid_log' } })
      // Nothing happened: the world was not restored or stepped.
      expect(w.time.tick).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Verify fixes (E19 adversarial review)
// ---------------------------------------------------------------------------

describe('replay of emits made during a tick after the event flush', () => {
  it('onTickEnd / signals.tickEnd emits: checkpoints and the final hash match on a world without the emitter', () => {
    for (const via of ['plugin', 'signal'] as const) {
      const live = source()
      if (via === 'plugin') {
        live.use(definePlugin({ name: 'ender', install: () => ({ onTickEnd(world, info) { if (!info.heartbeat) world.emit(Echo, { from: 'end' }) } }) }))
      } else {
        live.signals.tickEnd.subscribe(() => live.emit(Echo, { from: 'end' }))
      }
      const base = live.snapshot({ pendingEvents: true })
      const rec = createRecorder(live, { hashEvery: 1 })
      for (let i = 0; i < 12; i++) live.step(1 / 60)
      const log = rec.stop()
      expect(replay(fresh(), log, { base }), via).toEqual({ ok: true, value: { ticks: 12, hash: strict(live) } })
    }
  })

  it('signals.tickStart emits keep their order relative to system emits', () => {
    const Ping = defineEvent<{ n: number }>('RpPing')
    const Pong = defineEvent<{ n: number }>('RpPong')
    const setup = (w: World): void => {
      w.register(Ping, Pong)
      w.system('pong', {}, (ctx) => ctx.events.emit(Pong, { n: ctx.time.tick }))
      w.system('ping', {}, (ctx) => ctx.events.emit(Ping, { n: -ctx.time.tick }))
    }
    const live = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    setup(live)
    live.signals.tickStart.subscribe((t) => live.emit(Ping, { n: t.tick }))
    const base = live.snapshot({ pendingEvents: true })
    const rec = createRecorder(live, { hashEvery: 1 })
    for (let i = 0; i < 6; i++) live.stepOnce()
    const log = rec.stop()
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    setup(w)
    expect(replay(w, log, { base })).toEqual({ ok: true, value: { ticks: 6, hash: strict(live) } })
    expect(w.pendingEvents().map((e) => e.type.name)).toEqual(live.pendingEvents().map((e) => e.type.name))
  })
})

describe('startActs / endActs capture', () => {
  it('puts post-flush emits into the running frame by phase, heartbeat emits into the next frame', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    w.signals.tickStart.subscribe((t) => w.emit(Echo, { from: `start${t.tick}` }))
    w.use(definePlugin({ name: 'ender', install: () => ({ onTickEnd(world, info) { world.emit(Echo, { from: info.heartbeat ? 'hb-end' : 'end' }) } }) }))
    const rec = createRecorder(w)
    w.stepOnce()
    w.step(0)
    w.stepOnce()
    const log = rec.stop()
    expect(log.frames).toEqual([
      { tick: 0, dt: null, input: { keys: [] }, startActs: [{ event: 'RpEcho', payload: { from: 'start1' }, via: 'emit' }], endActs: [{ event: 'RpEcho', payload: { from: 'end' }, via: 'emit' }] },
      {
        tick: 1,
        dt: null,
        acts: [
          { event: 'RpEcho', payload: { from: 'start1' }, via: 'emit' },
          { event: 'RpEcho', payload: { from: 'hb-end' }, via: 'emit' },
        ],
        startActs: [{ event: 'RpEcho', payload: { from: 'start2' }, via: 'emit' }],
        endActs: [{ event: 'RpEcho', payload: { from: 'end' }, via: 'emit' }],
      },
    ])
  })

  it('an unknown name in startActs or endActs is unknown_event before any emit; malformed fields are invalid_log', () => {
    const w0 = fresh()
    const base = w0.snapshot({ pendingEvents: true })
    const rec = createRecorder(w0)
    w0.emit(Echo, { from: 'before' })
    w0.stepOnce()
    const log = rec.stop()
    for (const field of ['startActs', 'endActs'] as const) {
      const bad = { ...log, frames: [{ ...log.frames[0]!, [field]: [{ event: 'RpNope', via: 'emit' }] }] }
      const w = fresh()
      expect(replay(w, bad, { base })).toEqual({ ok: false, error: { kind: 'unknown_event', event: 'RpNope', tick: 0 } })
      expect(w.pendingEvents()).toEqual([])
      const malformed = { ...log, frames: [{ ...log.frames[0]!, [field]: [{ event: 'RpEcho', via: 'x' }] }] }
      expect(replay(fresh(), malformed as unknown as ActLog, { base })).toMatchObject({ ok: false, error: { kind: 'invalid_log' } })
    }
  })
})

describe('out-of-tick draws on world.rand', () => {
  it('record an out_of_tick_mutation gap', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    const rec = createRecorder(w)
    w.stepOnce()
    w.rand.uniform()
    w.stepOnce()
    w.stepOnce()
    expect(rec.stop().gaps).toEqual([{ tick: 1, reason: 'out_of_tick_mutation' }])
  })

  it('draws inside systems record nothing, and a restore does not add a rand gap', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    w.system('draw', {}, (ctx) => void ctx.rand.uniform())
    const base = w.snapshot({ pendingEvents: true })
    const rec = createRecorder(w)
    w.stepOnce()
    w.stepOnce()
    w.restore(base)
    w.stepOnce()
    expect(rec.stop().gaps).toEqual([{ tick: 2, reason: 'restore' }])
  })
})

describe('input set by a signals.tickStart subscriber', () => {
  it('is recorded as hookInput, the input systems saw, and replays without the subscriber', () => {
    const live = source()
    live.signals.tickStart.subscribe((t) => {
      if (t.tick % 5 === 0) live.setInput(inputWith(t.tick % 10 === 0 ? ['KeyA'] : []))
    })
    const base = live.snapshot({ pendingEvents: true })
    const rec = createRecorder(live, { hashEvery: 1 })
    for (let i = 0; i < 20; i++) live.step(1 / 60)
    const log = rec.stop()
    const tenth = log.frames.find((f) => f.tick + 1 === 10)!
    // The event flush ran before the subscriber: it saw the previous input.
    expect(tenth.input).toBeUndefined()
    expect(tenth.hookInput).toEqual({ keys: ['KeyA'] })
    expect(replay(fresh(), log, { base })).toEqual({ ok: true, value: { ticks: 20, hash: strict(live) } })
  })
})

describe('a pause between frames', () => {
  it('keeps the resume target the host set, so a resume() in a system matches', () => {
    const Resume = defineEvent<void>('RpResumeMid')
    const setup = (): World => {
      const w = fresh()
      w.register(Resume)
      w.system('resumer', { schedule: 'event', triggers: [Resume] }, (ctx) => ctx.world.resume())
      return w
    }
    const live = setup()
    live.spawn([entry(Stats, { t: 0, hits: 0, echoes: 0, keys: 0, r: 0, fixed: 0 })])
    const base = live.snapshot({ pendingEvents: true })
    const rec = createRecorder(live, { hashEvery: 1 })
    live.step(1 / 60)
    live.setScale(3)
    live.pause()
    live.step(1 / 60)
    live.emit(Resume, undefined)
    for (let i = 0; i < 5; i++) live.step(1 / 60)
    const log = rec.stop()
    expect(live.time.scale).toBe(3)
    const w = setup()
    expect(replay(w, log, { base })).toEqual({ ok: true, value: { ticks: 7, hash: strict(live) } })
    expect(w.time.scale).toBe(3)
  })
})

describe('recording that starts paused', () => {
  it('replays a system resume() to the scale the recording world would resume to', () => {
    const Resume = defineEvent<void>('RpResume')
    const setup = (): World => {
      const w = fresh()
      w.register(Resume)
      w.system('resumer', { schedule: 'event', triggers: [Resume] }, (ctx) => ctx.world.resume())
      return w
    }
    const live = setup()
    live.spawn([entry(Stats, { t: 0, hits: 0, echoes: 0, keys: 0, r: 0, fixed: 0 })])
    live.setScale(3)
    live.pause()
    const base = live.snapshot({ pendingEvents: true })
    const rec = createRecorder(live, { hashEvery: 1 })
    live.step(1 / 60)
    live.emit(Resume, undefined)
    for (let i = 0; i < 5; i++) live.step(1 / 60)
    const log = rec.stop()
    expect(live.time.scale).toBe(3)
    expect(log.startScale).toBe(0)
    expect(log.resumeScale).toBe(3)
    const w = setup()
    expect(replay(w, log, { base })).toEqual({ ok: true, value: { ticks: 6, hash: strict(live) } })
    expect(w.time.scale).toBe(3)
  })

  it('omits resumeScale when recording starts unpaused, and rejects a bad one', () => {
    const w = fresh()
    const base = w.snapshot({ pendingEvents: true })
    const log = createRecorder(w).stop()
    expect('resumeScale' in log).toBe(false)
    for (const resumeScale of [0, -1, Number.NaN, 'x']) {
      const r = replay(fresh(), { ...log, startScale: 0, resumeScale } as unknown as ActLog, { base })
      expect(r).toMatchObject({ ok: false, error: { kind: 'invalid_log' } })
    }
  })
})

describe('checkpoint and gap validation', () => {
  it('a checkpoint that follows no frame end is invalid_log, not silently unverified', () => {
    const { base, log } = record(30, 5)
    const cps = log.checkpoints!.map((c, i) => (i === 1 ? { ...c, tick: 99999 } : c))
    const w = fresh()
    const r = replay(w, { ...log, checkpoints: cps }, { base })
    expect(r).toMatchObject({ ok: false, error: { kind: 'invalid_log' } })
    expect(w.time.tick).toBe(0)
    // Every genuine checkpoint matches a frame end, in order.
    expect(replay(fresh(), log, { base }).ok).toBe(true)
  })

  it('a gap with an unknown reason is invalid_log', () => {
    const { base, log } = record(10)
    const r = replay(fresh(), { ...log, gaps: [{ tick: 3, reason: 'heartbeat_input' }] } as unknown as ActLog, { base })
    expect(r).toMatchObject({ ok: false, error: { kind: 'invalid_log' } })
  })
})

describe('act payload validation', () => {
  it('a payload that is not plain data (cycle, NaN, class instance) is invalid_log, never a throw', () => {
    const { base, log } = record(10)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    for (const payload of [cyclic, { n: Number.NaN }, { d: new Date(0) }, [Number.POSITIVE_INFINITY]]) {
      for (const field of ['acts', 'startActs', 'endActs'] as const) {
        const { checkpoints: _c, ...rest } = log
        const bad = { ...rest, frames: [{ tick: log.startTick, dt: null, [field]: [{ event: 'RpEcho', payload, via: 'emit' }] }] }
        const w = fresh()
        let r
        expect(() => (r = replay(w, bad as unknown as ActLog, { base }))).not.toThrow()
        expect(r).toMatchObject({ ok: false, error: { kind: 'invalid_log', reason: expect.stringMatching(/payload/) } })
        expect(w.time.tick).toBe(0)
      }
    }
  })
})

describe('recorders attached and detached (E13 bench fix: a plain attached flag)', () => {
  it('a second recorder still hears out-of-tick mutations after the first stops', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    const id = w.spawn([entry(Score, { n: 0, hits: 0 })])
    const a = createRecorder(w)
    const b = createRecorder(w)
    w.stepOnce()
    a.stop()
    w.markChanged(id, Score)
    w.stepOnce()
    expect(b.peek().gaps).toEqual([{ tick: 1, reason: 'out_of_tick_mutation' }])
    b.stop()
    // A recorder attached after every other one stopped hears them again.
    const c = createRecorder(w)
    w.setResource(Level, { n: 1 })
    w.stepOnce()
    expect(c.stop().gaps).toEqual([{ tick: 2, reason: 'out_of_tick_mutation' }])
  })
})
