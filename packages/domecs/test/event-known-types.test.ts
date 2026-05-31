import { describe, expect, it } from 'vitest'
import { createEventBus, defineEvent } from '../src/events.js'

const A = defineEvent<number>('A')
const B = defineEvent<number>('B')

describe('EventBus.knownTypes — enumerates types the bus has seen', () => {
  it('lists a type after it is emitted', () => {
    const bus = createEventBus()
    bus.emit(A, 1)
    expect(bus.knownTypes().map((t) => t.name)).toEqual(['A'])
  })

  it('lists a type after subscription, before any emit', () => {
    const bus = createEventBus()
    bus.on(B, () => {})
    expect(bus.knownTypes().map((t) => t.name)).toContain('B')
  })

  it('does not duplicate a type seen multiple times', () => {
    const bus = createEventBus()
    bus.emit(A, 1)
    bus.emit(A, 2)
    bus.on(A, () => {})
    expect(bus.knownTypes().filter((t) => t.name === 'A')).toHaveLength(1)
  })
})
