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
    delete g.requestAnimationFrame
    try {
      const w = createWorld()
      expect(() => w.start()).toThrowError(/requestAnimationFrame/)
    } finally {
      // Reinstall the harness so afterEach's restore() has something to
      // clean up and so any later tests in this block still get stubs.
      raf = installRaf() as RafHarness & { restore: () => void }
    }
  })

  it('start() returns a disposer that stops the loop', () => {
    const w = createWorld()
    const dispose = w.start()
    expect(raf.pending()).toBe(true)
    dispose()
    expect(raf.pending()).toBe(false)
  })

  it('stop() is idempotent — calling it twice does not double-cancel', () => {
    const w = createWorld()
    w.start()
    w.stop()
    expect(raf.cancels).toBe(1)
    w.stop()
    expect(raf.cancels).toBe(1)
  })

  it('survives repeated start/stop cycles without dt spikes', () => {
    const w = createWorld()
    const seen: number[] = []
    w.system('tap', { schedule: 'tick' }, () => { seen.push(w.time.delta) })
    for (let i = 0; i < 3; i++) {
      w.start()
      raf.advance(16)      // prime
      raf.advance(16)      // step(0.016)
      w.stop()
      raf.advance(2_000)   // long gap outside the loop
    }
    for (const d of seen) expect(d).toBeLessThan(1)
    expect(seen.length).toBeGreaterThanOrEqual(3)
  })
})

describe('World.start() — visibilitychange handling (F-5)', () => {
  interface DocStub {
    hidden: boolean
    addEventListener: (t: string, cb: () => void) => void
    removeEventListener: (t: string, cb: () => void) => void
    _dispatch(): void
  }
  function installDocument(): DocStub {
    const listeners = new Set<() => void>()
    const doc: DocStub = {
      hidden: false,
      addEventListener: (type, cb) => {
        if (type === 'visibilitychange') listeners.add(cb)
      },
      removeEventListener: (type, cb) => {
        if (type === 'visibilitychange') listeners.delete(cb)
      },
      _dispatch(): void {
        for (const cb of listeners) cb()
      },
    }
    const globals = globalThis as unknown as { document?: unknown }
    const prev = globals.document
    globals.document = doc
    ;(doc as unknown as { restore: () => void }).restore = (): void => {
      if (prev === undefined) delete globals.document
      else globals.document = prev
    }
    return doc
  }

  let raf: RafHarness & { restore: () => void }
  let doc: DocStub & { restore?: () => void }
  beforeEach(() => {
    raf = installRaf() as RafHarness & { restore: () => void }
    doc = installDocument() as DocStub & { restore: () => void }
  })
  afterEach(() => {
    doc.restore?.()
    raf.restore()
  })

  it('pauses world when hidden=true, resumes on re-show, and discards gap', () => {
    const w = createWorld()
    const seen: number[] = []
    w.system('tap', { schedule: 'tick' }, () => { seen.push(w.time.delta) })
    w.start({ dtClampMs: 100 })
    raf.advance(16)             // prime
    raf.advance(16)             // step(0.016)
    expect(seen[0]).toBeCloseTo(0.016, 3)
    // Simulate tab-hide.
    doc.hidden = true
    doc._dispatch()
    expect(w.time.scale).toBe(0)
    // rAF frames keep arriving but scale=0 means no tick systems run.
    const before = seen.length
    raf.advance(5_000)
    expect(seen.length).toBe(before)
    // Re-show: resume + rafLastWallMs reset.
    doc.hidden = false
    doc._dispatch()
    expect(w.time.scale).toBe(1)
    raf.advance(16)             // priming frame after reset
    raf.advance(16)             // step(0.016), NOT step(5.016)
    w.stop()
    const last = seen[seen.length - 1]!
    expect(last).toBeLessThan(1)
  })

  it('removeEventListener on stop(): late visibilitychange events are ignored', () => {
    const w = createWorld()
    w.start()
    w.stop()
    // The handler was removed; dispatching post-stop must NOT throw and must
    // NOT flip world scale (no lingering pause/resume).
    doc.hidden = true
    expect(() => doc._dispatch()).not.toThrow()
    expect(w.time.scale).toBe(1)
  })

  it('pauseOnHidden:false opts out entirely', () => {
    const w = createWorld()
    w.start({ pauseOnHidden: false })
    doc.hidden = true
    doc._dispatch()
    // No handler attached → no pause.
    expect(w.time.scale).toBe(1)
    w.stop()
  })
})
