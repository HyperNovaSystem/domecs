import { describe, expect, it } from 'vitest'
import { createWorld, defineComponent, entry } from '@domecs/core'
import { despawnTree, setParent } from '../src/index.js'

const Marker = defineComponent<{ v: number }>('Marker')

describe('despawnTree', () => {
  it('degenerates to a plain despawn for a childless entity', () => {
    const world = createWorld({ headless: true })
    const a = world.spawn([entry(Marker, { v: 1 })])
    expect(world.archetype(a)).toHaveLength(1)

    despawnTree(world, a)

    expect(world.archetype(a)).toEqual([])
    // Despawn is idempotent/no-op on an already-gone entity — must not throw.
    expect(() => world.despawn(a)).not.toThrow()
  })

  it('removes a multi-level subtree completely, leaving siblings/unrelated entities untouched', () => {
    const world = createWorld({ headless: true })
    // subtree under `root`:
    //   root -> mid1 -> leaf1
    //        -> mid2
    // sibling is a wholly separate root entity and must survive untouched.
    const root = world.spawn([entry(Marker, { v: 0 })])
    const mid1 = world.spawn([entry(Marker, { v: 1 })])
    const mid2 = world.spawn([entry(Marker, { v: 2 })])
    const leaf1 = world.spawn([entry(Marker, { v: 3 })])
    const sibling = world.spawn([entry(Marker, { v: 99 })])

    expect(setParent(world, mid1, root)).toEqual({ ok: true })
    expect(setParent(world, mid2, root)).toEqual({ ok: true })
    expect(setParent(world, leaf1, mid1)).toEqual({ ok: true })

    despawnTree(world, root)

    for (const e of [root, mid1, mid2, leaf1]) {
      expect(world.archetype(e)).toEqual([])
      expect(world.getComponent(e, Marker)).toBeUndefined()
    }
    // sibling untouched: still alive, still carries its Marker value.
    expect(world.getComponent(sibling, Marker)).toEqual({ v: 99 })
  })

  it('handles a deep chain (10 levels) without stack overflow, removing every level', () => {
    const world = createWorld({ headless: true })
    const chain: number[] = []
    let parent: number | null = null
    for (let i = 0; i < 10; i++) {
      const id = world.spawn([entry(Marker, { v: i })])
      if (parent !== null) expect(setParent(world, id, parent)).toEqual({ ok: true })
      chain.push(id)
      parent = id
    }

    despawnTree(world, chain[0]!)

    for (const id of chain) {
      expect(world.archetype(id)).toEqual([])
    }
  })
})
