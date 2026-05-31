import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import { OnAdded, And, Has, Not, Or, Where } from '../src/query.js'
import { entry } from '../src/types.js'
import { createWorld } from '../src/world.js'

const Enemy = defineComponent<{ hp: number }>('Enemy', { defaults: { hp: 1 } })
const Resource = defineComponent<{ amount: number }>('Resource', { defaults: { amount: 0 } })
const Position = defineComponent<{ x: number; y: number }>('Position', {
  defaults: { x: 0, y: 0 },
})

describe('world.countEntities — leak-free one-shot count (review #13)', () => {
  it('counts entities matching a structural query', () => {
    const w = createWorld()
    w.spawn([entry(Enemy, { hp: 3 })])
    w.spawn([entry(Enemy, { hp: 5 })])
    w.spawn([entry(Resource, { amount: 10 })])
    expect(w.countEntities(Has(Enemy))).toBe(2)
    expect(w.countEntities(Has(Resource))).toBe(1)
    expect(w.countEntities(Has(Position))).toBe(0)
  })

  it('honors And / Or / Not combinators', () => {
    const w = createWorld()
    w.spawn([entry(Enemy, { hp: 3 }), entry(Position, { x: 1, y: 1 })])
    w.spawn([entry(Enemy, { hp: 5 })])
    w.spawn([entry(Resource, { amount: 2 })])
    expect(w.countEntities(And(Has(Enemy), Has(Position)))).toBe(1)
    expect(w.countEntities(Or(Has(Enemy), Has(Resource)))).toBe(3)
    expect(w.countEntities(And(Has(Enemy), Not(Has(Position))))).toBe(1)
  })

  it('honors a Where predicate', () => {
    const w = createWorld()
    w.spawn([entry(Enemy, { hp: 3 })])
    w.spawn([entry(Enemy, { hp: 9 })])
    expect(w.countEntities(Where(Enemy, (e) => e.hp > 5))).toBe(1)
  })

  it('matches a disposed live query of the same shape', () => {
    const w = createWorld()
    w.spawn([entry(Enemy, { hp: 1 })])
    w.spawn([entry(Enemy, { hp: 2 })])
    const q = w.query(Has(Enemy))
    const live = q.size
    q.dispose()
    expect(w.countEntities(Has(Enemy))).toBe(live)
  })

  it('does not leak a live query — repeated calls do not perturb a registered query', () => {
    const w = createWorld()
    const removed: number[] = []
    const q = w.query(Has(Enemy))
    q.onRemove((e) => removed.push(e.id))
    const a = w.spawn([entry(Enemy, { hp: 1 })])
    w.spawn([entry(Enemy, { hp: 2 })])
    w.step(0.016)
    for (let i = 0; i < 100; i++) {
      w.countEntities(Has(Enemy))
      w.selectViews(Has(Enemy))
      w.listEntities(Has(Enemy))
    }
    w.despawn(a)
    w.step(0.016)
    // Only the one registered query's onRemove fires, exactly once.
    expect(removed).toEqual([a])
  })
})

describe('world.listEntities — leak-free id list (review #13)', () => {
  it('returns the matching entity ids as a plain array', () => {
    const w = createWorld()
    const a = w.spawn([entry(Enemy, { hp: 1 })])
    const b = w.spawn([entry(Enemy, { hp: 2 })])
    w.spawn([entry(Resource, { amount: 1 })])
    const ids = w.listEntities(Has(Enemy))
    expect(Array.isArray(ids)).toBe(true)
    expect([...ids].sort((x, y) => x - y)).toEqual([a, b].sort((x, y) => x - y))
    expect((ids as unknown as { dispose?: unknown }).dispose).toBeUndefined()
  })

  it('returns an empty array when nothing matches', () => {
    const w = createWorld()
    expect(w.listEntities(Has(Enemy))).toEqual([])
  })
})

describe('world.selectViews — leak-free view list (review #13)', () => {
  it('returns typed entity views for the array shorthand', () => {
    const w = createWorld()
    w.spawn([entry(Position, { x: 4, y: 5 })])
    const views = w.selectViews([Position])
    expect(views).toHaveLength(1)
    expect(views[0]!.Position).toEqual({ x: 4, y: 5 })
    expect(typeof views[0]!.id).toBe('number')
  })

  it('returns views carrying .id for combinator forms', () => {
    const w = createWorld()
    const a = w.spawn([entry(Enemy, { hp: 7 })])
    const views = w.selectViews(Has(Enemy))
    expect(views.map((v) => v.id)).toEqual([a])
  })
})

describe('one-shot selectors reject reactive nodes (review #13)', () => {
  it('countEntities throws on Added (per-tick delta needs a live query)', () => {
    const w = createWorld()
    expect(() => w.countEntities(OnAdded(Enemy))).toThrow(/reactive|Added|one-shot/i)
  })

  it('selectViews throws on Added', () => {
    const w = createWorld()
    expect(() => w.selectViews(OnAdded(Enemy))).toThrow(/reactive|Added|one-shot/i)
  })

  it('listEntities throws on Added', () => {
    const w = createWorld()
    expect(() => w.listEntities(OnAdded(Enemy))).toThrow(/reactive|Added|one-shot/i)
  })
})
