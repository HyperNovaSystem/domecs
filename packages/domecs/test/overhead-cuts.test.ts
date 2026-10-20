import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import { And, Has, Not } from '../src/query.js'
import { entry } from '../src/types.js'
import { createWorld } from '../src/world.js'

// WS-5 A1: a structural query reuses its last result until an entity enters,
// leaves or moves between archetypes; stores are looked up by type
// identity; add/remove follow archetype transition edges. These pin the
// invalidation rules so the caches can never hand back stale state.

const A = defineComponent<{ n: number }>('CutA', { defaults: { n: 0 } })
const nOf = (q: { entities: readonly unknown[] }) => (q.entities[0] as { CutA: { n: number } }).CutA.n
const B = defineComponent<{ s: string }>('CutB', { defaults: { s: '' } })

describe('structural query result reuse', () => {
  it('hands each reader its own array', () => {
    const w = createWorld({ headless: true })
    w.spawn([entry(A, { n: 1 })])
    w.spawn([entry(A, { n: 2 })])
    const q = w.query([A])
    // Typed readonly, but JS callers can still mutate what they get.
    const first = q.entities as unknown as Array<{ id: number }>
    first.reverse()
    first.push({ id: 999 })
    expect(q.entities.map((e) => e.id)).toEqual([0, 1])
  })

  it('sees spawns, despawns, adds and removes', () => {
    const w = createWorld({ headless: true })
    const q = w.query([A])
    const a = w.spawn([entry(A, { n: 1 })])
    expect(q.entities.map((e) => e.id)).toEqual([a])
    const b = w.spawn([entry(A, { n: 2 })])
    expect(q.entities.map((e) => e.id)).toEqual([a, b])
    w.removeComponent(a, A)
    expect(q.entities.map((e) => e.id)).toEqual([b])
    w.addComponent(a, A, { n: 3 })
    expect(q.entities.map((e) => e.id)).toEqual([a, b])
    w.despawn(b)
    expect(q.entities.map((e) => e.id)).toEqual([a])
  })

  it('a member that gains an unrelated component shows it in the next read', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(A, { n: 1 })])
    const q = w.query([A])
    expect('CutB' in q.entities[0]!).toBe(false)
    w.addComponent(id, B, { s: 'x' })
    const view = q.entities[0] as unknown as Record<string, unknown>
    expect(view.CutB).toEqual({ s: 'x' })
  })

  it('reads values live: in-place mutation needs no invalidation', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(A, { n: 1 })])
    const q = w.query([A])
    expect(nOf(q)).toBe(1)
    w.getComponent(id, A)!.n = 5
    expect(nOf(q)).toBe(5)
  })

  it('restore invalidates the reused result and the store lookup', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(A, { n: 1 })])
    const q = w.query([A])
    const snap = w.snapshot()
    w.getComponent(id, A)!.n = 9
    w.spawn([entry(A, { n: 2 })])
    expect(q.entities.length).toBe(2)
    w.restore(snap)
    expect(q.entities.map((e) => e.id)).toEqual([id])
    expect(nOf(q)).toBe(1)
    expect(w.getComponent(id, A)!.n).toBe(1)
    w.getComponent(id, A)!.n = 4
    expect(nOf(q)).toBe(4)
  })

  it('Not queries track archetype moves', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(A, { n: 1 })])
    const q = w.query(Not(Has(B)))
    expect(q.entities.map((e) => e.id)).toEqual([id])
    w.addComponent(id, B, { s: '' })
    expect(q.entities).toEqual([])
    w.removeComponent(id, B)
    expect(q.entities.map((e) => e.id)).toEqual([id])
  })
})

describe('store lookup by type identity', () => {
  it('still rejects a second type object under a used name', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(A, { n: 1 })])
    w.getComponent(id, A) // warm the cache
    const Impostor = defineComponent<{ n: number }>('CutA', { defaults: { n: 0 } })
    expect(() => w.getComponent(id, Impostor)).toThrow(/two distinct ComponentType objects/)
  })
})

describe('archetype transition edges', () => {
  it('add/remove sequences land in the same archetype as a direct spawn', () => {
    const w = createWorld({ headless: true })
    const x = w.spawn([])
    w.addComponent(x, A, { n: 0 })
    w.addComponent(x, B, { s: '' })
    w.removeComponent(x, A)
    w.addComponent(x, A, { n: 0 })
    const y = w.spawn([entry(B, { s: '' }), entry(A, { n: 0 })])
    const both = w.query([A, B])
    expect(both.entities.map((e) => e.id)).toEqual([x, y])
    const onlyB = w.query(And(Has(B), Not(Has(A))))
    expect(onlyB.entities).toEqual([])
    w.removeComponent(y, A)
    expect(onlyB.entities.map((e) => e.id)).toEqual([y])
  })
})
