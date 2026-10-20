import { describe, expect, it } from 'vitest'
import { createAgentBridge } from '../src/agent.js'
import { defineEvent, type EventType } from '../src/events.js'
import { createWorld } from '../src/world.js'

// The command boundary only accepts tokens made by defineEvent(). A string or
// a look-alike object has no event identity, so the bus cannot route it to a
// handler: before this guard, action() emitted it anyway, ticked, and reported
// { accepted: true } while nothing ran.

const Move = defineEvent<{ dx: number }>('Move')

function fakeToken(value: unknown): EventType<{ dx: number }> {
  return value as EventType<{ dx: number }>
}

describe('world.action — rejects tokens not made by defineEvent', () => {
  for (const [label, token] of [
    ['a string event name', 'Move'],
    ['an object with only a name', { name: 'Move' }],
    ['null', null],
    ['undefined', undefined],
  ] as const) {
    it(`rejects ${label} without emitting or ticking`, () => {
      const w = createWorld({ headless: true })
      const seen: number[] = []
      w.system('mover', { schedule: 'event', triggers: [Move] }, ({ events }) => {
        for (const m of events.of(Move)) seen.push(m.dx)
      })
      const startTick = w.time.tick

      const result = w.action(fakeToken(token), { dx: 1 })

      expect(result.accepted).toBe(false)
      expect(result.consumedTurn).toBe(false)
      expect(result.events).toEqual([])
      expect(result.reason).toMatch(/defineEvent/)
      expect(w.time.tick).toBe(startTick)
      expect(seen).toEqual([])
      // Nothing was left buffered to fire on a later tick.
      w.stepOnce()
      expect(seen).toEqual([])
    })
  }

  it('names the string it was given, so the caller can find the real token', () => {
    const w = createWorld({ headless: true })
    const result = w.action(fakeToken('Move'), { dx: 1 })
    expect(result.reason).toContain('"Move"')
  })

  it('still accepts a real EventType', () => {
    const w = createWorld({ headless: true })
    const seen: number[] = []
    w.system('mover', { schedule: 'event', triggers: [Move] }, ({ events }) => {
      for (const m of events.of(Move)) seen.push(m.dx)
    })
    const result = w.action(Move, { dx: 2 })
    expect(result.accepted).toBe(true)
    expect(seen).toEqual([2])
  })

  it('bridge.act inherits the rejection', () => {
    const w = createWorld({ headless: true })
    const bridge = createAgentBridge(w)
    const startTick = w.time.tick
    const result = bridge.act(fakeToken('Move'), { dx: 1 })
    expect(result.accepted).toBe(false)
    expect(w.time.tick).toBe(startTick)
  })
})

describe('world.action — token edge cases', () => {
  it('keeps commands already pending when it rejects a bad token', () => {
    const w = createWorld({ headless: true })
    const seen: number[] = []
    w.system('mover', { schedule: 'event', triggers: [Move] }, ({ events }) => {
      for (const m of events.of(Move)) seen.push(m.dx)
    })
    w.emit(Move, { dx: 5 })

    expect(w.action(fakeToken('Move'), { dx: 1 }).accepted).toBe(false)
    expect(seen).toEqual([])

    w.stepOnce()
    expect(seen).toEqual([5])
  })

  it('does not register the rejected token as an event type', () => {
    const w = createWorld({ headless: true })
    w.action(fakeToken('Ghost'), { dx: 1 })
    w.action(fakeToken({ name: 'Ghost' }), { dx: 1 })
    expect(w.describe().events.map((e) => e.name)).not.toContain('Ghost')
    expect(w.describe().events.some((e) => typeof e.name !== 'string')).toBe(false)
  })

  it('rejects, rather than throws on, a token whose properties throw when read', () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    const w = createWorld({ headless: true })
    const result = w.action(fakeToken(proxy), { dx: 1 })
    expect(result.accepted).toBe(false)
    expect(result.reason).toMatch(/could not be read/)
    expect(w.time.tick).toBe(0)
  })

  it('accepts a frozen token', () => {
    const Frozen = Object.freeze(defineEvent<{ dx: number }>('Frozen'))
    const w = createWorld({ headless: true })
    const seen: number[] = []
    w.system('frozen', { schedule: 'event', triggers: [Frozen] }, ({ events }) => {
      for (const m of events.of(Frozen)) seen.push(m.dx)
    })
    expect(w.action(Frozen, { dx: 3 }).accepted).toBe(true)
    expect(seen).toEqual([3])
  })

  it('routes tokens made by another copy of @domecs/core, without crosstalk', () => {
    // What a second installed copy's defineEvent() produces: the shared
    // registered tag key, holding that copy's own per-event symbol.
    const foreign = (name: string) =>
      ({ name, [Symbol.for('domecs.eventTag')]: Symbol(name) }) as unknown as EventType<{ dx: number }>
    const ForeignA = foreign('A')
    const ForeignB = foreign('B')
    const w = createWorld({ headless: true })
    const seenA: number[] = []
    const seenB: number[] = []
    w.system('a', { schedule: 'event', triggers: [ForeignA] }, ({ events }) => {
      for (const m of events.of(ForeignA)) seenA.push(m.dx)
    })
    w.system('b', { schedule: 'event', triggers: [ForeignB] }, ({ events }) => {
      for (const m of events.of(ForeignB)) seenB.push(m.dx)
    })

    expect(w.action(ForeignA, { dx: 1 }).accepted).toBe(true)
    expect(seenA).toEqual([1])
    expect(seenB).toEqual([])
  })
})
