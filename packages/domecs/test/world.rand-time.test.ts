import { describe, expect, it } from 'vitest'
import { createWorld } from '../src/world.js'

describe('world.rand', () => {
  it('is deterministic for the same seed', () => {
    const a = createWorld({ seed: 0xBADCAB })
    const b = createWorld({ seed: 0xBADCAB })
    for (let i = 0; i < 50; i++) {
      expect(a.rand.next()).toBe(b.rand.next())
    }
  })

  it('differs for different seeds', () => {
    const a = createWorld({ seed: 1 })
    const b = createWorld({ seed: 2 })
    const av = a.rand.next()
    const bv = b.rand.next()
    expect(av).not.toBe(bv)
  })
})

describe('world.time', () => {
  it('advances tick and elapsed on step(dt)', () => {
    const w = createWorld({ fixedStep: 1 / 60 })
    expect(w.time.tick).toBe(0)
    expect(w.time.elapsed).toBe(0)
    w.step(0.016)
    expect(w.time.tick).toBe(1)
    expect(w.time.delta).toBeCloseTo(0.016)
    expect(w.time.elapsed).toBeCloseTo(0.016)
    w.step(0.032)
    expect(w.time.tick).toBe(2)
    expect(w.time.elapsed).toBeCloseTo(0.048)
  })

  it('quantizes scaledDelta to ms per SPEC §2.7', () => {
    const w = createWorld()
    w.step(0.0123456)
    // 0.0123456 -> 12.3456 ms -> round 12 ms -> 0.012 s
    expect(w.time.scaledDelta).toBe(0.012)
  })

  it('defaults fixedStep to 1/60', () => {
    const w = createWorld()
    expect(w.time.fixedStep).toBeCloseTo(1 / 60)
  })

  it('respects configured fixedStep', () => {
    const w = createWorld({ fixedStep: 1 / 30 })
    expect(w.time.fixedStep).toBeCloseTo(1 / 30)
  })
})
