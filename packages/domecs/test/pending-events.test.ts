import { describe, expect, it } from 'vitest'
import {
  canonicalSnapshot,
  createWorld,
  defineComponent,
  defineEvent,
  entry,
  hashSnapshot,
  ok,
} from '../src/index.js'
import type { World, WorldSnapshot } from '../src/index.js'

// §4.7 (G21; O-90): undelivered events travel with a snapshot taken with
// `{ pendingEvents: true }`, and restore re-queues them in bus order.

const Counter = defineComponent<{ pings: number; sum: number; seq: string }>('PeCounter', {
  defaults: { pings: 0, sum: 0, seq: '' },
})
const Ping = defineEvent<{ n: number }>('PePing')
const Pong = defineEvent<{ tag: string }>('PePong')
const Beep = defineEvent<void>('PeBeep')

const strict = (w: World): string => hashSnapshot(w.snapshot({ pendingEvents: true }), { includeChanges: true })

/**
 * A system emits `Ping` at tick 5 (and every 7th tick after); an event system
 * folds each delivered Ping into the counter. No closure state.
 */
function build(w: World): void {
  w.system('emitter', {}, (ctx) => {
    if (ctx.time.tick === 5 || ctx.time.tick % 7 === 0) ctx.events.emit(Ping, { n: ctx.time.tick })
  })
  w.system('receiver', { schedule: 'event', triggers: [Ping] }, (ctx) => {
    for (const id of w.listEntities([Counter])) {
      const c = w.getComponent(id, Counter)!
      for (const p of ctx.events.of(Ping)) {
        c.pings += 1
        c.sum += p.n
      }
      w.markChanged(id, Counter)
    }
  })
}

function fresh(): World {
  const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
  build(w)
  return w
}

function liveAtTick5(): World {
  const w = fresh()
  w.spawn([entry(Counter, { pings: 0, sum: 0, seq: '' })])
  while (w.time.tick < 5) w.stepOnce()
  return w
}

const counter = (w: World) => w.getComponent(w.listEntities([Counter])[0]!, Counter)!

describe('pending events in snapshots (§4.7)', () => {
  it('test 1: an in-flight Ping survives a fork only with pendingEvents: true', () => {
    const live = liveAtTick5()
    expect(live.pendingEvents().map((e) => e.type)).toEqual([Ping])

    const snap = live.snapshot({ pendingEvents: true })
    expect(snap.pendingEvents).toEqual([{ event: 'PePing', payload: { n: 5 } }])

    const fork = fresh()
    fork.restore(snap)
    expect(strict(fork)).toBe(strict(live))
    live.stepOnce()
    fork.stepOnce()
    expect(counter(live).pings).toBe(1)
    expect(counter(fork).pings).toBe(1)
    for (let i = 0; i < 60; i++) {
      expect(strict(fork)).toBe(strict(live))
      live.stepOnce()
      fork.stepOnce()
    }
    expect(strict(fork)).toBe(strict(live))

    // Red baseline: without the option the fork drops the Ping.
    const live2 = liveAtTick5()
    const plain = live2.snapshot()
    expect(plain.pendingEvents).toBeUndefined()
    expect('pendingEvents' in plain).toBe(false)
    const fork2 = fresh()
    fork2.restore(plain)
    live2.stepOnce()
    fork2.stepOnce()
    expect(counter(live2).pings).toBe(1)
    expect(counter(fork2).pings).toBe(0)
  })

  it('test 2: bus order is preserved across event types and payloads', () => {
    const order: string[] = []
    const make = () => {
      const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
      w.register(Ping, Pong, Beep)
      w.system('log', { schedule: 'event', triggers: [Ping, Pong, Beep] }, (ctx) => {
        for (const p of ctx.events.of(Pong)) order.push(`pong:${p.tag}`)
        for (const p of ctx.events.of(Ping)) order.push(`ping:${p.n}`)
        for (const _ of ctx.events.of(Beep)) order.push('beep')
      })
      return w
    }
    const live = make()
    live.emit(Pong, { tag: 'a' })
    live.emit(Ping, { n: 1 })
    live.emit(Beep, undefined)
    live.emit(Pong, { tag: 'b' })
    live.emit(Ping, { n: 2 })
    const snap = live.snapshot({ pendingEvents: true })
    expect(snap.pendingEvents).toEqual([
      { event: 'PePong', payload: { tag: 'a' } },
      { event: 'PePong', payload: { tag: 'b' } },
      { event: 'PePing', payload: { n: 1 } },
      { event: 'PePing', payload: { n: 2 } },
      { event: 'PeBeep' },
    ])

    const fork = make()
    fork.emit(Ping, { n: 99 }) // the restoring world's own queue is replaced
    fork.restore(snap)
    expect(fork.pendingEvents()).toEqual(live.pendingEvents())
    expect(fork.pendingEvents().map((e) => e.type)).toEqual([Pong, Pong, Ping, Ping, Beep])
    expect(fork.pendingEvents()[4]).toEqual({ type: Beep, payload: undefined })
    expect(fork.snapshot({ pendingEvents: true })).toEqual(snap)

    // Restored payloads are copies: mutating the snapshot does not reach the queue.
    ;(snap.pendingEvents![0]!.payload as { tag: string }).tag = 'mutated'
    expect(fork.pendingEvents()[0]!.payload).toEqual({ tag: 'a' })

    fork.stepOnce()
    expect(order).toEqual(['pong:a', 'pong:b', 'ping:1', 'ping:2', 'beep'])
  })

  it('test 2b: a snapshot round-tripped through JSON restores the same queue', () => {
    const live = liveAtTick5()
    const snap = JSON.parse(JSON.stringify(live.snapshot({ pendingEvents: true }))) as WorldSnapshot
    const fork = fresh()
    fork.restore(snap)
    expect(strict(fork)).toBe(strict(live))
  })

  it('test 3: unknown and ambiguous names throw before any state change', () => {
    const live = liveAtTick5()
    const snap = live.snapshot({ pendingEvents: true })

    // Unknown: the restoring world never saw PeGhost.
    const target = fresh()
    target.spawn([entry(Counter, { pings: 7, sum: 0, seq: '' })])
    target.emit(Pong, { tag: 'kept' })
    target.stepOnce()
    target.emit(Pong, { tag: 'queued' })
    const before = strict(target)
    const queueBefore = target.pendingEvents()
    const ghost: WorldSnapshot = {
      ...snap,
      pendingEvents: [...snap.pendingEvents!, { event: 'PeGhost', payload: 1 }],
    }
    expect(() => target.restore(ghost)).toThrow(/PeGhost/)
    expect(strict(target)).toBe(before)
    expect(target.pendingEvents()).toEqual(queueBefore)

    // Ambiguous: two distinct known types named PePing.
    const PingTwin = defineEvent<{ n: number }>('PePing')
    target.on(PingTwin, () => {})
    expect(target.lookupEvent('PePing')).toBeUndefined()
    expect(() => target.restore(snap)).toThrow(/ambiguous/)
    expect(strict(target)).toBe(before)
    expect(target.pendingEvents()).toEqual(queueBefore)
  })

  it('test 3b: a malformed pendingEvents field throws before any state change', () => {
    const live = liveAtTick5()
    const snap = live.snapshot({ pendingEvents: true })
    const target = fresh()
    const before = strict(target)
    const bad: unknown[] = [
      { ...snap, pendingEvents: {} },
      { ...snap, pendingEvents: [null] },
      { ...snap, pendingEvents: [{ event: 3, payload: 1 }] },
    ]
    for (const s of bad) {
      expect(() => target.restore(s as WorldSnapshot)).toThrow(/pendingEvents/)
      expect(strict(target)).toBe(before)
    }
  })

  it('test 4: a non-plain payload throws TypeError only when the option is set', () => {
    const Stamp = defineEvent<{ at: unknown }>('PeStamp')
    const cases: Array<[unknown, RegExp]> = [
      [{ at: new Date(0) }, /payload\.at/],
      [{ at: new Map() }, /payload\.at/],
      [{ at: () => 1 }, /payload\.at/],
      [{ at: Symbol('s') }, /payload\.at/],
      [{ at: 1n }, /payload\.at/],
      [{ at: Number.NaN }, /payload\.at/],
      [{ at: [1, undefined] }, /payload\.at\[1\]/],
    ]
    for (const [payload, path] of cases) {
      const w = fresh()
      w.emit(Stamp, payload as { at: unknown })
      expect(() => w.snapshot()).not.toThrow()
      expect(() => w.snapshot({ pendingEvents: true })).toThrow(TypeError)
      expect(() => w.snapshot({ pendingEvents: true })).toThrow(/PeStamp/)
      expect(() => w.snapshot({ pendingEvents: true })).toThrow(path)
    }
    // A cycle.
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    const w = fresh()
    w.emit(Stamp, { at: cyc })
    expect(() => w.snapshot({ pendingEvents: true })).toThrow(TypeError)

    // Plain data passes; an `undefined` object property is omitted (JSON
    // semantics) and -0 is kept; null-prototype objects are plain.
    const ok = fresh()
    const bare = Object.create(null) as Record<string, unknown>
    bare.k = 1
    ok.emit(Stamp, { at: { a: undefined, z: -0, n: null, s: 'x', arr: [true, bare] } })
    const snap = ok.snapshot({ pendingEvents: true })
    const p = snap.pendingEvents![0]!.payload as { at: Record<string, unknown> }
    expect(p.at).toEqual({ z: -0, n: null, s: 'x', arr: [true, { k: 1 }] })
    expect('a' in p.at).toBe(false)
    expect(Object.is(p.at.z, -0)).toBe(true)
  })

  it('test 5: canonicalSnapshot differs when only pendingEvents differs', () => {
    const a = liveAtTick5()
    const b = liveAtTick5()
    expect(strict(a)).toBe(strict(b))
    b.emit(Pong, { tag: 'extra' })
    const sa = a.snapshot({ pendingEvents: true })
    const sb = b.snapshot({ pendingEvents: true })
    expect(canonicalSnapshot(sa)).not.toBe(canonicalSnapshot(sb))
    expect(hashSnapshot(sa)).not.toBe(hashSnapshot(sb))
    // Without the option both default snapshots hash the same.
    expect(hashSnapshot(a.snapshot())).toBe(hashSnapshot(b.snapshot()))
  })

  it('omits the field when nothing is in flight, so the option does not change the hash', () => {
    const w = fresh()
    w.stepOnce()
    expect(w.pendingEvents()).toEqual([])
    const snap = w.snapshot({ pendingEvents: true })
    expect('pendingEvents' in snap).toBe(false)
    expect(hashSnapshot(snap)).toBe(hashSnapshot(w.snapshot()))
  })

  it('test 6: world.pendingEvents() matches the snapshot field and does not consume', () => {
    const live = liveAtTick5()
    live.emit(Pong, { tag: 't' })
    const pending = live.pendingEvents()
    const snap = live.snapshot({ pendingEvents: true })
    expect(snap.pendingEvents).toEqual(
      pending.map((e) => ({ event: e.type.name, payload: e.payload })),
    )
    expect(live.pendingEvents()).toEqual(pending)
    // Mutating the returned array does not change the queue.
    pending.length = 0
    expect(live.pendingEvents()).toHaveLength(2)
    live.stepOnce()
    expect(counter(live).pings).toBe(1)
    expect(live.pendingEvents()).toEqual([])
  })

  it('a snapshot without the field keeps 2.0 restore behaviour (queue abandoned)', () => {
    const w = fresh()
    w.emit(Ping, { n: 1 })
    w.restore(fresh().snapshot())
    expect(w.pendingEvents()).toEqual([])
  })

  it('events a plugin emits during onRestore follow the snapshot queue', () => {
    const live = liveAtTick5()
    const snap = live.snapshot({ pendingEvents: true })
    const fork = fresh()
    fork.use({
      name: 'pe-emitter',
      install: () =>
        ok({
          onRestore: (s: WorldSnapshot) => {
            fork.emit(Pong, { tag: 'plugin' })
            return s
          },
        }),
    })
    fork.restore(snap)
    expect(fork.pendingEvents().map((e) => [e.type, e.payload])).toEqual([
      [Ping, { n: 5 }],
      [Pong, { tag: 'plugin' }],
    ])
  })
})
