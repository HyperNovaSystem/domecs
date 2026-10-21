import { describe, expect, it } from 'vitest'
import type { Entity, WorldSnapshot } from '@domecs/core'
import { diffSnapshots, firstDivergence } from '../src/history.js'
import * as persist from '../src/index.js'

// G9 / O-31 (diff half), spec §4.1: field-level diffSnapshots and
// firstDivergence. Iteration is ascending entity id, then sorted component
// name, then sorted key.

const id = (n: number): Entity => n as Entity

function snap(
  entities: Array<[number, Record<string, unknown>]>,
  extra: Partial<WorldSnapshot> = {},
): WorldSnapshot {
  return {
    version: 2,
    seed: [1, 2, 3, 4],
    tick: 10,
    scaledTime: 1,
    entities: entities.map(([n, components]) => ({ id: id(n), components })),
    nextId: 100,
    ...extra,
  }
}

describe('diffSnapshots (fields)', () => {
  it('is exported with firstDivergence from the package barrel', () => {
    expect(persist.diffSnapshots).toBe(diffSnapshots)
    expect(persist.firstDivergence).toBe(firstDivergence)
  })

  it('without options keeps the entity-level result shape', () => {
    const prev = snap([[1, { P: { x: 1 } }], [2, { P: { x: 2 } }]])
    const next = snap([[1, { P: { x: 5 } }], [3, { P: { x: 3 } }]])
    expect(diffSnapshots(prev, next)).toEqual({
      addedEntities: [id(3)],
      removedEntities: [id(2)],
      changedEntities: [id(1)],
    })
  })

  it('does not report key-order-only differences (behaviour change: canonical comparison)', () => {
    const prev = snap([[1, { A: { x: 1, y: 2 }, B: { k: 1 } }]])
    const next = snap([[1, { B: { k: 1 }, A: { y: 2, x: 1 } }]])
    expect(JSON.stringify(prev.entities[0]!.components)).not.toBe(JSON.stringify(next.entities[0]!.components))
    const d = diffSnapshots(prev, next, { fields: true })
    expect(d.changedEntities).toEqual([])
    expect(d.fieldChanges).toEqual([])
    expect(d.componentsAdded).toEqual([])
    expect(d.componentsRemoved).toEqual([])
    expect(d.truncated).toBe(false)
  })

  it('reports scalar, nested and array-length changes with dotted paths', () => {
    const prev = snap([
      [1, { P: { x: 1, y: 2 } }],
      [2, { Inv: { items: [{ qty: 1 }, { qty: 2 }, { qty: 3 }], tags: ['a'] }, 'Odd Name': { 'a-b': 1 } }],
    ])
    const next = snap([
      [1, { P: { x: 1, y: 3 } }],
      [2, { Inv: { items: [{ qty: 1 }, { qty: 9 }], tags: ['a', 'b'] }, 'Odd Name': { 'a-b': 2 } }],
    ])
    const d = diffSnapshots(prev, next, { fields: true })
    expect(d.changedEntities).toEqual([id(1), id(2)])
    expect(d.fieldChanges).toEqual([
      { entity: id(1), component: 'P', path: 'y', before: 2, after: 3 },
      { entity: id(2), component: 'Inv', path: 'items[1].qty', before: 2, after: 9 },
      { entity: id(2), component: 'Inv', path: 'items[2]', before: { qty: 3 }, after: undefined },
      { entity: id(2), component: 'Inv', path: 'tags[1]', before: undefined, after: 'b' },
      { entity: id(2), component: 'Odd Name', path: '["a-b"]', before: 1, after: 2 },
    ])
  })

  it('reports added and removed fields, type changes and -0', () => {
    const prev = snap([[1, { P: { x: 1, gone: true, v: { a: 1 }, z: 0 } }]])
    const next = snap([[1, { P: { x: 1, fresh: 'n', v: 7, z: -0 } }]])
    const d = diffSnapshots(prev, next, { fields: true })
    expect(d.fieldChanges).toEqual([
      { entity: id(1), component: 'P', path: 'fresh', before: undefined, after: 'n' },
      { entity: id(1), component: 'P', path: 'gone', before: true, after: undefined },
      { entity: id(1), component: 'P', path: 'v', before: { a: 1 }, after: 7 },
      { entity: id(1), component: 'P', path: 'z', before: 0, after: -0 },
    ])
  })

  it('reports components added and removed, in sorted order', () => {
    const prev = snap([[1, { B: { n: 1 }, C: { n: 1 } }], [2, { A: {} }]])
    const next = snap([[1, { A: { n: 1 }, C: { n: 1 }, D: {} }], [2, {}]])
    const d = diffSnapshots(prev, next, { fields: true })
    expect(d.componentsAdded).toEqual([
      { entity: id(1), component: 'A' },
      { entity: id(1), component: 'D' },
    ])
    expect(d.componentsRemoved).toEqual([
      { entity: id(1), component: 'B' },
      { entity: id(2), component: 'A' },
    ])
    expect(d.fieldChanges).toEqual([])
    expect(d.changedEntities).toEqual([id(1), id(2)])
  })

  it('reports resource changes, including added and removed resources', () => {
    const prev = snap([], { resources: { Score: { n: 1, best: 4 }, Old: { a: 1 } } })
    const next = snap([], { resources: { Score: { n: 2, best: 4 }, New: [1] } })
    const d = diffSnapshots(prev, next, { fields: true })
    expect(d.resourceChanges).toEqual([
      { resource: 'New', path: '', before: undefined, after: [1] },
      { resource: 'Old', path: '', before: { a: 1 }, after: undefined },
      { resource: 'Score', path: 'n', before: 1, after: 2 },
    ])
    const none = diffSnapshots(snap([]), snap([], { resources: {} }), { fields: true })
    expect(none.resourceChanges).toEqual([])
  })

  it('treats numbers within epsilon as equal', () => {
    const prev = snap([[1, { P: { x: 1, y: 1 } }], [2, { P: { x: 0 } }]])
    const next = snap([[1, { P: { x: 1.0005, y: 1.5 } }], [2, { P: { x: -0 } }]])
    const d = diffSnapshots(prev, next, { fields: true, epsilon: 0.001 })
    expect(d.fieldChanges).toEqual([{ entity: id(1), component: 'P', path: 'y', before: 1, after: 1.5 }])
    expect(d.changedEntities).toEqual([id(1)])
    expect(diffSnapshots(prev, next, { fields: true }).fieldChanges).toHaveLength(3)
  })

  it('restricts field reporting to the named components', () => {
    const prev = snap([[1, { P: { x: 1 }, Q: { x: 1 } }]])
    const next = snap([[1, { P: { x: 2 }, Q: { x: 2 }, R: {} }]])
    const d = diffSnapshots(prev, next, { fields: true, components: ['Q'] })
    expect(d.fieldChanges).toEqual([{ entity: id(1), component: 'Q', path: 'x', before: 1, after: 2 }])
    expect(d.componentsAdded).toEqual([])
    expect(d.changedEntities).toEqual([id(1)])
  })

  it('stops after `limit` field changes and sets truncated', () => {
    const many = (v: number): WorldSnapshot =>
      snap(Array.from({ length: 10 }, (_, i): [number, Record<string, unknown>] => [i, { P: { a: v, b: v } }]), {
        resources: { R: { n: v } },
      })
    const d = diffSnapshots(many(0), many(1), { fields: true, limit: 5 })
    expect(d.fieldChanges).toHaveLength(5)
    expect(d.fieldChanges!.map((c) => [c.entity, c.path])).toEqual([
      [0, 'a'],
      [0, 'b'],
      [1, 'a'],
      [1, 'b'],
      [2, 'a'],
    ])
    expect(d.resourceChanges).toEqual([])
    expect(d.truncated).toBe(true)
    // Entity-level lists stay complete.
    expect(d.changedEntities).toHaveLength(10)
    const full = diffSnapshots(many(0), many(1), { fields: true })
    expect(full.fieldChanges).toHaveLength(20)
    expect(full.resourceChanges).toHaveLength(1)
    expect(full.truncated).toBe(false)
  })

  it('rejects invalid options', () => {
    const s = snap([])
    expect(() => diffSnapshots(s, s, { epsilon: -1 })).toThrow(RangeError)
    expect(() => diffSnapshots(s, s, { epsilon: NaN })).toThrow(RangeError)
    expect(() => diffSnapshots(s, s, { limit: -1 })).toThrow(RangeError)
    expect(() => diffSnapshots(s, s, { limit: 1.5 })).toThrow(RangeError)
    expect(() => diffSnapshots(s, s, { limit: NaN })).toThrow(RangeError)
    expect(() => diffSnapshots(s, s, { epsilon: Infinity })).toThrow(RangeError)
  })

  it('accepts limit: Infinity as "no limit"', () => {
    const many = (v: number): WorldSnapshot =>
      snap(Array.from({ length: 30 }, (_, i): [number, Record<string, unknown>] => [i, { P: { a: v } }]))
    const d = diffSnapshots(many(0), many(1), { fields: true, limit: Infinity })
    expect(d.fieldChanges).toHaveLength(30)
    expect(d.truncated).toBe(false)
  })
})

describe('firstDivergence', () => {
  it('returns null for equal snapshots, ignoring key order, version, meta and changes', () => {
    const a = snap([[1, { A: { x: 1, y: 2 } }]], { resources: { R: { a: 1, b: 2 } } })
    const b = snap([[1, { A: { y: 2, x: 1 } }]], {
      version: 3,
      resources: { R: { b: 2, a: 1 } },
      meta: { label: 'x' },
      changes: { marks: [], seen: {} },
    })
    expect(firstDivergence(a, b)).toBeNull()
    expect(firstDivergence(a, a)).toBeNull()
  })

  it('returns the lowest-id entity first field change', () => {
    const a = snap([[1, { P: { x: 1 } }], [4, { P: { x: 1, y: 1 }, Q: { z: 1 } }], [9, { P: { x: 1 } }]])
    const b = snap([[1, { P: { x: 1 } }], [4, { P: { x: 1, y: 2 }, Q: { z: 2 } }], [9, { P: { x: 5 } }]])
    expect(firstDivergence(a, b)).toEqual({
      where: 'entity',
      entity: id(4),
      change: { entity: id(4), component: 'P', path: 'y', before: 1, after: 2 },
    })
  })

  it('reports a component present on one side as a whole-value field change', () => {
    const a = snap([[2, { B: { n: 1 } }]])
    const b = snap([[2, { A: { n: 1 }, B: { n: 1 } }]])
    expect(firstDivergence(a, b)).toEqual({
      where: 'entity',
      entity: id(2),
      change: { entity: id(2), component: 'A', path: '', before: undefined, after: { n: 1 } },
    })
  })

  it('reports added and removed entities by lowest id', () => {
    const a = snap([[1, {}], [3, {}]])
    const b = snap([[1, {}], [2, {}], [3, {}]])
    expect(firstDivergence(a, b)).toEqual({ where: 'entity', entity: id(2), change: 'added' })
    expect(firstDivergence(b, a)).toEqual({ where: 'entity', entity: id(2), change: 'removed' })
  })

  it('checks top-level state before entities, and resources after', () => {
    const a = snap([[1, { P: { x: 1 } }]], { resources: { R: { n: 1 } } })
    expect(firstDivergence(a, { ...a, tick: 11, entities: [] })).toEqual({ where: 'state', key: 'tick' })
    expect(firstDivergence(a, { ...a, seed: [1, 2, 3, 5] })).toEqual({ where: 'state', key: 'seed' })
    expect(firstDivergence(a, { ...a, fixedBacklog: 2, fixedStep: 1 / 60 })).toEqual({
      where: 'state',
      key: 'fixedBacklog',
    })
    expect(firstDivergence(a, { ...a, resources: { R: { n: 2 } } })).toEqual({
      where: 'resource',
      change: { resource: 'R', path: 'n', before: 1, after: 2 },
    })
  })

  it('reports snapshots differing only in pendingEvents (§4.7), like hashSnapshot', () => {
    const a = snap([[1, { P: { x: 1 } }]])
    const b = { ...a, pendingEvents: [{ event: 'Ping', payload: { n: 1 } }] }
    expect(firstDivergence(a, b)).toEqual({ where: 'state', key: 'pendingEvents' })
    expect(firstDivergence(b, { ...b, pendingEvents: [{ event: 'Ping', payload: { n: 2 } }] })).toEqual({
      where: 'state',
      key: 'pendingEvents',
    })
    expect(firstDivergence(b, { ...b, pendingEvents: [{ event: 'Ping', payload: { n: 1 } }] })).toBeNull()
    // State fields come first: a tick difference is reported before the queue.
    expect(firstDivergence(a, { ...b, tick: a.tick + 1 })).toEqual({ where: 'state', key: 'tick' })
  })
})
