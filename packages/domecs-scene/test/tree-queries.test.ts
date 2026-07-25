import { describe, expect, it } from 'vitest'
import { createWorld } from '@domecs/core'
import { Parent, ancestorsOf, childrenOf, rootsOf, setParent } from '../src/index.js'

// Small constructed tree:
//        root1        root2 (bare, no components at all)
//       /     \
//     mid1    mid2
//    /   \
//  leaf1 leaf2
function buildTree() {
  const world = createWorld({ headless: true })
  const root1 = world.spawn()
  const root2 = world.spawn() // deliberately bare — no Parent component ever added
  const mid1 = world.spawn()
  const mid2 = world.spawn()
  const leaf1 = world.spawn()
  const leaf2 = world.spawn()

  expect(setParent(world, mid1, root1)).toEqual({ ok: true })
  expect(setParent(world, mid2, root1)).toEqual({ ok: true })
  expect(setParent(world, leaf1, mid1)).toEqual({ ok: true })
  expect(setParent(world, leaf2, mid1)).toEqual({ ok: true })

  return { world, root1, root2, mid1, mid2, leaf1, leaf2 }
}

describe('childrenOf', () => {
  it('returns direct children only, in no particular guaranteed order', () => {
    const { world, root1, mid1, mid2, leaf1, leaf2 } = buildTree()
    expect(new Set(childrenOf(world, root1))).toEqual(new Set([mid1, mid2]))
    expect(new Set(childrenOf(world, mid1))).toEqual(new Set([leaf1, leaf2]))
    expect(childrenOf(world, mid2)).toEqual([])
    expect(childrenOf(world, leaf1)).toEqual([])
  })

  it('reflects an in-place setParent mutation on the next call (no stale cache)', () => {
    const { world, mid1, mid2, leaf1, leaf2 } = buildTree()
    expect(childrenOf(world, mid2)).toEqual([])
    expect(setParent(world, leaf1, mid2)).toEqual({ ok: true })
    expect(childrenOf(world, mid1)).toEqual([leaf2]) // leaf1 moved away, leaf2 stays
    expect(childrenOf(world, mid2)).toEqual([leaf1])
  })
})

describe('ancestorsOf', () => {
  it('returns [immediate parent, ..., root], not including the entity itself', () => {
    const { world, root1, mid1, leaf1 } = buildTree()
    expect(ancestorsOf(world, leaf1)).toEqual([mid1, root1])
  })

  it('returns [] for a root entity', () => {
    const { world, root1 } = buildTree()
    expect(ancestorsOf(world, root1)).toEqual([])
  })

  it('returns [] for a bare entity with no Parent component', () => {
    const { world, root2 } = buildTree()
    expect(ancestorsOf(world, root2)).toEqual([])
  })

  it('terminates and does not infinite-loop even if the Parent graph is corrupted into a cycle', () => {
    const world = createWorld({ headless: true })
    const a = world.spawn()
    const b = world.spawn()
    // Bypass setParent's cycle guard directly via addComponent to construct
    // an illegal cyclic Parent graph (a <- b <- a).
    world.addComponent(a, Parent, { entity: b })
    world.addComponent(b, Parent, { entity: a })

    const result = ancestorsOf(world, a)
    // Must terminate; visited-set means it stops before infinitely repeating.
    expect(result.length).toBeLessThanOrEqual(2)
  })
})

describe('rootsOf', () => {
  it('includes every entity with no Parent, or Parent.entity === null, including bare entities', () => {
    const { world, root1, root2 } = buildTree()
    const roots = rootsOf(world)
    expect(new Set(roots)).toEqual(new Set([root1, root2]))
  })

  it('an entity explicitly re-parented to null becomes a root', () => {
    const { world, root1, mid1 } = buildTree()
    expect(setParent(world, mid1, null)).toEqual({ ok: true })
    const roots = rootsOf(world)
    expect(roots).toContain(mid1)
    expect(roots).toContain(root1)
  })
})
