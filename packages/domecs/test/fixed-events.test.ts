import { describe, expect, it } from 'vitest'
import { hashSnapshot } from '../src/canonical.js'
import { defineComponent } from '../src/component.js'
import { defineEvent } from '../src/events.js'
import type { WorldSnapshot } from '../src/snapshot.js'
import { entry } from '../src/types.js'
import { createWorld, type World } from '../src/world.js'

// H-17 (Harbor findings): an event emitted in a fixed sub-step reached
// `event` systems only after the whole fixed phase, so how many steps passed
// between an emit and its handling depended on how many steps the frame
// held — and a fixed-step sim that used events diverged between frame rates.
// An event system with `fixed: true` runs inside the fixed loop: each
// sub-step delivers the events emitted since the previous one.

const Ping = defineEvent<{ n: number }>('FePing')
const Service = defineEvent<{ crane: number }>('FeService')
const Crane = defineComponent<{ until: number; services: number; condition: number }>('FeCrane', {
  defaults: { until: 0, services: 0, condition: 1 },
})

const H = 1 / 16

/** Step `steps` fixed steps, `perFrame` to a frame. */
function run(w: World, steps: number, perFrame: number): void {
  for (let done = 0; done < steps; done += perFrame) w.step(Math.min(perFrame, steps - done) * H)
}

describe('fixed event systems (H-17)', () => {
  it('an event emitted in sub-step k is handled in sub-step k + 1, at any steps per frame', () => {
    for (const perFrame of [1, 3, 16, 17]) {
      const w = createWorld({ headless: true, fixedStep: H })
      const handled: number[] = []
      w.system('emit', { schedule: 'fixed' }, (ctx) => {
        if (ctx.time.fixedTick % 5 === 0) ctx.events.emit(Ping, { n: ctx.time.fixedTick })
      })
      w.system('handle', { schedule: 'event', fixed: true, triggers: [Ping] }, (ctx) => {
        for (const p of ctx.events.of(Ping)) handled.push(ctx.time.fixedTick - p.n)
      })
      run(w, 40, perFrame)
      expect({ perFrame, handled }).toEqual({ perFrame, handled: [1, 1, 1, 1, 1, 1, 1] })
    }
  })

  it('makes an emit-driven fixed-step sim the same at every frame rate (the Harbor repro)', () => {
    const sim = (perFrame: number): string => {
      const w = createWorld({ headless: true, fixedStep: H, seed: [3, 1, 4, 1] })
      w.register(Service)
      const crane = w.spawn([entry(Crane, { until: 0, services: 0, condition: 1 })])
      // Wear, and a standing order that asks for a service by command.
      w.system('wear', { schedule: 'fixed', query: [Crane] }, (ctx) => {
        for (const e of ctx.entities) {
          const c = e.FeCrane as { until: number; condition: number }
          if (ctx.time.fixedTick >= c.until) c.condition -= 0.01 + ctx.rand.uniform() * 0.01
        }
      })
      w.system('order', { schedule: 'fixed', query: [Crane] }, (ctx) => {
        for (const e of ctx.entities) {
          const c = e.FeCrane as { until: number; condition: number }
          if (c.condition < 0.45 && ctx.time.fixedTick >= c.until) ctx.events.emit(Service, { crane: e.id })
        }
      })
      w.system('service', { schedule: 'event', fixed: true, triggers: [Service] }, (ctx) => {
        for (const { crane: id } of ctx.events.of(Service)) {
          const c = w.getComponent(id, Crane)!
          if (ctx.time.fixedTick < c.until) continue // already in service
          c.until = ctx.time.fixedTick + 30
          c.condition = 1
          c.services += 1
        }
      })
      run(w, 16 * 60, perFrame)
      return JSON.stringify(w.getComponent(crane, Crane))
    }
    const one = sim(1)
    expect(JSON.parse(one).services).toBeGreaterThan(5)
    expect(sim(16)).toBe(one)
    expect(sim(17)).toBe(one)
    expect(sim(48)).toBe(one)
  })

  it('events from outside the fixed loop arrive at the next sub-step that runs', () => {
    const w = createWorld({ headless: true, fixedStep: H })
    const seen: Array<[number, number]> = []
    w.system('handle', { schedule: 'event', fixed: true, triggers: [Ping] }, (ctx) => {
      for (const p of ctx.events.of(Ping)) seen.push([p.n, ctx.time.fixedTick])
    })
    w.system('tickEmit', {}, (ctx) => {
      if (ctx.time.tick === 1) ctx.events.emit(Ping, { n: 2 })
    })
    w.emit(Ping, { n: 1 }) // between ticks: this frame's first sub-step
    w.step(2 * H) // fixed ticks 1, 2; the tick system emits after them
    w.step(H / 2) // no sub-step: n 2 waits
    expect(seen).toEqual([[1, 1]])
    w.step(H / 2) // fixed tick 3
    expect(seen).toEqual([[1, 1], [2, 3]])
  })

  it('sees the sub-step delivery and the step clock, not the frame; tick event systems still see every event once', () => {
    const w = createWorld({ headless: true, fixedStep: H })
    const fixedSaw: Array<{ fixedTick: number; delta: number; n: number[] }> = []
    const tickSaw: number[][] = []
    w.system('emit', { schedule: 'fixed' }, (ctx) => ctx.events.emit(Ping, { n: ctx.time.fixedTick }))
    w.system('fixedRead', { schedule: 'event', fixed: true, triggers: [Ping] }, (ctx) => {
      fixedSaw.push({ fixedTick: ctx.time.fixedTick, delta: ctx.time.scaledDelta, n: ctx.events.of(Ping).map((p) => p.n) })
    })
    w.system('tickRead', { schedule: 'event', triggers: [Ping] }, (ctx) => void tickSaw.push(ctx.events.of(Ping).map((p) => p.n)))
    w.step(3 * H)
    w.step(3 * H)
    expect(fixedSaw).toEqual([2, 3, 4, 5, 6].map((k) => ({ fixedTick: k, delta: H, n: [k - 1] })))
    expect(tickSaw).toEqual([[1, 2, 3]]) // frame 2 sees frame 1's emits, once
  })

  it('runs among the fixed systems in priority order within a sub-step', () => {
    const w = createWorld({ headless: true, fixedStep: H })
    const order: string[] = []
    w.system('late', { schedule: 'fixed', priority: 10 }, () => void order.push('late'))
    w.system('early', { schedule: 'fixed', priority: -10 }, (ctx) => {
      order.push('early')
      if (ctx.time.fixedTick === 1) ctx.events.emit(Ping, { n: 0 })
    })
    w.system('handler', { schedule: 'event', fixed: true, triggers: [Ping] }, () => void order.push('handler'))
    w.step(2 * H)
    expect(order).toEqual(['early', 'late', 'early', 'handler', 'late'])
  })

  it('carries undelivered events in snapshot({ pendingEvents: true }); a twin handles them like the live world', () => {
    const build = (): { w: World; log: number[] } => {
      const w = createWorld({ headless: true, fixedStep: H })
      w.register(Ping)
      const log: number[] = []
      w.system('emit', { schedule: 'fixed' }, (ctx) => {
        if (ctx.time.fixedTick % 4 === 0) ctx.events.emit(Ping, { n: ctx.time.fixedTick })
      })
      w.system('handle', { schedule: 'event', fixed: true, triggers: [Ping] }, (ctx) => {
        for (const p of ctx.events.of(Ping)) log.push(p.n * 100 + ctx.time.fixedTick)
      })
      return { w, log }
    }
    const live = build()
    run(live.w, 8, 4) // emits at 4 (handled at 5) and at 8 (waiting)
    const snap = JSON.parse(JSON.stringify(live.w.snapshot({ pendingEvents: true }))) as WorldSnapshot
    expect(snap.pendingFixedEvents).toEqual([{ event: 'FePing', payload: { n: 8 } }])
    const twin = build()
    twin.w.restore(snap)
    const strict = (w: World): string => hashSnapshot(w.snapshot({ pendingEvents: true }), { includeChanges: true })
    expect(strict(twin.w)).toBe(strict(live.w))
    live.log.length = 0
    for (const { w } of [live, twin]) run(w, 8, 3)
    expect(twin.log).toEqual(live.log)
    expect(live.log).toEqual([809, 1213])
    // Without the option, nothing in flight is written, as for pendingEvents.
    expect(live.w.snapshot()).not.toHaveProperty('pendingFixedEvents')
  })

  it('collects only while a fixed event system is registered', () => {
    const w = createWorld({ headless: true, fixedStep: H })
    w.emit(Ping, { n: 1 })
    expect(w.snapshot({ pendingEvents: true })).not.toHaveProperty('pendingFixedEvents')
    const handle = w.system('handle', { schedule: 'event', fixed: true, triggers: [Ping] }, () => {})
    w.emit(Ping, { n: 2 })
    expect(w.snapshot({ pendingEvents: true }).pendingFixedEvents).toEqual([{ event: 'FePing', payload: { n: 2 } }])
    handle.remove()
    expect(w.snapshot({ pendingEvents: true })).not.toHaveProperty('pendingFixedEvents')
  })

  it('refuses fixed on anything but an event system', () => {
    const w = createWorld({ headless: true })
    expect(() => w.system('bad', { schedule: 'event', fixed: 'yes' as never }, () => {})).toThrow(/fixed/)
    expect(() => w.system('tickFixed', { fixed: true } as never, () => {})).toThrow(/fixed/)
  })
})
