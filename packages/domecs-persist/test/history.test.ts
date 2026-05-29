import { createWorld, defineComponent, entry } from '@domecs/core'
import { describe, expect, it } from 'vitest'
import { createSnapshotHistory, diffSnapshots } from '../src/history.js'

const Counter = defineComponent<{ n: number }>('Counter', { defaults: { n: 0 } })

function setN(w: ReturnType<typeof createWorld>, e: number, n: number): void {
  const c = w.getComponent(e, Counter)
  if (c) c.n = n
}

describe('createSnapshotHistory — undo/redo (review #15)', () => {
  it('undo restores the previous checkpoint', () => {
    const w = createWorld()
    const e = w.spawn([entry(Counter, { n: 0 })])
    const h = createSnapshotHistory(w) // captures initial (n=0)
    setN(w, e, 1)
    h.push()
    setN(w, e, 2)
    h.push()
    expect(h.undo()).toBe(true)
    expect(w.getComponent(e, Counter)?.n).toBe(1)
    expect(h.undo()).toBe(true)
    expect(w.getComponent(e, Counter)?.n).toBe(0)
    expect(h.undo()).toBe(false) // at the floor
  })

  it('redo replays a checkpoint after undo', () => {
    const w = createWorld()
    const e = w.spawn([entry(Counter, { n: 0 })])
    const h = createSnapshotHistory(w)
    setN(w, e, 1)
    h.push()
    h.undo()
    expect(w.getComponent(e, Counter)?.n).toBe(0)
    expect(h.redo()).toBe(true)
    expect(w.getComponent(e, Counter)?.n).toBe(1)
    expect(h.redo()).toBe(false)
  })

  it('reports canUndo/canRedo at the boundaries', () => {
    const w = createWorld()
    w.spawn([entry(Counter, { n: 0 })])
    const h = createSnapshotHistory(w)
    expect(h.canUndo()).toBe(false)
    expect(h.canRedo()).toBe(false)
    h.push()
    expect(h.canUndo()).toBe(true)
    expect(h.canRedo()).toBe(false)
    h.undo()
    expect(h.canUndo()).toBe(false)
    expect(h.canRedo()).toBe(true)
  })

  it('pushing after an undo truncates the redo branch', () => {
    const w = createWorld()
    const e = w.spawn([entry(Counter, { n: 0 })])
    const h = createSnapshotHistory(w)
    setN(w, e, 1)
    h.push()
    setN(w, e, 2)
    h.push() // n=2 at index 2
    h.undo() // back to n=1 (index 1)
    setN(w, e, 9)
    h.push() // new branch from index 1 → index 2 (n=9); old n=2 dropped
    expect(h.canRedo()).toBe(false)
    expect(h.redo()).toBe(false)
    expect(w.getComponent(e, Counter)?.n).toBe(9)
  })

  it('enforces the ring limit, dropping the oldest checkpoints', () => {
    const w = createWorld()
    const e = w.spawn([entry(Counter, { n: 0 })])
    const h = createSnapshotHistory(w, { limit: 3, captureInitial: false })
    for (let n = 1; n <= 5; n++) {
      setN(w, e, n)
      h.push()
    }
    expect(h.length).toBe(3) // only the 3 newest retained
    // current is n=5; undo twice reaches n=3, then floor
    expect(w.getComponent(e, Counter)?.n).toBe(5)
    h.undo()
    h.undo()
    expect(w.getComponent(e, Counter)?.n).toBe(3)
    expect(h.canUndo()).toBe(false)
  })

  it('captureInitial:false starts empty', () => {
    const w = createWorld()
    w.spawn([entry(Counter, { n: 0 })])
    const h = createSnapshotHistory(w, { captureInitial: false })
    expect(h.length).toBe(0)
    expect(h.canUndo()).toBe(false)
  })

  it('clear empties the history', () => {
    const w = createWorld()
    const e = w.spawn([entry(Counter, { n: 0 })])
    const h = createSnapshotHistory(w)
    setN(w, e, 1)
    h.push()
    h.clear()
    expect(h.length).toBe(0)
    expect(h.canUndo()).toBe(false)
    expect(h.canRedo()).toBe(false)
  })

  it('rejects a limit below 1', () => {
    const w = createWorld()
    expect(() => createSnapshotHistory(w, { limit: 0 })).toThrow(/limit/i)
  })
})

describe('createSnapshotHistory — JSON export/import (review #15)', () => {
  it('toJSON then load round-trips the ring and restores the cursor state', () => {
    const w = createWorld()
    const e = w.spawn([entry(Counter, { n: 0 })])
    const h = createSnapshotHistory(w)
    setN(w, e, 1)
    h.push()
    setN(w, e, 2)
    h.push()
    h.undo() // cursor at n=1
    const json = h.toJSON()

    const w2 = createWorld()
    const e2 = w2.spawn([entry(Counter, { n: 99 })])
    const h2 = createSnapshotHistory(w2, { captureInitial: false })
    const loaded = h2.load(json)
    expect(loaded.ok).toBe(true)
    expect(h2.length).toBe(h.length)
    // world restored to the saved cursor (n=1), entity id preserved
    expect(w2.getComponent(e2, Counter)?.n).toBe(1)
    expect(h2.canRedo()).toBe(true)
  })

  it('load returns persist_io on malformed JSON', () => {
    const w = createWorld()
    const h = createSnapshotHistory(w, { captureInitial: false })
    const r = h.load('{ not valid')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('persist_io')
  })
})

describe('diffSnapshots (review #15)', () => {
  it('reports added, removed, and changed entities', () => {
    const w = createWorld()
    const keep = w.spawn([entry(Counter, { n: 1 })])
    const gone = w.spawn([entry(Counter, { n: 2 })])
    const prev = w.snapshot()

    setN(w, keep, 5) // changed
    w.despawn(gone) // removed
    const added = w.spawn([entry(Counter, { n: 7 })]) // added
    const next = w.snapshot()

    const diff = diffSnapshots(prev, next)
    expect(diff.addedEntities).toContain(added)
    expect(diff.removedEntities).toContain(gone)
    expect(diff.changedEntities).toContain(keep)
  })

  it('reports no changes for identical snapshots', () => {
    const w = createWorld()
    w.spawn([entry(Counter, { n: 1 })])
    const snap = w.snapshot()
    const diff = diffSnapshots(snap, snap)
    expect(diff.addedEntities).toHaveLength(0)
    expect(diff.removedEntities).toHaveLength(0)
    expect(diff.changedEntities).toHaveLength(0)
  })
})
