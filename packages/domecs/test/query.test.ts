import { describe, expect, it } from 'vitest'
import {
  createWorld,
  defineComponent,
  Has,
  Not,
  Or,
  And,
  Added,
  Removed,
  Changed,
  Where,
} from '../src/index.js'

const Position = defineComponent<{ x: number; y: number }>('Position')
const Velocity = defineComponent<{ dx: number; dy: number }>('Velocity')
const Dead = defineComponent<{}>('Dead')
const Health = defineComponent<{ hp: number }>('Health')

describe('query — structural predicates (archetype-cached)', () => {
  it('Has(T) returns entities with that component', () => {
    const world = createWorld()
    const a = world.spawn()
    const b = world.spawn()
    world.addComponent(a, Position, { x: 0, y: 0 })
    const q = world.query(Has(Position))
    expect(q.size).toBe(1)
    expect(q.entities.map((e) => e.id)).toEqual([a])
    expect(q.entities[0]!.id).toBe(a)
    void b
  })

  it('And(Has(A), Has(B)) requires both', () => {
    const world = createWorld()
    const a = world.spawn()
    const b = world.spawn()
    world.addComponent(a, Position, { x: 0, y: 0 })
    world.addComponent(a, Velocity, { dx: 1, dy: 0 })
    world.addComponent(b, Position, { x: 0, y: 0 })
    const q = world.query(And(Has(Position), Has(Velocity)))
    expect(q.entities.map((e) => e.id)).toEqual([a])
  })

  it('array shorthand is sugar for And(Has(...))', () => {
    const world = createWorld()
    const a = world.spawn()
    world.addComponent(a, Position, { x: 0, y: 0 })
    world.addComponent(a, Velocity, { dx: 1, dy: 0 })
    const q = world.query([Position, Velocity])
    expect(q.entities.map((e) => e.id)).toEqual([a])
  })

  it('Not(T) excludes entities with that component', () => {
    const world = createWorld()
    const alive = world.spawn()
    const dead = world.spawn()
    world.addComponent(alive, Health, { hp: 10 })
    world.addComponent(dead, Health, { hp: 0 })
    world.addComponent(dead, Dead, {})
    const q = world.query(And(Has(Health), Not(Dead)))
    expect(q.entities.map((e) => e.id)).toEqual([alive])
  })

  it('Or(A, B) matches either', () => {
    const world = createWorld()
    const a = world.spawn()
    const b = world.spawn()
    const c = world.spawn()
    world.addComponent(a, Position, { x: 0, y: 0 })
    world.addComponent(b, Velocity, { dx: 0, dy: 0 })
    world.addComponent(c, Health, { hp: 5 })
    const q = world.query(Or(Has(Position), Has(Velocity)))
    expect(q.entities.map((e) => e.id).sort()).toEqual([a, b])
  })

  it('Where(T, pred) filters by value (not indexed, per SPEC §2.4)', () => {
    const world = createWorld()
    const hurt = world.spawn()
    const healthy = world.spawn()
    world.addComponent(hurt, Health, { hp: 2 })
    world.addComponent(healthy, Health, { hp: 10 })
    const q = world.query(Where(Health, (h) => h.hp < 5))
    expect(q.entities.map((e) => e.id)).toEqual([hurt])
  })

  it('EntityView exposes attached components by name', () => {
    const world = createWorld()
    const e = world.spawn()
    world.addComponent(e, Position, { x: 3, y: 4 })
    const q = world.query(Has(Position))
    const view = q.entities[0]!
    expect((view as any).Position).toEqual({ x: 3, y: 4 })
  })

  it('query results track structural changes without manual refresh', () => {
    const world = createWorld()
    const a = world.spawn()
    const q = world.query(Has(Position))
    expect(q.size).toBe(0)
    world.addComponent(a, Position, { x: 0, y: 0 })
    expect(q.size).toBe(1)
    world.removeComponent(a, Position)
    expect(q.size).toBe(0)
  })

  it('onAdd/onRemove hooks fire on query membership transitions', () => {
    const world = createWorld()
    const q = world.query(Has(Position))
    const added: number[] = []
    const removed: number[] = []
    q.onAdd((e) => added.push(e.id))
    q.onRemove((e) => removed.push(e.id))
    const a = world.spawn()
    world.addComponent(a, Position, { x: 0, y: 0 })
    world.removeComponent(a, Position)
    expect(added).toEqual([a])
    expect(removed).toEqual([a])
  })
})

describe('query — change-detection filters (tick-scoped)', () => {
  it('Added(T) reports adds since last tick; clears on world.step()', () => {
    const world = createWorld({ headless: true })
    const a = world.spawn()
    world.addComponent(a, Position, { x: 0, y: 0 })
    const q = world.query(Added(Position))
    expect(q.entities.map((e) => e.id)).toEqual([a])
    world.step()
    expect(q.size).toBe(0)
  })

  it('Removed(T) reports removes since last tick', () => {
    const world = createWorld({ headless: true })
    const a = world.spawn()
    world.addComponent(a, Position, { x: 0, y: 0 })
    world.step()
    world.removeComponent(a, Position)
    const q = world.query(Removed(Position))
    expect(q.entities.map((e) => e.id)).toEqual([a])
    world.step()
    expect(q.size).toBe(0)
  })

  it('Changed(T) reports markChanged calls this tick', () => {
    const world = createWorld({ headless: true })
    const a = world.spawn()
    world.addComponent(a, Position, { x: 0, y: 0 })
    world.step()
    const pos = world.getComponent(a, Position)!
    pos.x = 5
    world.markChanged(a, Position)
    const q = world.query(Changed(Position))
    expect(q.entities.map((e) => e.id)).toEqual([a])
    world.step()
    expect(q.size).toBe(0)
  })
})
