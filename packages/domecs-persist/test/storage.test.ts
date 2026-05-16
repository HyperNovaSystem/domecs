import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '../src/storage.js'

describe('@domecs/persist — memory storage', () => {
  it('returns ok(null) for a missing slot', () => {
    const s = createMemoryStorage()
    const r = s.read('nope')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBeNull()
  })

  it('round-trips write → read', () => {
    const s = createMemoryStorage()
    expect(s.write('k', 'v').ok).toBe(true)
    const r = s.read('k')
    expect(r.ok && r.value).toBe('v')
  })

  it('remove drops the slot back to null', () => {
    const s = createMemoryStorage({ k: 'v' })
    expect(s.remove('k').ok).toBe(true)
    const r = s.read('k')
    expect(r.ok && r.value).toBeNull()
  })

  it('list returns slot names in sorted order', () => {
    const s = createMemoryStorage({ b: '1', a: '2', c: '3' })
    const r = s.list()
    expect(r.ok && r.value).toEqual(['a', 'b', 'c'])
  })

  it('seeds from an initial map', () => {
    const s = createMemoryStorage({ x: 'y' })
    const r = s.read('x')
    expect(r.ok && r.value).toBe('y')
  })
})
