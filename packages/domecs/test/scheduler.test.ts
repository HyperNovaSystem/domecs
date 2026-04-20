import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import { defineEvent } from '../src/events.js'
import { And, Changed, Has, Not, Or } from '../src/query.js'
import { createWorld } from '../src/world.js'

const Position = defineComponent<{ x: number; y: number }>('Position', {
  defaults: { x: 0, y: 0 },
})
const Velocity = defineComponent<{ dx: number; dy: number }>('Velocity', {
  defaults: { dx: 0, dy: 0 },
})

const Move = defineEvent<{ entity: number; dx: number; dy: number }>('Move')
const Ignored = defineEvent<number>('Ignored')

describe('system scheduler — tick order (SPEC §4)', () => {
  it('runs tick systems every step', () => {
    const w = createWorld()
    let count = 0
    w.system('count', { schedule: 'tick' }, () => {
      count++
    })
    w.step(0.016)
    w.step(0.016)
    expect(count).toBe(2)
  })

  it('priority order: lower priority runs first, ties by registration order', () => {
    const w = createWorld()
    const order: string[] = []
    w.system('c', { priority: 10 }, () => order.push('c'))
    w.system('a', { priority: 1 }, () => order.push('a'))
    w.system('b', { priority: 1 }, () => order.push('b'))
    w.step(0.016)
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('disable() suspends a system; enable() restores', () => {
    const w = createWorld()
    let n = 0
    const h = w.system('x', {}, () => n++)
    w.step(0.016)
    h.disable()
    w.step(0.016)
    h.enable()
    w.step(0.016)
    expect(n).toBe(2)
  })

  it('SystemDef.enabled() gate overrides per-tick', () => {
    const w = createWorld()
    let running = false
    let n = 0
    w.system('gated', { enabled: () => running }, () => n++)
    w.step(0.016)
    expect(n).toBe(0)
    running = true
    w.step(0.016)
    expect(n).toBe(1)
  })

  it('system query feeds ctx.entities', () => {
    const w = createWorld()
    w.spawn([[Position as never, { x: 0, y: 0 }]])
    w.spawn([[Position as never, { x: 1, y: 2 }]])
    w.spawn()
    let seenIds: number[] = []
    w.system('scan', { query: Has(Position) }, (ctx) => {
      seenIds = (ctx.entities as Array<{ id: number }>).map((e) => e.id)
    })
    w.step(0.016)
    expect(seenIds).toEqual([0, 1])
  })
})

describe('system scheduler — `once` mode', () => {
  it('fires on first step only', () => {
    const w = createWorld()
    let n = 0
    w.system('boot', { schedule: 'once' }, () => n++)
    w.step(0.016)
    w.step(0.016)
    w.step(0.016)
    expect(n).toBe(1)
  })
})

describe('system scheduler — `event` mode', () => {
  it('fires only when triggers have payloads', () => {
    const w = createWorld()
    let moves = 0
    w.system('on-move', { schedule: 'event', triggers: [Move] }, (ctx) => {
      moves += ctx.events.of(Move).length
    })
    w.step(0.016) // no events, no fire
    expect(moves).toBe(0)

    w.emit(Move, { entity: 0, dx: 1, dy: 0 })
    w.emit(Ignored, 1)
    w.step(0.016)
    expect(moves).toBe(1)
  })

  it('turn() emits action + steps in one call', () => {
    const w = createWorld()
    const log: Array<{ dx: number; dy: number }> = []
    w.system('actor', { schedule: 'event', triggers: [Move] }, (ctx) => {
      for (const m of ctx.events.of(Move)) log.push({ dx: m.dx, dy: m.dy })
    })
    w.turn(Move, { entity: 0, dx: 1, dy: 0 })
    w.turn(Move, { entity: 0, dx: 0, dy: 1 })
    expect(log).toEqual([
      { dx: 1, dy: 0 },
      { dx: 0, dy: 1 },
    ])
  })
})

describe('system scheduler — `fixed` mode', () => {
  it('rejects non-divisor rateHz at registration (SPEC §3)', () => {
    const w = createWorld({ fixedStep: 1 / 60 })
    expect(() =>
      w.system('bad', { schedule: 'fixed', rateHz: 25 }, () => {}),
    ).toThrowError(/integer divisor/)
  })

  it('accepts divisor rates and runs each Nth fixed step', () => {
    // Use a ms-exact fixedStep to avoid scaledDelta quantization drift (SPEC §2.7).
    const w = createWorld({ fixedStep: 1 / 50 })
    let phys = 0
    let sim = 0
    w.system('physics', { schedule: 'fixed' }, () => phys++) // 50 Hz
    w.system('sim', { schedule: 'fixed', rateHz: 25 }, () => sim++) // 25 Hz
    for (let i = 0; i < 50; i++) w.step(1 / 50)
    expect(phys).toBe(50)
    expect(sim).toBe(25)
  })

  it('fires exactly N times per N seconds at fixedStep=1/60 (no quantization drift, F-3)', () => {
    const w = createWorld({ fixedStep: 1 / 60 })
    let phys = 0
    w.system('physics', { schedule: 'fixed' }, () => phys++)
    for (let i = 0; i < 60; i++) w.step(1 / 60)
    expect(phys).toBe(60)
  })

  it('fixed systems do not run while paused (scale = 0)', () => {
    const w = createWorld()
    let n = 0
    w.system('p', { schedule: 'fixed' }, () => n++)
    w.pause()
    for (let i = 0; i < 5; i++) w.step(1 / 60)
    expect(n).toBe(0)
  })
})

describe('system scheduler — `reactive` mode', () => {
  it('observes markChanged calls made between ticks (SPEC §2.5, F-2)', () => {
    // Buffer-and-swap: external markChanged calls land in a pending set
    // that is promoted into this tick at step 0 — symmetric with §2.6 events.
    const w = createWorld()
    let calls = 0
    const e = w.spawn([[Position as never, { x: 0, y: 0 }]])
    w.system(
      'react',
      { schedule: 'reactive', reactsTo: Changed(Position) },
      () => {
        calls++
      },
    )
    w.step(0.016)
    expect(calls).toBe(0)
    w.markChanged(e, Position)
    w.step(0.016)
    expect(calls).toBe(1)
    w.step(0.016)
    expect(calls).toBe(1)
  })

  it('rejects reactive registration without a change-detection node (F-5)', () => {
    const w = createWorld()
    // Structural-only reactsTo has no tick-scoped edge — must throw.
    expect(() =>
      w.system('bad', { schedule: 'reactive', reactsTo: Has(Position) }, () => {}),
    ).toThrow(/change-detection/)
    expect(() =>
      w.system(
        'bad2',
        { schedule: 'reactive', reactsTo: And(Has(Position), Not(Has(Velocity))) },
        () => {},
      ),
    ).toThrow(/change-detection/)
    // Missing reactsTo also rejected.
    expect(() => w.system('bad3', { schedule: 'reactive' }, () => {})).toThrow(
      /reactsTo/,
    )
    // Accepts when a change-detection node appears anywhere in the tree.
    expect(() =>
      w.system(
        'good',
        { schedule: 'reactive', reactsTo: And(Has(Position), Changed(Velocity)) },
        () => {},
      ),
    ).not.toThrow()
    expect(() =>
      w.system(
        'good2',
        { schedule: 'reactive', reactsTo: Or(Changed(Position), Changed(Velocity)) },
        () => {},
      ),
    ).not.toThrow()
  })

  it('fires once in the same tick when a tick system marks changes', () => {
    // SPEC §4: reactive systems at step 6 observe mutations made during
    // steps 3–5 of the same tick. Tick-scoped sets are cleared at step 0
    // of the NEXT tick, so mutations must originate from a system (not
    // from external code between ticks).
    const w = createWorld()
    let calls = 0
    const e = w.spawn([[Position as never, { x: 0, y: 0 }]])
    let dirty = false
    w.system('mutate', {}, () => {
      if (dirty) w.markChanged(e, Position)
    })
    w.system(
      'react',
      { schedule: 'reactive', reactsTo: Changed(Position) },
      () => {
        calls++
      },
    )
    w.step(0.016)
    expect(calls).toBe(0)
    dirty = true
    w.step(0.016)
    expect(calls).toBe(1)
    dirty = false
    w.step(0.016)
    expect(calls).toBe(1)
  })
})

describe('step(0) — F-6 heartbeat semantics', () => {
  it('does not invoke fixed/tick/reactive/event systems', () => {
    const w = createWorld()
    let fixedN = 0, tickN = 0, reactiveN = 0, eventN = 0
    const e = w.spawn([[Position as never, { x: 0, y: 0 }]])
    w.system('f', { schedule: 'fixed' }, () => { fixedN++ })
    w.system('t', { schedule: 'tick' }, () => { tickN++ })
    w.system('r', { schedule: 'reactive', reactsTo: Changed(Position) }, () => { reactiveN++ })
    w.system('ev', { schedule: 'event', triggers: [Move] }, () => { eventN++ })
    w.markChanged(e, Position)
    w.emit(Move, { entity: e, dx: 1, dy: 0 })
    w.step(0)
    expect(fixedN).toBe(0)
    expect(tickN).toBe(0)
    expect(reactiveN).toBe(0)
    expect(eventN).toBe(0)
  })

  it('does not advance tick counter or totalScaledSeconds', () => {
    const w = createWorld()
    expect(w.time.tick).toBe(0)
    w.step(0)
    w.step(0)
    w.step(0)
    expect(w.time.tick).toBe(0)
    expect(w.time.elapsed).toBe(0)
  })

  it('preserves between-tick markChanged through step(0) so next real tick still sees it', () => {
    const w = createWorld()
    const e = w.spawn([[Position as never, { x: 0, y: 0 }]])
    let reactiveN = 0
    w.system('r', { schedule: 'reactive', reactsTo: Changed(Position) }, () => { reactiveN++ })
    w.markChanged(e, Position)
    w.step(0)
    w.step(0)
    expect(reactiveN).toBe(0) // no-op did not consume or drop the mark
    w.step(1 / 60)
    expect(reactiveN).toBe(1)
  })

  it('still fires tickStart/tickEnd signals so UI can paint initial state', () => {
    const w = createWorld()
    let starts = 0, ends = 0
    w.signals.tickStart.subscribe(() => { starts++ })
    w.signals.tickEnd.subscribe(() => { ends++ })
    w.step(0)
    expect(starts).toBe(1)
    expect(ends).toBe(1)
  })

  it('floors scaledDelta at 1ms when dt > 0 even under sub-ms wall-clock frames', () => {
    const w = createWorld()
    const seen: number[] = []
    w.system('t', { schedule: 'tick' }, () => { seen.push(w.time.scaledDelta) })
    // dt = 0.3 ms — below 1 ms ms-quantization threshold. Pre-F-6 this rounded to 0.
    w.step(0.0003)
    expect(seen[0]).toBeGreaterThanOrEqual(1 / 1000)
  })
})
