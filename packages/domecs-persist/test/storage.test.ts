import { afterEach, describe, expect, it } from 'vitest'
import { createLocalStorageStorage, createMemoryStorage } from '../src/storage.js'

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

describe('@domecs/persist — localStorage storage', () => {
  function fakeLocalStorage() {
    const m = new Map<string, string>()
    return {
      get length() {
        return m.size
      },
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      key: (i: number) => Array.from(m.keys())[i] ?? null,
    }
  }
  const g = globalThis as { localStorage?: unknown }
  const original = g.localStorage
  afterEach(() => {
    if (original === undefined) delete g.localStorage
    else g.localStorage = original
  })

  it('round-trips write → read → remove under the prefix', () => {
    g.localStorage = fakeLocalStorage()
    const s = createLocalStorageStorage('t:')
    expect(s.read('k').ok && (s.read('k') as { value: unknown }).value).toBeNull()
    expect(s.write('k', 'v').ok).toBe(true)
    const r = s.read('k')
    expect(r.ok && r.value).toBe('v')
    expect(s.remove('k').ok).toBe(true)
    const r2 = s.read('k')
    expect(r2.ok && r2.value).toBeNull()
  })

  it('list returns only this prefix’s slots, sorted', () => {
    const ls = fakeLocalStorage()
    g.localStorage = ls
    ls.setItem('other:x', '1') // foreign key must not leak into the listing
    const s = createLocalStorageStorage('t:')
    s.write('b', '1')
    s.write('a', '2')
    const r = s.list()
    expect(r.ok && r.value).toEqual(['a', 'b'])
  })

  it('returns persist_io when localStorage is missing from the host', () => {
    delete g.localStorage
    const s = createLocalStorageStorage()
    const r = s.read('a')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('persist_io')
      expect((r.error as { retryable?: boolean }).retryable).toBe(true)
    }
  })

  it('catches throwing backends (quota / privacy mode) as persist_io', () => {
    g.localStorage = {
      get length() {
        return 0
      },
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => {},
      key: () => null,
    }
    const s = createLocalStorageStorage()
    const r = s.write('k', 'v')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('persist_io')
  })
})
