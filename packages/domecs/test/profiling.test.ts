import { describe, expect, it } from 'vitest'
import { hashSnapshot } from '../src/canonical.js'
import { createWorld, type World } from '../src/world.js'

// P-4 (Harbor findings): nothing recorded what a system costs. Harbor timed
// tickStart→tickEnd by hand, and finding the one landing animation that was
// half the frame took a CPU profile.

function busy(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // spin
  }
}

function world(): World {
  const w = createWorld({ headless: true, fixedStep: 1 / 16 })
  w.system('cheap', {}, () => {})
  w.system('slow', {}, () => busy(2))
  w.system('sim', { schedule: 'fixed' }, () => {})
  return w
}

describe('system timings (P-4)', () => {
  it('describe() carries no timings until profiling is on', () => {
    const w = world()
    w.step(1 / 16)
    expect(w.describe().systems.every((s) => !('timing' in s))).toBe(true)
    expect(w.describe()).not.toHaveProperty('timing')
  })

  it('while profiling, each system reports its runs and cost, and the frame its own', () => {
    const w = world()
    w.setProfiling(true)
    for (let i = 0; i < 5; i++) w.step(2 / 16)
    const byName = new Map(w.describe().systems.map((s) => [s.name, s.timing]))
    expect(byName.get('cheap')!.runs).toBe(5)
    expect(byName.get('sim')!.runs).toBe(10)
    const slow = byName.get('slow')!
    expect(slow.runs).toBe(5)
    expect(slow.meanMs).toBeGreaterThanOrEqual(1.5)
    expect(slow.maxMs).toBeGreaterThanOrEqual(slow.lastMs)
    expect(slow.totalMs).toBeCloseTo(slow.meanMs * 5, 6)
    const frame = w.describe().timing!
    expect(frame.ticks).toBe(5)
    expect(frame.meanMs).toBeGreaterThanOrEqual(slow.meanMs)
  })

  it('turning it off drops the timings, and on again starts afresh', () => {
    const w = world()
    w.setProfiling(true)
    w.step(1 / 16)
    w.setProfiling(false)
    w.step(1 / 16)
    expect(w.describe().systems.every((s) => !('timing' in s))).toBe(true)
    w.setProfiling(true)
    w.step(1 / 16)
    expect(w.describe().systems.find((s) => s.name === 'cheap')!.timing!.runs).toBe(1)
  })

  it('changes nothing a snapshot or hash sees', () => {
    const a = world()
    const b = world()
    b.setProfiling(true)
    for (const w of [a, b]) for (let i = 0; i < 3; i++) w.step(1 / 16)
    expect(hashSnapshot(b.snapshot(), { includeChanges: true })).toBe(hashSnapshot(a.snapshot(), { includeChanges: true }))
  })
})
