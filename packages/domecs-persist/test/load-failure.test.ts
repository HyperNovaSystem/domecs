import { createWorld, defineComponent, definePlugin, entry, type World } from '@domecs/core'
import { describe, expect, it } from 'vitest'
import { createSnapshotHistory } from '../src/history.js'
import { load, save } from '../src/persist.js'
import { createMemoryStorage } from '../src/storage.js'

// O-41 / O-62 from the 2026-10-13 engine review: a load that fails
// leaves the live world as it was, and failures that repeat on retry are
// reported with `retryable: false`.

const Hp = defineComponent<{ hp: number }>('LfHp', { defaults: { hp: 10 } })

function live(): World {
  const w = createWorld({ seed: [1, 2, 3, 4] })
  w.spawn([entry(Hp, { hp: 3 })])
  w.stepOnce()
  return w
}

describe('load failures', () => {
  it('a slot with a malformed entity record leaves the world intact', () => {
    const storage = createMemoryStorage()
    storage.write(
      'bad',
      JSON.stringify({ version: 2, seed: [1, 2, 3, 4], tick: 99, entities: [{ id: 3 }] }),
    )
    const w = live()
    const before = JSON.stringify(w.snapshot())
    const r = load(w, storage, 'bad')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('persist_io')
      expect((r.error as { retryable: boolean }).retryable).toBe(false)
    }
    expect(JSON.stringify(w.snapshot())).toBe(before)
    expect(w.time.tick).toBe(1)
  })

  it('corrupt JSON and non-snapshot payloads are not retryable', () => {
    const storage = createMemoryStorage()
    storage.write('json', '{nope')
    storage.write('shape', JSON.stringify({ hello: 'world' }))
    const w = live()
    for (const slot of ['json', 'shape']) {
      const r = load(w, storage, slot)
      expect(r.ok).toBe(false)
      if (!r.ok) expect((r.error as { retryable: boolean }).retryable).toBe(false)
    }
  })

  it('a snapshot that cannot be serialized is not retryable', () => {
    const Big = defineComponent<{ n: bigint }>('LfBig')
    const w = createWorld()
    w.spawn([entry(Big, { n: 1n })])
    const r = save(w, createMemoryStorage(), 'slot')
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r.error as { retryable: boolean }).retryable).toBe(false)
  })

  it('history.load of a malformed envelope leaves the world intact', () => {
    const w = live()
    const history = createSnapshotHistory(w)
    const before = JSON.stringify(w.snapshot())
    const r = history.load(JSON.stringify({ version: 2, index: 0, snapshots: [{}] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect((r.error as { retryable: boolean }).retryable).toBe(false)
    expect(JSON.stringify(w.snapshot())).toBe(before)
    expect(w.time.tick).toBe(1)
  })
})

describe('O-62: undo/redo keep the cursor on the shown checkpoint when restore throws', () => {
  it('a throwing onRestore leaves index and canUndo unchanged', () => {
    const w = createWorld()
    let fail = false
    w.use(
      definePlugin({
        name: 'lf:flaky-restore',
        install: () => ({
          onRestore: (s) => {
            if (fail) throw new Error('restore hook failed')
            return s
          },
        }),
      }),
    )
    const history = createSnapshotHistory(w)
    w.spawn([entry(Hp, { hp: 1 })])
    history.push()
    expect(history.index).toBe(1)
    fail = true
    expect(() => history.undo()).toThrow('restore hook failed')
    expect(history.index).toBe(1)
    expect(history.canUndo()).toBe(true)
    fail = false
    expect(history.undo()).toBe(true)
    expect(history.index).toBe(0)
    fail = true
    expect(() => history.redo()).toThrow('restore hook failed')
    expect(history.index).toBe(0)
    expect(history.canRedo()).toBe(true)
  })
})
