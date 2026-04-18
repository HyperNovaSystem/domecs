import { describe, expect, it } from 'vitest'
import { createRng, restoreRng } from '../src/rng.js'

describe('rng — xoshiro128**', () => {
  it('is deterministic for the same seed', () => {
    const a = createRng(0xC0FFEE)
    const b = createRng(0xC0FFEE)
    for (let i = 0; i < 100; i++) {
      expect(a.next()).toBe(b.next())
    }
  })

  it('next() yields values in [0, 1)', () => {
    const r = createRng(1)
    for (let i = 0; i < 1000; i++) {
      const v = r.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('int(max) returns integers in [0, max)', () => {
    const r = createRng(42)
    for (let i = 0; i < 1000; i++) {
      const v = r.int(6)
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(6)
    }
  })

  it('roll(sides) returns [1, sides]', () => {
    const r = createRng(123)
    const seen = new Set<number>()
    for (let i = 0; i < 1000; i++) {
      const v = r.roll(20)
      seen.add(v)
      expect(v).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(20)
    }
    expect(seen.size).toBeGreaterThan(10)
  })

  it('pick selects from the array deterministically', () => {
    const r1 = createRng(7)
    const r2 = createRng(7)
    const arr = ['a', 'b', 'c', 'd']
    for (let i = 0; i < 50; i++) expect(r1.pick(arr)).toBe(r2.pick(arr))
  })

  it('seed() state snapshots survive round-trip via restoreRng', () => {
    const r = createRng(999)
    for (let i = 0; i < 17; i++) r.next()
    const snap = r.seed()
    const restored = restoreRng(snap)
    const next1 = r.next()
    const next2 = restored.next()
    expect(next1).toBe(next2)
  })

  it('fork(label) produces a distinct but deterministic stream', () => {
    const parent1 = createRng(5)
    const parent2 = createRng(5)
    const a = parent1.fork('ai')
    const b = parent2.fork('ai')
    const c = parent1.fork('fx')
    // same label, same parent state => same stream
    expect(a.next()).toBe(b.next())
    // different label => different stream
    const aNext = a.next()
    const cNext = c.next()
    expect(aNext).not.toBe(cNext)
  })
})
