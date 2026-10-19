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
} from '../src/index.js'
import type { InputSnapshot, World } from '../src/index.js'

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
