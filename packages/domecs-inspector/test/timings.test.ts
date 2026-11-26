import { describe, expect, it } from 'vitest'
import { createWorld } from '@domecs/core'
import { createInspector } from '../src/index.js'

// P-4: what each system costs, where an inspector is attached.
describe('inspector timings (P-4)', () => {
  it('profile: true turns profiling on while installed and ranks systems by cost', () => {
    const w = createWorld({ headless: true })
    w.system('cheap', {}, () => {})
    w.system('dear', {}, () => {
      const until = performance.now() + 1
      while (performance.now() < until) {
        // spin
      }
    })
    const inspector = createInspector({ profile: true })
    expect(inspector.timings()).toEqual([])
    const r = w.use(inspector.plugin)
    if (!r.ok) throw new Error('install failed')
    for (let i = 0; i < 4; i++) w.stepOnce()
    const rows = inspector.timings()
    expect(rows[0]!.name).toBe('dear')
    expect(rows[0]!.timing.runs).toBe(4)
    expect(rows.find((x) => x.name === 'cheap')!.schedule).toBe('tick')
    r.value()
    expect(inspector.timings()).toEqual([])
    expect(w.describe()).not.toHaveProperty('timing')
  })

  it('without profile it leaves profiling off', () => {
    const w = createWorld({ headless: true })
    const inspector = createInspector()
    w.use(inspector.plugin)
    w.stepOnce()
    expect(inspector.timings()).toEqual([])
    expect(w.describe()).not.toHaveProperty('timing')
  })
})
