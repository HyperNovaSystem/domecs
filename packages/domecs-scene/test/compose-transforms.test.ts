import { describe, expect, it } from 'vitest'
import { createWorld, defineComponent, entry, isOk } from '@domecs/core'
import { composeTransforms, setParent } from '../src/index.js'

interface Vec2 {
  x: number
  y: number
}

const LocalPos = defineComponent<Vec2>('LocalPos', { defaults: { x: 0, y: 0 } })
const WorldPos = defineComponent<Vec2>('WorldPos', { defaults: { x: 0, y: 0 } })

function additive(parentWorld: Vec2 | null, local: Vec2): Vec2 {
  return parentWorld
    ? { x: parentWorld.x + local.x, y: parentWorld.y + local.y }
    : { x: local.x, y: local.y }
}

describe('composeTransforms', () => {
  it('composes parent-before-child on a 3+ level chain with exact final values', () => {
    const world = createWorld({ headless: true })
    const r = world.use(composeTransforms(LocalPos, WorldPos, additive))
    expect(isOk(r)).toBe(true)

    // root(10,0) -> mid(0,5) -> leaf(1,1) -> leafleaf(2,2)
    const root = world.spawn([entry(LocalPos, { x: 10, y: 0 })])
    const mid = world.spawn([entry(LocalPos, { x: 0, y: 5 })])
    const leaf = world.spawn([entry(LocalPos, { x: 1, y: 1 })])
    const leafleaf = world.spawn([entry(LocalPos, { x: 2, y: 2 })])
    expect(setParent(world, mid, root)).toEqual({ ok: true })
    expect(setParent(world, leaf, mid)).toEqual({ ok: true })
    expect(setParent(world, leafleaf, leaf)).toEqual({ ok: true })

    world.stepOnce()

    expect(world.getComponent(root, WorldPos)).toEqual({ x: 10, y: 0 })
    expect(world.getComponent(mid, WorldPos)).toEqual({ x: 10, y: 5 })
    expect(world.getComponent(leaf, WorldPos)).toEqual({ x: 11, y: 6 })
    expect(world.getComponent(leafleaf, WorldPos)).toEqual({ x: 13, y: 8 })
  })

  it('recomputes correctly on a later tick after a local value changes', () => {
    const world = createWorld({ headless: true })
    world.use(composeTransforms(LocalPos, WorldPos, additive))

    const root = world.spawn([entry(LocalPos, { x: 1, y: 1 })])
    const child = world.spawn([entry(LocalPos, { x: 1, y: 1 })])
    expect(setParent(world, child, root)).toEqual({ ok: true })

    world.stepOnce()
    expect(world.getComponent(child, WorldPos)).toEqual({ x: 2, y: 2 })

    const rootLocal = world.getComponent(root, LocalPos)!
    rootLocal.x = 100
    world.markChanged(root, LocalPos)
    world.stepOnce()

    expect(world.getComponent(root, WorldPos)).toEqual({ x: 100, y: 1 })
    expect(world.getComponent(child, WorldPos)).toEqual({ x: 101, y: 2 })
  })

  it('composes with parentWorld=null when Parent points to a non-Local-bearing entity', () => {
    const world = createWorld({ headless: true })
    world.use(composeTransforms(LocalPos, WorldPos, additive))

    // `container` has no LocalPos at all (not part of the transform tree),
    // but `child`'s Parent points at it.
    const container = world.spawn()
    const child = world.spawn([entry(LocalPos, { x: 5, y: 5 })])
    expect(setParent(world, child, container)).toEqual({ ok: true })

    world.stepOnce()

    // parentWorld must be null (container has no Local), so child's World
    // equals its own Local, unaffected by `container` in any way.
    expect(world.getComponent(child, WorldPos)).toEqual({ x: 5, y: 5 })
  })

  it('composes with parentWorld=null for a true hierarchy root (no Parent at all)', () => {
    const world = createWorld({ headless: true })
    world.use(composeTransforms(LocalPos, WorldPos, additive))

    const root = world.spawn([entry(LocalPos, { x: 7, y: 3 })])
    world.stepOnce()

    expect(world.getComponent(root, WorldPos)).toEqual({ x: 7, y: 3 })
  })

  it('does not assume query iteration order respects hierarchy: children spawned before their parent still compose correctly', () => {
    const world = createWorld({ headless: true })
    world.use(composeTransforms(LocalPos, WorldPos, additive))

    // Spawn order is deliberately child-before-parent-before-grandparent,
    // the opposite of hierarchy order, to prove the system does not rely
    // on query/spawn iteration order.
    const leaf = world.spawn([entry(LocalPos, { x: 1, y: 0 })])
    const mid = world.spawn([entry(LocalPos, { x: 1, y: 0 })])
    const root = world.spawn([entry(LocalPos, { x: 1, y: 0 })])
    expect(setParent(world, leaf, mid)).toEqual({ ok: true })
    expect(setParent(world, mid, root)).toEqual({ ok: true })

    world.stepOnce()

    expect(world.getComponent(root, WorldPos)).toEqual({ x: 1, y: 0 })
    expect(world.getComponent(mid, WorldPos)).toEqual({ x: 2, y: 0 })
    expect(world.getComponent(leaf, WorldPos)).toEqual({ x: 3, y: 0 })
  })
})
