import { describe, expect, it } from 'vitest'
import { defineEvent } from '../src/events.js'
import { createWorld } from '../src/world.js'
import type { SystemicFault } from '../src/errors.js'

const Boom = defineEvent<{ n: number }>('Boom')
const After = defineEvent<number>('After')

describe('event_handler_threw quarantine', () => {
  it('a throwing on() handler does not escape step(); it becomes a fault and delivery continues', () => {
    const w = createWorld()
    const faults: SystemicFault[] = []
    w.signals.faultRaised.subscribe((f) => faults.push(f))

    const alsoRan: Array<{ n: number }> = []
    const afterSeen: number[] = []

    // First subscriber throws; second subscriber to the SAME event must still run.
    w.on(Boom, () => {
      throw new Error('handler exploded')
    })
    w.on(Boom, (e) => {
      alsoRan.push(e)
    })
    // A subsequent event in the SAME flush must still be delivered.
    w.on(After, (n) => {
      afterSeen.push(n)
    })

    w.emit(Boom, { n: 7 })
    w.emit(After, 99)

    // 1. step() does not throw.
    expect(() => w.step(0.016)).not.toThrow()

    // 2 + 3. A fault was routed to faultRaised, identifying the offending event.
    expect(faults.length).toBe(1)
    const fault = faults[0]!
    expect(fault.entry.kind).toBe('event_handler_threw')
    // event name is recoverable (here via detail.event)
    expect(JSON.stringify(fault.entry)).toContain('Boom')

    // The backing detail carries retryable: true and a serialized cause.
    const detail = fault.entry.detail as Record<string, unknown>
    expect(detail.retryable).toBe(true)
    expect(detail.event).toBe('Boom')
    const cause = detail.cause as Record<string, unknown>
    expect(cause.message).toBe('handler exploded')

    // 4. The second (non-throwing) subscriber to the same event still ran.
    expect(alsoRan).toEqual([{ n: 7 }])

    // 5. The subsequent event in the same flush was still delivered.
    expect(afterSeen).toEqual([99])
  })
})
