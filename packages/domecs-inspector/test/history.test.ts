import { createWorld, defineComponent, entry } from '@domecs/core'
import type { SystemFault } from '@domecs/core'
import { describe, expect, it } from 'vitest'
import { createInspector } from '../src/index.js'

const Hp = defineComponent<{ hp: number }>('HiHp', { defaults: { hp: 1 } })

function fault(entity: number): SystemFault {
  return { entity, error: { kind: 'query_invalid', reason: 'r', retryable: false }, recoverable: true }
}

// O-60 (N2, N3): history stays one entry per fault, filtered views are
// stable, and the ring drops the oldest entries.
describe('inspector — history (O-60)', () => {
  function faultingWorld(bufferSize?: number) {
    const w = createWorld({ headless: true })
    const ins = createInspector({ recordStateChanges: true, ...(bufferSize ? { bufferSize } : {}) })
    if (!w.use(ins.plugin).ok) throw new Error('install failed')
    const e = w.spawn([entry(Hp, { hp: 1 })])
    let fire = 1
    w.system('boom', { schedule: 'tick' }, () => (fire-- > 0 ? { errors: [fault(e)] } : undefined))
    return { w, ins, e, again: (n: number) => { fire = n } }
  }

  it('a restore does not duplicate faults already recorded (N2)', () => {
    const { w, ins } = faultingWorld()
    w.stepOnce()
    expect(ins.view.entries).toHaveLength(1)
    const snap = w.snapshot()
    w.restore(snap)
    w.stepOnce()
    w.restore(snap)
    expect(ins.view.entries).toHaveLength(1)
  })

  it('a filtered view keeps the timeline it was filtered with (N3)', () => {
    const { w, ins } = faultingWorld()
    w.stepOnce()
    const filtered = ins.view.recoverableOnly()
    const before = filtered.timeline.length
    w.spawn()
    w.stepOnce()
    expect(ins.view.timeline.length).toBeGreaterThan(before)
    expect(filtered.timeline.length).toBe(before)
  })

  it('keeps the newest bufferSize entries', () => {
    const { w, ins, again } = faultingWorld(3)
    for (let i = 0; i < 6; i++) {
      again(1)
      w.stepOnce()
    }
    const ticks = ins.view.entries.map((x) => x.tick)
    expect(ticks).toHaveLength(3)
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b))
    expect(ticks[2]).toBe(w.time.tick)
  })
})
