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
