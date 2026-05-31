import { describe, expect, it } from 'vitest'
import { CONSOLIDATE_FAULTS_NAME } from '../src/index.js'
import { createWorld } from '../src/world.js'

describe('world.getSystem(name) — live SystemHandle lookup', () => {
  it('returns the live handle whose disable() stops the system on the next step', () => {
    const w = createWorld()
    let count = 0
    w.system('counter', { schedule: 'tick' }, () => {
      count++
    })

    w.step(0.016)
    expect(count).toBe(1)

    const handle = w.getSystem('counter')
    expect(handle).toBeDefined()
    expect(handle!.name).toBe('counter')

    handle!.disable()
    w.step(0.016)
    expect(count).toBe(1)
  })

  it('re-enabling via handle.enabled = true resumes the system', () => {
    const w = createWorld()
    let count = 0
    w.system('counter', { schedule: 'tick' }, () => {
      count++
    })

    const handle = w.getSystem('counter')!
    handle.disable()
    w.step(0.016)
    expect(count).toBe(0)

    handle.enabled = true
    w.step(0.016)
    expect(count).toBe(1)
  })

  it('returns undefined for an unregistered system name', () => {
    const w = createWorld()
    expect(w.getSystem('does-not-exist')).toBeUndefined()
  })

  it('returns the built-in fault consolidator handle (escape hatch is reachable)', () => {
    const w = createWorld()
    const handle = w.getSystem(CONSOLIDATE_FAULTS_NAME)
    expect(handle).toBeDefined()
    expect(handle!.name).toBe(CONSOLIDATE_FAULTS_NAME)
  })
})
