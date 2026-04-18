import { describe, expect, it } from 'vitest'
import { defineEvent } from '../src/events.js'
import { createWorld } from '../src/world.js'

const Attack = defineEvent<{ target: number; damage: number }>('Attack')
const TurnPassed = defineEvent<number>('TurnPassed')

describe('events', () => {
  it('emit buffers; view is empty until next step', () => {
    const w = createWorld()
    w.emit(Attack, { target: 1, damage: 4 })
    expect(w.events.of(Attack)).toEqual([])
  })

  it('flush at step 1 makes events readable (SPEC §2.6)', () => {
    const w = createWorld()
    w.emit(Attack, { target: 1, damage: 4 })
    w.emit(Attack, { target: 2, damage: 7 })
    w.step(0.016)
    expect(w.events.of(Attack)).toEqual([
      { target: 1, damage: 4 },
      { target: 2, damage: 7 },
    ])
  })

  it('events emitted in tick N are delivered in tick N+1', () => {
    const w = createWorld()
    w.step(0.016) // tick 1, no events
    expect(w.events.of(TurnPassed)).toEqual([])
    w.emit(TurnPassed, 42)
    // emit during/between ticks: still not visible yet
    expect(w.events.of(TurnPassed)).toEqual([])
    w.step(0.016) // tick 2 — flush delivers
    expect(w.events.of(TurnPassed)).toEqual([42])
    // next tick: buffer rolls over; last-tick payloads are cleared
    w.step(0.016)
    expect(w.events.of(TurnPassed)).toEqual([])
  })

  it('world.on() delivers payloads synchronously at flush', () => {
    const w = createWorld()
    const seen: number[] = []
    w.on(TurnPassed, (n) => seen.push(n))
    w.emit(TurnPassed, 1)
    w.emit(TurnPassed, 2)
    expect(seen).toEqual([])
    w.step(0.016)
    expect(seen).toEqual([1, 2])
  })

  it('world.on() unsubscribe works', () => {
    const w = createWorld()
    let count = 0
    const off = w.on(TurnPassed, () => count++)
    w.emit(TurnPassed, 1)
    w.step(0.016)
    expect(count).toBe(1)
    off()
    w.emit(TurnPassed, 2)
    w.step(0.016)
    expect(count).toBe(1)
  })

  it('events typed by EventType name are isolated per type', () => {
    const w = createWorld()
    w.emit(Attack, { target: 1, damage: 4 })
    w.emit(TurnPassed, 99)
    w.step(0.016)
    expect(w.events.of(Attack)).toEqual([{ target: 1, damage: 4 }])
    expect(w.events.of(TurnPassed)).toEqual([99])
  })
})

describe('world.setScale / pause / resume', () => {
  it('setScale(0) zeroes scaledDelta', () => {
    const w = createWorld()
    w.setScale(0)
    w.step(0.016)
    expect(w.time.scaledDelta).toBe(0)
  })

  it('pause() then resume() restores prior scale', () => {
    const w = createWorld()
    w.setScale(2)
    w.pause()
    expect(w.time.scale).toBe(0)
    w.resume()
    expect(w.time.scale).toBe(2)
  })
})
