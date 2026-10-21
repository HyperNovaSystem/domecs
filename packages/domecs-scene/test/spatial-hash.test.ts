import { describe, expect, it } from 'vitest'
import { createWorld, defineComponent, entry, hashSnapshot } from '@domecs/core'
import type { Entity, World } from '@domecs/core'
import { createSpatialHash } from '../src/index.js'

// O-8 / spec §5.1 (G2): the world-bound spatial index. Positions are read
// from one component at refresh(); tag filters are evaluated live at query
// time; the index is derived state and never enters the snapshot.

const Pos = defineComponent<{ x: number; y: number }>('SpPos', { defaults: { x: 0, y: 0 } })
const At = defineComponent<{ px: number; py: number }>('SpAt', { defaults: { px: 0, py: 0 } })
const Prey = defineComponent<{ kind: string }>('SpPrey', { defaults: { kind: 'prey' } })
const Predator = defineComponent<{ kind: string }>('SpPredator', { defaults: { kind: 'predator' } })

type Ids = { a: Entity; b: Entity; c: Entity; d: Entity; e: Entity; noPos: Entity }

function setup(): { world: World; ids: Ids } {
  const world = createWorld({ headless: true, seed: [1, 2, 3, 4] })
  const ids: Ids = {
    a: world.spawn([entry(Pos, { x: 0, y: 0 }), entry(Prey, { kind: 'prey' })]),
    b: world.spawn([entry(Pos, { x: 3, y: 4 }), entry(Predator, { kind: 'predator' })]),
    c: world.spawn([entry(Pos, { x: -3, y: 4 }), entry(Prey, { kind: 'prey' })]),
    d: world.spawn([
      entry(Pos, { x: 1, y: 0 }),
      entry(Prey, { kind: 'prey' }),
      entry(Predator, { kind: 'predator' }),
    ]),
    e: world.spawn([entry(Pos, { x: 100, y: 100 })]),
    noPos: world.spawn([entry(Prey, { kind: 'prey' })]),
  }
  return { world, ids }
}

describe('createSpatialHash (spec §5.1)', () => {
  it('indexes the component positions at creation, ascending id', () => {
    const { world, ids } = setup()
    const index = createSpatialHash(world, { component: Pos, cellSize: 2 })
    expect(index.within(0, 0, 5)).toEqual([ids.a, ids.b, ids.c, ids.d])
    expect(index.within(0, 0, 1000)).toEqual([ids.a, ids.b, ids.c, ids.d, ids.e])
    expect(index.nearest(99, 99)).toBe(ids.e)
  })

  it('filters by tag components (all must be held), live at query time', () => {
    const { world, ids } = setup()
    const index = createSpatialHash(world, { component: Pos, cellSize: 2 })
    expect(index.within(0, 0, 5, [Prey])).toEqual([ids.a, ids.c, ids.d])
    expect(index.within(0, 0, 5, [Predator])).toEqual([ids.b, ids.d])
    expect(index.within(0, 0, 5, [Prey, Predator])).toEqual([ids.d])
    expect(index.within(0, 0, 5, [])).toEqual([ids.a, ids.b, ids.c, ids.d])
    expect(index.nearest(3, 4, { filter: [Prey] })).toBe(ids.d) // d at distance √20 < c at 6
    // tag membership is read live, no refresh needed
    world.removeComponent(ids.d, Prey)
    expect(index.within(0, 0, 5, [Prey])).toEqual([ids.a, ids.c])
    expect(index.nearest(3, 4, { filter: [Prey] })).toBe(ids.a) // a at 5 < c at 6
  })

  it('nearest honours exclude and maxDistance', () => {
    const { world, ids } = setup()
    const index = createSpatialHash(world, { component: Pos, cellSize: 2 })
    expect(index.nearest(0, 0)).toBe(ids.a)
    expect(index.nearest(0, 0, { exclude: ids.a })).toBe(ids.d)
    expect(index.nearest(0, 0, { exclude: ids.a, filter: [Predator] })).toBe(ids.d)
    expect(index.nearest(0, 0, { exclude: ids.d, filter: [Predator] })).toBe(ids.b)
    expect(index.nearest(50, 50, { maxDistance: 10 })).toBeUndefined()
    expect(index.nearest(0, 0, { exclude: ids.a, maxDistance: 1 })).toBe(ids.d)
    // from (0, 4): b and c are both 3 away, d is √17 away
    expect(index.nearest(0, 4, { filter: [Prey, Predator], maxDistance: 2 })).toBeUndefined()
    const tie = ids.b < ids.c ? ids.b : ids.c
    expect(index.nearest(0, 4)).toBe(tie)
  })

  it('reflects moves, spawns, removals and despawns after refresh()', () => {
    const { world, ids } = setup()
    const index = createSpatialHash(world, { component: Pos, cellSize: 2 })
    const pa = world.getComponent(ids.a, Pos)!
    pa.x = 50
    pa.y = 50
    world.markChanged(ids.a, Pos)
    world.despawn(ids.b)
    world.removeComponent(ids.c, Pos)
    const f = world.spawn([entry(Pos, { x: 0.5, y: 0.5 })])
    // positions are as of the last refresh until refresh() runs again
    expect(index.within(0, 0, 5)).toEqual([ids.a, ids.b, ids.c, ids.d])
    index.refresh()
    expect(index.within(0, 0, 5)).toEqual([ids.d, f])
    expect(index.nearest(49, 49)).toBe(ids.a)
    expect(index.within(0, 0, 1000)).not.toContain(ids.b)
  })

  it('reads custom field names; non-number or non-finite fields are not indexed', () => {
    const world = createWorld({ headless: true })
    const p = world.spawn([entry(At, { px: 2, py: 2 })])
    const q = world.spawn([entry(At, { px: Number.NaN, py: 0 })])
    const s = world.spawn([entry(At, { px: '3' as unknown as number, py: 0 })])
    const index = createSpatialHash(world, { component: At, x: 'px', y: 'py', cellSize: 1 })
    expect(index.within(0, 0, 100)).toEqual([p])
    expect(index.nearest(0, 0)).toBe(p)
    world.getComponent(q, At)!.px = 1
    world.getComponent(s, At)!.px = 3
    index.refresh()
    expect(index.within(0, 0, 100)).toEqual([p, q, s])
    // an indexed id whose field turns non-finite or non-number drops out
    world.getComponent(p, At)!.py = Infinity
    world.getComponent(s, At)!.py = null as unknown as number
    index.refresh()
    expect(index.within(0, 0, 100)).toEqual([q])
    expect(index.nearest(2, 2)).toBe(q)
  })

  it('pairs(r, a, b): first element carries a, sorted; a == b gives first < second', () => {
    const { world, ids } = setup()
    const index = createSpatialHash(world, { component: Pos, cellSize: 2 })
    // within 5: a–b (5), a–c (5), a–d (1), b–d (√20), c–d (√32 > 5 no), b–c (6 no)
    const preyPred = index.pairs(5, Prey, Predator)
    const want: Array<[Entity, Entity]> = []
    const close: Array<[Entity, Entity]> = [
      [ids.a, ids.b],
      [ids.a, ids.c],
      [ids.a, ids.d],
      [ids.b, ids.d],
    ]
    for (const [p, q] of close) {
      for (const [first, second] of [
        [p, q],
        [q, p],
      ] as Array<[Entity, Entity]>) {
        if (world.has(first, Prey) && world.has(second, Predator)) want.push([first, second])
      }
    }
    want.sort((x, y) => x[0] - y[0] || x[1] - y[1])
    expect(preyPred).toEqual(want)
    // d holds both tags: it appears first (as prey) and second (as predator)
    expect(preyPred).toContainEqual([ids.a, ids.d])
    expect(preyPred).toContainEqual([ids.d, ids.b])
    expect(index.pairs(5, Prey, Prey)).toEqual([
      [ids.a, ids.c],
      [ids.a, ids.d],
    ])
    expect(index.pairs(5, Predator, Prey)).toEqual(
      want.map(([p, q]) => [q, p] as [Entity, Entity]).sort((x, y) => x[0] - y[0] || x[1] - y[1]),
    )
  })

  it('results do not depend on cellSize', () => {
    const world = createWorld({ headless: true, seed: [9, 9, 9, 9] })
    for (let i = 0; i < 300; i++) {
      const x = Math.round(world.rand.uniformRange(-50, 50) * 4) / 4
      const y = Math.round(world.rand.uniformRange(-50, 50) * 4) / 4
      world.spawn(i % 3 === 0 ? [entry(Pos, { x, y }), entry(Prey, { kind: 'prey' })] : [entry(Pos, { x, y })])
    }
    const out = (cellSize: number): string => {
      const index = createSpatialHash(world, { component: Pos, cellSize })
      const parts: unknown[] = []
      for (let i = -40; i <= 40; i += 8) {
        parts.push(index.within(i, -i, 9), index.within(i, i, 3, [Prey]))
        parts.push(index.nearest(i, 0), index.nearest(0, i, { filter: [Prey], exclude: 1, maxDistance: 20 }))
      }
      parts.push(index.pairs(4, Prey, Pos), index.pairs(3, Pos, Pos))
      return JSON.stringify(parts)
    }
    const ref = out(1)
    for (const cs of [0.5, 7, 32, 1e6]) expect(out(cs), `cellSize ${cs}`).toBe(ref)
  })

  it('building, refreshing and querying an index leaves hashSnapshot unchanged', () => {
    const { world } = setup()
    world.step(1 / 60)
    const before = hashSnapshot(world.snapshot(), { includeChanges: true })
    const index = createSpatialHash(world, { component: Pos, cellSize: 3 })
    index.refresh()
    index.within(0, 0, 10, [Prey])
    index.nearest(0, 0, { filter: [Predator], exclude: 1 })
    index.pairs(5, Prey, Predator)
    expect(hashSnapshot(world.snapshot(), { includeChanges: true })).toBe(before)
    index.dispose()
    expect(hashSnapshot(world.snapshot(), { includeChanges: true })).toBe(before)
  })

  it('dispose() drops the index; later calls throw', () => {
    const { world } = setup()
    const index = createSpatialHash(world, { component: Pos, cellSize: 3 })
    index.dispose()
    index.dispose() // idempotent
    expect(() => index.refresh()).toThrow(/disposed/)
    expect(() => index.within(0, 0, 1)).toThrow(/disposed/)
    expect(() => index.nearest(0, 0)).toThrow(/disposed/)
    expect(() => index.pairs(1, Prey, Prey)).toThrow(/disposed/)
  })

  it('rejects an invalid cellSize', () => {
    const { world } = setup()
    expect(() => createSpatialHash(world, { component: Pos, cellSize: 0 })).toThrow(RangeError)
  })
})
