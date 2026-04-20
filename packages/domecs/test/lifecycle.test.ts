import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorld } from '../src/world.js'

// Minimal rAF harness: collect the frame callback and advance time
// deterministically via a clock the test drives.
interface RafHarness {
  advance(ms: number): void
  pending(): boolean
  now(): number
  calls: number
  cancels: number
}

function installRaf(): RafHarness {
  let nextHandle = 1
  let clock = 0
  const queue = new Map<number, FrameRequestCallback>()
  const globals = globalThis as unknown as {
    requestAnimationFrame?: (cb: FrameRequestCallback) => number
    cancelAnimationFrame?: (h: number) => void
  }
  const prevRaf = globals.requestAnimationFrame
  const prevCaf = globals.cancelAnimationFrame
  const harness: RafHarness = {
    advance(ms: number): void {
      clock += ms
      const pending = Array.from(queue.entries())
      queue.clear()
      for (const [, cb] of pending) cb(clock)
    },
    pending(): boolean { return queue.size > 0 },
    now(): number { return clock },
    calls: 0,
    cancels: 0,
  }
  globals.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const h = nextHandle++
    queue.set(h, cb)
    harness.calls++
    return h
  }
  globals.cancelAnimationFrame = (h: number): void => {
    queue.delete(h)
    harness.cancels++
  }
  // Restore in afterEach via vi.unstubAllGlobals-ish pattern: register via
  // closure and have caller call harness.restore? Simpler: return and let
  // afterEach overwrite.
  ;(harness as unknown as { restore: () => void }).restore = () => {
    if (prevRaf) globals.requestAnimationFrame = prevRaf
    else delete globals.requestAnimationFrame
    if (prevCaf) globals.cancelAnimationFrame = prevCaf
    else delete globals.cancelAnimationFrame
  }
  return harness
}

describe('World.start()/stop() — F-5 realtime driver', () => {
  let raf: RafHarness & { restore: () => void }
  beforeEach(() => {
    raf = installRaf() as RafHarness & { restore: () => void }
  })
  afterEach(() => {
    raf.restore()
  })

  it('schedules rAF on start and stops on stop()', () => {
    const w = createWorld()
    expect(raf.pending()).toBe(false)
    w.start()
    expect(raf.pending()).toBe(true)
    w.stop()
    expect(raf.pending()).toBe(false)
  })

  it('drives world.step with wall-clock dt converted to seconds', () => {
    const w = createWorld()
    const seen: number[] = []
    w.system('tap', { schedule: 'tick' }, () => { seen.push(w.time.scaledDelta) })
    w.start()
    // First frame primes the clock (no step — lastWallTime captured).
    raf.advance(16)
    // Second frame produces dt = 16ms.
    raf.advance(16)
    w.stop()
    expect(seen.length).toBeGreaterThanOrEqual(1)
    // 16ms converted to seconds: 0.016 (ms-quantized).
    expect(seen[0]).toBeCloseTo(0.016, 3)
  })

  it('clamps absurdly large dt so tab-return freezes do not detonate fixed-step', () => {
    const w = createWorld({ fixedStep: 1 / 60 })
    let fixedN = 0
    w.system('phys', { schedule: 'fixed' }, () => { fixedN++ })
    w.start({ dtClampMs: 100 })
    raf.advance(16)      // prime
    raf.advance(10_000)  // 10s gap (tab was backgrounded)
    w.stop()
    // 10s → clamped to 100ms → at 60 Hz that's 6 fixed steps, not 600.
    expect(fixedN).toBeLessThanOrEqual(7)
    expect(fixedN).toBeGreaterThan(0)
  })

  it('idempotent: calling start() twice does not stack drivers', () => {
    const w = createWorld()
    w.start()
    const firstCalls = raf.calls
    w.start()
    // Second start must not enqueue a second rAF.
    expect(raf.calls).toBe(firstCalls)
    w.stop()
  })

  it('stop() is safe without a prior start()', () => {
    const w = createWorld()
    expect(() => w.stop()).not.toThrow()
  })

  it('restart after stop uses a fresh reference time (no dt spike)', () => {
    const w = createWorld()
    const seen: number[] = []
    w.system('tap', { schedule: 'tick' }, () => { seen.push(w.time.delta) })
    w.start()
    raf.advance(16)       // prime
    raf.advance(16)       // step(0.016)
    w.stop()
    raf.advance(5_000)    // long pause outside the loop; must not leak
    w.start()
    raf.advance(16)       // prime again (no step)
    raf.advance(16)       // step(0.016), NOT step(5.016)
    w.stop()
    // Every emitted delta should be small — no 5s spike slipped through.
    for (const d of seen) expect(d).toBeLessThan(1)
  })

  it('throws in a headless environment without requestAnimationFrame', () => {
    raf.restore()
    const g = globalThis as unknown as {
      requestAnimationFrame?: unknown
      cancelAnimationFrame?: unknown
    }
    const prev = g.requestAnimationFrame
    g.requestAnimationFrame = undefined
    try {
      const w = createWorld()
      expect(() => w.start()).toThrowError(/requestAnimationFrame/)
    } finally {
      g.requestAnimationFrame = prev
      // Reinstall for any later beforeEach-driven tests.
      raf = installRaf() as RafHarness & { restore: () => void }
    }
  })
})
