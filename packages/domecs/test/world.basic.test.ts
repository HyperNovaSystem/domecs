import { describe, expect, it } from 'vitest'
import { createWorld, defineComponent, entry } from '../src/index.js'
import type { ComponentBag, ComponentType } from '../src/index.js'

describe('world — entity & component basics', () => {
  const Position = defineComponent<{ x: number; y: number }>('Position')
  const Velocity = defineComponent<{ dx: number; dy: number }>('Velocity')

  it('spawns entities with monotonic u53 ids', () => {
    const world = createWorld()
    const a = world.spawn()
    const b = world.spawn()
    const c = world.spawn()
    expect(a).toBe(0)
    expect(b).toBe(1)
    expect(c).toBe(2)
  })

  it('does not reuse ids after despawn (SPEC §2.1)', () => {
    const world = createWorld()
    const a = world.spawn()
    world.despawn(a)
    const b = world.spawn()
    expect(b).toBe(1)
    expect(b).not.toBe(a)
  })

  it('attaches, reads, and removes components', () => {
    const world = createWorld()
    const e = world.spawn()
    world.addComponent(e, Position, { x: 3, y: 4 })
    expect(world.has(e, Position)).toBe(true)
    expect(world.getComponent(e, Position)).toEqual({ x: 3, y: 4 })
    world.removeComponent(e, Position)
    expect(world.has(e, Position)).toBe(false)
    expect(world.getComponent(e, Position)).toBeUndefined()
  })

  it('spawn accepts an identity-keyed ComponentBag (finding F-1)', () => {
    const world = createWorld()
    const bag: ComponentBag = [
      [Position as ComponentType<unknown>, { x: 1, y: 2 }],
      [Velocity as ComponentType<unknown>, { dx: -1, dy: 0 }],
    ]
    const e = world.spawn(bag)
    expect(world.getComponent(e, Position)).toEqual({ x: 1, y: 2 })
    expect(world.getComponent(e, Velocity)).toEqual({ dx: -1, dy: 0 })
  })

  it('spawn accepts heterogeneous tuple array via entry() helper (F-7)', () => {
    const world = createWorld()
    // No `as never` / `as ComponentType<unknown>` casts — entry<T>() preserves T
    // inside each tuple so the heterogeneous array typechecks under strict TS.
    const e = world.spawn([
      entry(Position, { x: 10, y: 20 }),
      entry(Velocity, { dx: 3, dy: 4 }),
    ])
    expect(world.getComponent(e, Position)).toEqual({ x: 10, y: 20 })
    expect(world.getComponent(e, Velocity)).toEqual({ dx: 3, dy: 4 })
  })

  it('entry() rejects value shape mismatches at compile time', () => {
    // @ts-expect-error — { x, y } is not { dx, dy }
    entry(Velocity, { x: 1, y: 2 })
  })

  it('spawn accepts a Map-form ComponentBag', () => {
    const world = createWorld()
    const bag: ComponentBag = new Map<ComponentType<unknown>, unknown>([
      [Position, { x: 7, y: 8 }],
      [Velocity, { dx: 2, dy: 3 }],
    ])
    const e = world.spawn(bag)
    expect(world.getComponent(e, Position)).toEqual({ x: 7, y: 8 })
    expect(world.getComponent(e, Velocity)).toEqual({ dx: 2, dy: 3 })
  })

  it('despawning removes all components', () => {
    const world = createWorld()
    const e = world.spawn()
    world.addComponent(e, Position, { x: 0, y: 0 })
    world.despawn(e)
    expect(world.has(e, Position)).toBe(false)
    expect(world.getComponent(e, Position)).toBeUndefined()
  })

  // F-10: entitiesWith yields {id, value} pairs for every live carrier of a
  // component type. Skips entities lacking the type; values are typed.
  it('entitiesWith iterates carriers with typed values (F-10)', () => {
    const world = createWorld()
    const a = world.spawn()
    const b = world.spawn()
    const c = world.spawn()
    world.addComponent(a, Position, { x: 1, y: 1 })
    world.addComponent(b, Position, { x: 2, y: 2 })
    world.addComponent(c, Velocity, { dx: 9, dy: 9 }) // not a Position carrier
    const seen = new Map<number, { x: number; y: number }>()
    for (const { id, value } of world.entitiesWith(Position)) seen.set(id, value)
    expect(seen.size).toBe(2)
    expect(seen.get(a)).toEqual({ x: 1, y: 1 })
    expect(seen.get(b)).toEqual({ x: 2, y: 2 })
    expect(seen.has(c)).toBe(false)
  })

  it('entitiesWith yields nothing for an unregistered type', () => {
    const world = createWorld()
    const Mood = defineComponent<{ happy: boolean }>('Mood')
    expect(Array.from(world.entitiesWith(Mood))).toEqual([])
  })

  // F-9: signals.entityDespawned fires AFTER reclaim. Subscribers see a
  // world where world.has(id, T) is false and getComponent returns undefined.
  it('entityDespawned subscriber sees post-reclaim world (F-9 ordering)', () => {
    const world = createWorld()
    const e = world.spawn()
    world.addComponent(e, Position, { x: 5, y: 5 })
    let observed: { has: boolean; comp: unknown } | null = null
    world.signals.entityDespawned.subscribe((id) => {
      observed = { has: world.has(id, Position), comp: world.getComponent(id, Position) }
    })
    world.despawn(e)
    expect(observed).toEqual({ has: false, comp: undefined })
  })

  it('defineComponent applies defaults via create()', () => {
    const Health = defineComponent<{ hp: number; max: number }>('Health', {
      defaults: { hp: 10, max: 10 },
    })
    const value = Health.create({ hp: 5 })
    expect(value).toEqual({ hp: 5, max: 10 })
  })

  it('rejects duplicate addComponent on same entity', () => {
    const world = createWorld()
    const e = world.spawn()
    world.addComponent(e, Position, { x: 0, y: 0 })
    expect(() => world.addComponent(e, Position, { x: 1, y: 1 })).toThrow(/already has/)
  })

  it('world.componentTypes() lists attached types via archetype()', () => {
    const world = createWorld()
    const e = world.spawn()
    world.addComponent(e, Position, { x: 0, y: 0 })
    world.addComponent(e, Velocity, { dx: 1, dy: 1 })
    const types = world.archetype(e).map((t) => t.name).sort()
    expect(types).toEqual(['Position', 'Velocity'])
  })
})
