import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import type { WorldSnapshot } from '../src/snapshot.js'
import type { TimeState } from '../src/time.js'
import { entry } from '../src/types.js'
import { createWorld, type World } from '../src/world.js'

// H-16 (Harbor findings): the fixed-step count was floor(total / fixedStep +
// 1e-9) over a total accumulated in floating point, so for a step that is not
// a binary fraction the error outgrew the tolerance and `step(fixedStep)` ran
// no fixed step at all on some tick (#22,785 at the default 1/60). H-3: a
// fixed system saw the frame's `ctx.time`, not the step's.

const STEPS = [1 / 60, 1 / 30, 1 / 15, 1 / 20, 1 / 16, 1 / 64, 1 / 50, 1 / 24, 0.1]

function counting(fixedStep: number): { w: World; fired: () => number } {
  const w = createWorld({ headless: true, fixedStep })
  let fired = 0
  w.system('count', { schedule: 'fixed' }, () => {
    fired++
  })
  return { w, fired: () => fired }
}

describe('fixed steps — one per step(fixedStep), for any fixedStep (H-16)', () => {
  it('runs exactly one fixed step on every one of 30,000 ticks of step(fixedStep)', () => {
    for (const h of STEPS) {
      const { w, fired } = counting(h)
      let firstBad = -1
      for (let i = 1; i <= 30_000; i++) {
        w.step(h)
        if (fired() !== i && firstBad < 0) firstBad = i
      }
      expect({ h, firstBad, fired: fired() }).toEqual({ h, firstBad: -1, fired: 30_000 })
    }
  })

  it('a frame of n steps runs n, frame after frame', () => {
    for (const h of STEPS) {
      for (const n of [2, 3, 7, 16, 17, 48]) {
        const { w, fired } = counting(h)
        for (let frame = 1; frame <= 400; frame++) {
          w.step(n * h)
          if (fired() !== n * frame) {
            expect({ h, n, frame, fired: fired() }).toEqual({ h, n, frame, fired: n * frame })
          }
        }
      }
    }
  })

  it('worlds stepped the same time in different chunks have run the same steps', () => {
    for (const h of STEPS) {
      const worlds = [1, 16, 17].map((chunk) => ({ chunk, ...counting(h) }))
      for (let total = 0; total < 16 * 17 * 20; ) {
        total += 16 * 17
        for (const { w, chunk } of worlds) {
          for (let k = 0; k < (16 * 17) / chunk; k++) w.step(chunk * h)
        }
        const counts = worlds.map(({ fired }) => fired())
        expect(counts).toEqual([total, total, total])
        expect(worlds.map(({ w }) => w.time.fixedTick)).toEqual([total, total, total])
      }
    }
  })

  it('keeps the remainder between ticks: 1/3 of a step per tick runs a step every third tick', () => {
    const h = 1 / 60
    const { w, fired } = counting(h)
    const at: number[] = []
    for (let i = 1; i <= 12; i++) {
      const before = fired()
      w.step(h / 3)
      if (fired() > before) at.push(i)
    }
    expect(at).toEqual([3, 6, 9, 12])
  })

  it('a paused world owes the time, and runs it on resume', () => {
    const { w, fired } = counting(0.1)
    w.pause()
    w.step(0.25)
    expect(fired()).toBe(0)
    w.resume()
    w.step(0.05)
    expect(fired()).toBe(0) // scale 0 owed nothing: pause means time stops
    w.step(0.05)
    expect(fired()).toBe(1)
  })
})

describe('the fixed clock a fixed system sees (H-3)', () => {
  it('each sub-step sees its own step: delta, scaledDelta, elapsed and fixedTick', () => {
    const w = createWorld({ headless: true, fixedStep: 1 / 16 })
    const seen: Array<Pick<TimeState, 'tick' | 'delta' | 'scaledDelta' | 'elapsed' | 'fixedTick'>> = []
    w.system('f', { schedule: 'fixed' }, ({ time }) => {
      seen.push({
        tick: time.tick,
        delta: time.delta,
        scaledDelta: time.scaledDelta,
        elapsed: time.elapsed,
        fixedTick: time.fixedTick,
      })
    })
    w.step(4 / 16)
    expect(seen).toEqual([1, 2, 3, 4].map((k) => ({
      tick: 1,
      delta: 1 / 16,
      scaledDelta: 1 / 16,
      elapsed: k / 16,
      fixedTick: k,
    })))
  })

  it('ctx.time.fixedStep matches, and a tick system still sees the frame', () => {
    const w = createWorld({ headless: true, fixedStep: 1 / 15 })
    let tickSeen: Readonly<TimeState> | undefined
    const fixedSeen: number[] = []
    w.system('f', { schedule: 'fixed' }, ({ time }) => void fixedSeen.push(time.fixedStep))
    w.system('t', {}, ({ time }) => {
      tickSeen = { ...time }
    })
    w.step(4 / 15)
    expect(fixedSeen).toEqual([1 / 15, 1 / 15, 1 / 15, 1 / 15])
    expect(tickSeen!.scaledDelta).toBe(0.267)
    expect(tickSeen!.elapsed).toBe(0.267)
    expect(tickSeen!.fixedTick).toBe(4)
  })

  it('integrating with ctx.time.scaledDelta covers the same ground at any time scale', () => {
    const Pos = defineComponent<{ x: number }>('FcPos', { defaults: { x: 0 } })
    const run = (scale: number, frames: number): number => {
      const w = createWorld({ headless: true, fixedStep: 1 / 16 })
      const id = w.spawn([entry(Pos, { x: 0 })])
      w.system('move', { schedule: 'fixed', query: [Pos] }, ({ entities, time }) => {
        for (const e of entities) w.getComponent(e.id, Pos)!.x += 3 * time.scaledDelta
      })
      w.setScale(scale)
      for (let i = 0; i < frames; i++) w.step(1 / 16)
      return w.getComponent(id, Pos)!.x
    }
    // 64 scaled seconds either way: 1024 frames at 1×, 16 frames at 64×.
    expect(run(1, 1024)).toBe(192)
    expect(run(64, 16)).toBe(192)
  })

  it('world.time.fixedTick counts steps run; alpha is the share of a step owed', () => {
    const w = createWorld({ headless: true, fixedStep: 0.25 })
    w.step(0.375)
    expect(w.time.fixedTick).toBe(1)
    expect(w.time.fixedAccumulator).toBe(0.125)
    expect(w.time.alpha).toBe(0.5)
    w.step(0.125)
    expect(w.time.fixedTick).toBe(2)
    expect(w.time.alpha).toBe(0)
  })

  it('a rateHz system sees its own period as the step', () => {
    const w = createWorld({ headless: true, fixedStep: 1 / 16 })
    const seen: Array<[number, number]> = []
    w.system('slow', { schedule: 'fixed', rateHz: 4 }, ({ time }) => void seen.push([time.fixedTick, time.scaledDelta]))
    for (let i = 0; i < 8; i++) w.step(1 / 16)
    expect(seen).toEqual([[4, 1 / 4], [8, 1 / 4]])
  })
})

describe('the fixed clock in snapshots (H-16)', () => {
  it('carries the step count and remainder exactly, so a twin keeps the live cadence', () => {
    const h = 1 / 60
    const live = counting(h)
    for (let i = 0; i < 25_000; i++) live.w.step(h)
    live.w.step(h / 2)
    const snap = JSON.parse(JSON.stringify(live.w.snapshot())) as WorldSnapshot
    expect(snap.fixedTick).toBe(25_000)
    expect(snap.fixedAccumulator).toBe(h / 2)
    expect(snap.fixedStep).toBe(h)

    const twin = counting(h)
    twin.w.restore(snap)
    expect(twin.w.time.fixedTick).toBe(25_000)
    expect(twin.w.time.fixedAccumulator).toBe(live.w.time.fixedAccumulator)
    for (let i = 0; i < 1000; i++) {
      live.w.step(h)
      twin.w.step(h)
    }
    expect(twin.fired()).toBe(1000)
    expect(live.fired()).toBe(26_000)
    expect(twin.w.time.fixedTick).toBe(live.w.time.fixedTick)
  })

  it('a snapshot written before H-16 (fixedBacklog, no fixedTick) restores as it used to', () => {
    const w = counting(0.1).w
    const legacy = {
      version: 3,
      seed: [1, 2, 3, 4],
      tick: 3,
      scaledTime: 0.55,
      fixedBacklog: 2,
      fixedStep: 0.1,
      entities: [],
    } as unknown as WorldSnapshot
    w.restore(legacy)
    expect(w.time.fixedTick).toBe(3) // 5 due, 2 owed
    expect(w.time.fixedAccumulator).toBeCloseTo(0.25, 12)
  })

  it('a world restored with another fixedStep re-counts the time the steps stood for', () => {
    const live = counting(1 / 60)
    for (let i = 0; i < 600; i++) live.w.step(1 / 60) // 10 s
    const snap = live.w.snapshot()
    const w = counting(1 / 120)
    w.w.restore(snap)
    expect(w.w.time.fixedTick).toBe(1200)
    expect(w.w.time.fixedAccumulator).toBeCloseTo(0, 12)
    w.w.step(1 / 120)
    expect(w.fired()).toBe(1)
  })

  it('rejects a malformed fixedTick or fixedAccumulator before touching the world', () => {
    const { w } = counting(0.1)
    w.step(0.25)
    const good = w.snapshot()
    for (const bad of [-1, 1.5, Number.NaN, null]) {
      expect(() => w.restore({ ...good, fixedTick: bad as unknown as number })).toThrow(/fixedTick/)
    }
    for (const bad of [-0.5, Number.NaN, Number.POSITIVE_INFINITY, '0' as unknown as number]) {
      expect(() => w.restore({ ...good, fixedAccumulator: bad })).toThrow(/fixedAccumulator/)
    }
    expect(w.time.fixedTick).toBe(2)
  })
})

describe('sub-rate fixed systems can be spread over their period (H-14)', () => {
  function firing(def: { rateHz: number; phase?: number }, steps: number): number[] {
    const w = createWorld({ headless: true, fixedStep: 1 / 15 })
    const at: number[] = []
    w.system('s', { schedule: 'fixed', ...def }, ({ time }) => void at.push(time.fixedTick))
    for (let i = 0; i < steps; i++) w.step(1 / 15)
    return at
  }

  it('phase 0 keeps the default: a 1 Hz system first runs after a full period', () => {
    expect(firing({ rateHz: 1 }, 45)).toEqual([15, 30, 45])
    expect(firing({ rateHz: 1, phase: 0 }, 45)).toEqual([15, 30, 45])
  })

  it('phase p runs the system p steps earlier in every period', () => {
    expect(firing({ rateHz: 1, phase: 14 }, 45)).toEqual([1, 16, 31])
    expect(firing({ rateHz: 1, phase: 5 }, 45)).toEqual([10, 25, 40])
    expect(firing({ rateHz: 5, phase: 1 }, 9)).toEqual([2, 5, 8])
  })

  it('three 1 Hz systems with phases 0, 5 and 10 never share a step', () => {
    const w = createWorld({ headless: true, fixedStep: 1 / 15 })
    const perStep = new Map<number, number>()
    for (const phase of [0, 5, 10]) {
      w.system(`slow${phase}`, { schedule: 'fixed', rateHz: 1, phase }, ({ time }) => {
        perStep.set(time.fixedTick, (perStep.get(time.fixedTick) ?? 0) + 1)
      })
    }
    for (let i = 0; i < 60; i++) w.step(1 / 15)
    expect([...perStep.values()].every((n) => n === 1)).toBe(true)
    expect(perStep.size).toBe(12)
  })

  it('a restored world keeps a phased system on the live steps', () => {
    const mk = (): { w: World; at: number[] } => {
      const w = createWorld({ headless: true, fixedStep: 1 / 15 })
      const at: number[] = []
      w.system('s', { schedule: 'fixed', rateHz: 3, phase: 2 }, ({ time }) => void at.push(time.fixedTick))
      return { w, at }
    }
    const live = mk()
    for (let i = 0; i < 7; i++) live.w.step(1 / 15)
    const twin = mk()
    twin.w.restore(live.w.snapshot())
    live.at.length = 0
    for (const { w } of [live, twin]) for (let i = 0; i < 11; i++) w.step(1 / 15)
    expect(twin.at).toEqual(live.at)
    expect(live.at).toEqual([8, 13, 18])
  })

  it('refuses a phase outside 0 … divisor − 1, or not an integer', () => {
    const w = createWorld({ headless: true, fixedStep: 1 / 15 })
    for (const phase of [-1, 15, 1.5, Number.NaN]) {
      expect(() => w.system(`bad${phase}`, { schedule: 'fixed', rateHz: 1, phase }, () => {})).toThrow(/phase/)
    }
    expect(() => w.system('full', { schedule: 'fixed', phase: 1 }, () => {})).toThrow(/phase=1 must be an integer from 0 to 0/)
  })
})
