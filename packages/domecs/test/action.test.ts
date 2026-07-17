import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import { defineEvent } from '../src/events.js'
import { entry } from '../src/types.js'
import { createWorld } from '../src/world.js'

// Turn-based command surface (#17). `action(type, payload, opts?)` is a typed
// `turn()` that returns a structured command result so a UI knows whether the
// command was accepted, whether it consumed a turn, why it was rejected, what
// events it produced, and (optionally) a post-action snapshot. `turn()` stays
// void.

const Position = defineComponent<{ x: number; y: number }>('Position', {
  defaults: { x: 0, y: 0 },
})

const Move = defineEvent<{ entity: number; dx: number; dy: number }>('Move')
const Moved = defineEvent<{ entity: number }>('Moved')
const Blocked = defineEvent<{ reason: string }>('Blocked')

describe('world.action — turn-based command result (#17)', () => {
  it('emits the action event and advances exactly one tick', () => {
    const w = createWorld()
    const seen: Array<{ dx: number; dy: number }> = []
    w.system('actor', { schedule: 'event', triggers: [Move] }, (ctx) => {
      for (const m of ctx.events.of(Move)) seen.push({ dx: m.dx, dy: m.dy })
    })
    const startTick = w.time.tick
    w.action(Move, { entity: 0, dx: 1, dy: 0 })
    expect(seen).toEqual([{ dx: 1, dy: 0 }])
    expect(w.time.tick).toBe(startTick + 1)
  })

  it('defaults to accepted + consumedTurn with no resolver', () => {
    const w = createWorld()
    const r = w.action(Move, { entity: 0, dx: 1, dy: 0 })
    expect(r.accepted).toBe(true)
    expect(r.consumedTurn).toBe(true)
    expect(r.reason).toBeUndefined()
    expect(r.events).toEqual([])
    expect(r.snapshot).toBeUndefined()
  })

  it('captures events emitted *during* the action tick, excluding the action event itself', () => {
    const w = createWorld()
    // A system that, on Move, emits a result event for the same tick.
    w.system('mover', { schedule: 'event', triggers: [Move] }, (ctx) => {
      for (const m of ctx.events.of(Move)) ctx.events.emit(Moved, { entity: m.entity })
    })
    const r = w.action(Move, { entity: 7, dx: 1, dy: 0 })
    // The Move (action) event was flushed/consumed at step 1; only the result
    // event emitted during the tick is reported.
    expect(r.events).toHaveLength(1)
    expect(r.events[0]!.type).toBe(Moved)
    expect(r.events[0]!.payload).toEqual({ entity: 7 })
  })

  it('reports multiple result events in deterministic order (type insertion, then payload order)', () => {
    const w = createWorld()
    w.system('multi', { schedule: 'event', triggers: [Move] }, (ctx) => {
      if (ctx.events.of(Move).length === 0) return
      ctx.events.emit(Moved, { entity: 1 })
      ctx.events.emit(Moved, { entity: 2 })
      ctx.events.emit(Blocked, { reason: 'edge' })
    })
    const r = w.action(Move, { entity: 1, dx: 0, dy: 1 })
    expect(r.events.map((e) => [e.type, e.payload])).toEqual([
      [Moved, { entity: 1 }],
      [Moved, { entity: 2 }],
      [Blocked, { reason: 'edge' }],
    ])
  })

  it('threads the resolver verdict into the result; resolver sees the tick events + world', () => {
    const w = createWorld()
    w.system('mover', { schedule: 'event', triggers: [Move] }, (ctx) => {
      for (const m of ctx.events.of(Move)) {
        // Reject a zero move (a "wait" that hit a wall) by emitting Blocked.
        if (m.dx === 0 && m.dy === 0) ctx.events.emit(Blocked, { reason: 'wall' })
        else ctx.events.emit(Moved, { entity: m.entity })
      }
    })
    const resolve = (ctx: {
      events: readonly { type: unknown; payload: unknown }[]
      world: typeof w
    }) => {
      const blocked = ctx.events.find((e) => e.type === Blocked)
      if (blocked) return { accepted: false, reason: (blocked.payload as { reason: string }).reason }
      return { accepted: true }
    }

    const ok = w.action(Move, { entity: 0, dx: 1, dy: 0 }, { resolve })
    expect(ok.accepted).toBe(true)
    expect(ok.consumedTurn).toBe(true) // omitted consumedTurn mirrors accepted
    expect(ok.reason).toBeUndefined()

    const bad = w.action(Move, { entity: 0, dx: 0, dy: 0 }, { resolve })
    expect(bad.accepted).toBe(false)
    expect(bad.consumedTurn).toBe(false) // rejected → no turn consumed by default
    expect(bad.reason).toBe('wall')
  })

  it('honors an explicit consumedTurn from the resolver independent of accepted', () => {
    const w = createWorld()
    const r = w.action(Move, { entity: 0, dx: 1, dy: 0 }, {
      resolve: () => ({ accepted: true, consumedTurn: false }),
    })
    expect(r.accepted).toBe(true)
    expect(r.consumedTurn).toBe(false)
  })

  it('omits reason when the verdict has none (exactOptionalPropertyTypes)', () => {
    const w = createWorld()
    const r = w.action(Move, { entity: 0, dx: 1, dy: 0 }, {
      resolve: () => ({ accepted: true }),
    })
    expect('reason' in r).toBe(false)
  })

  it('includes a post-action snapshot when snapshot:true', () => {
    const w = createWorld()
    const id = w.spawn([entry(Position, { x: 0, y: 0 })])
    w.system('apply', { schedule: 'event', triggers: [Move] }, (ctx) => {
      for (const m of ctx.events.of(Move)) {
        const p = ctx.world.getComponent(m.entity, Position)
        if (p) {
          p.x += m.dx
          p.y += m.dy
        }
      }
    })
    const r = w.action(Move, { entity: id, dx: 3, dy: 4 }, { snapshot: true })
    expect(r.snapshot).toBeDefined()
    const ent = r.snapshot!.entities.find((e) => e.id === id)
    expect(ent!.components.Position).toEqual({ x: 3, y: 4 })
  })

  it('forwards SnapshotOptions when snapshot is an options object', () => {
    const w = createWorld()
    w.spawn([]) // bare entity: empty serializable bag
    const r = w.action(Move, { entity: 0, dx: 0, dy: 0 }, {
      snapshot: { pruneEmptyEntities: true },
    })
    expect(r.snapshot!.entities).toHaveLength(0)
  })

  it('passes dt through to the underlying step', () => {
    const w = createWorld()
    let ticks = 0
    w.system('tickers', { schedule: 'tick' }, () => {
      ticks++
    })
    w.action(Move, { entity: 0, dx: 1, dy: 0 }, { dt: 0.016 })
    expect(ticks).toBe(1)
    expect(w.time.delta).toBe(0.016)
  })

  describe('non-positive dt (heartbeat — action not processed)', () => {
    it('does not report the unprocessed action event as a downstream event', () => {
      const w = createWorld()
      const r = w.action(Move, { entity: 0, dx: 1, dy: 0 }, { dt: 0 })
      expect(r.events).toEqual([])
    })

    it('defaults to accepted:false / consumedTurn:false with a reason', () => {
      const w = createWorld()
      const r = w.action(Move, { entity: 0, dx: 1, dy: 0 }, { dt: 0 })
      expect(r.accepted).toBe(false)
      expect(r.consumedTurn).toBe(false)
      expect(r.reason).toMatch(/heartbeat/)
    })

    it('does not invoke the resolver (there was no tick to adjudicate)', () => {
      const w = createWorld()
      let called = 0
      const r = w.action(Move, { entity: 0, dx: 1, dy: 0 }, {
        dt: -1,
        resolve: () => {
          called++
          return { accepted: true }
        },
      })
      expect(called).toBe(0)
      expect(r.accepted).toBe(false)
    })

    it('leaves the action pending: the next real tick delivers it', () => {
      const w = createWorld()
      const seen: number[] = []
      w.system('actor', { schedule: 'event', triggers: [Move] }, (ctx) => {
        for (const m of ctx.events.of(Move)) seen.push(m.entity)
      })
      const startTick = w.time.tick
      w.action(Move, { entity: 9, dx: 1, dy: 0 }, { dt: 0 })
      expect(seen).toEqual([]) // heartbeat: no systems ran
      expect(w.time.tick).toBe(startTick) // no tick advanced
      w.stepOnce()
      expect(seen).toEqual([9]) // the buffered action flushed on the real tick
    })

    it('still honors snapshot:true on a heartbeat', () => {
      const w = createWorld()
      const r = w.action(Move, { entity: 0, dx: 0, dy: 0 }, { dt: 0, snapshot: true })
      expect(r.snapshot).toBeDefined()
    })
  })

  it('turn() stays void', () => {
    const w = createWorld()
    const ret = w.turn(Move, { entity: 0, dx: 1, dy: 0 }) as unknown
    expect(ret).toBeUndefined()
  })

  describe('payload validation against a declared schema (O-39)', () => {
    const Strike = defineEvent<{ amount: number; kind?: string }>('Strike', {
      schema: {
        fields: {
          amount: { kind: 'number' },
          kind: { kind: 'enum', options: ['slash', 'pierce'] },
        },
      },
    })

    it('rejects a typo’d field: no emit, no tick, no consumed turn', () => {
      const w = createWorld()
      const seen: number[] = []
      w.system('on-strike', { schedule: 'event', triggers: [Strike] }, (ctx) => {
        for (const s of ctx.events.of(Strike)) seen.push(s.amount)
      })
      const startTick = w.time.tick
      const r = w.action(Strike, { amoutn: 3 } as never)
      expect(r.accepted).toBe(false)
      expect(r.consumedTurn).toBe(false)
      expect(r.reason).toMatch(/unknown field "amoutn"/)
      expect(r.events).toEqual([])
      expect(w.time.tick).toBe(startTick) // command never entered the world
      w.stepOnce()
      expect(seen).toEqual([]) // and was not buffered either
    })

    it('rejects a wrong-typed field and an out-of-enum value', () => {
      const w = createWorld()
      const bad = w.action(Strike, { amount: 'three' } as never)
      expect(bad.accepted).toBe(false)
      expect(bad.reason).toMatch(/must be a number/)
      const badEnum = w.action(Strike, { amount: 1, kind: 'bludgeon' } as never)
      expect(badEnum.accepted).toBe(false)
      expect(badEnum.reason).toMatch(/must be one of/)
    })

    it('accepts a valid payload; absent declared fields are optional', () => {
      const w = createWorld()
      const r = w.action(Strike, { amount: 2 })
      expect(r.accepted).toBe(true)
      expect(r.consumedTurn).toBe(true)
    })

    it('schema-less events remain unvalidated (opt-in strictness)', () => {
      const w = createWorld()
      const r = w.action(Move, { wat: true } as never)
      expect(r.accepted).toBe(true)
    })
  })
})
