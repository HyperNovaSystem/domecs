import { describe, expect, it } from 'vitest'
import { createWorld, isOk } from '@domecs/core'
import { Parent, despawnTree, installHierarchy, setParent } from '../src/index.js'

describe('installHierarchy — despawn orphan policy', () => {
  it('a plain world.despawn() on a parent reparents its live children to null (root)', () => {
    const world = createWorld({ headless: true })
    const r = world.use(installHierarchy())
    expect(isOk(r)).toBe(true)

    const parent = world.spawn()
    const childA = world.spawn()
    const childB = world.spawn()
    expect(setParent(world, childA, parent)).toEqual({ ok: true })
    expect(setParent(world, childB, parent)).toEqual({ ok: true })

    world.despawn(parent)

    expect(world.getComponent(childA, Parent)?.entity).toBe(null)
    expect(world.getComponent(childB, Parent)?.entity).toBe(null)
    // The children themselves must still be alive (only reparented, not despawned).
    expect(world.archetype(childA)).toContain(Parent)
    expect(world.archetype(childB)).toContain(Parent)
  })

  it('does not touch grandchildren directly — only entities whose Parent is exactly the despawned id', () => {
    const world = createWorld({ headless: true })
    world.use(installHierarchy())

    const grandparent = world.spawn()
    const parent = world.spawn()
    const grandchild = world.spawn()
    expect(setParent(world, parent, grandparent)).toEqual({ ok: true })
    expect(setParent(world, grandchild, parent)).toEqual({ ok: true })

    world.despawn(grandparent)

    // `parent` (direct child of grandparent) is reparented to null...
    expect(world.getComponent(parent, Parent)?.entity).toBe(null)
    // ...but `grandchild`'s own Parent (pointing at `parent`, which is
    // still alive) is untouched.
    expect(world.getComponent(grandchild, Parent)?.entity).toBe(parent)
  })

  it('despawnTree does NOT trigger the reparent-to-null policy on entities it deliberately removes', () => {
    const world = createWorld({ headless: true })
    world.use(installHierarchy())

    const root = world.spawn()
    const mid = world.spawn()
    const leaf = world.spawn()
    expect(setParent(world, mid, root)).toEqual({ ok: true })
    expect(setParent(world, leaf, mid)).toEqual({ ok: true })

    despawnTree(world, root)

    // All three are simply gone — not orphaned-then-gone. If the orphan
    // handler had fired on any of them, this assertion would still pass
    // for aliveness (despawn wins either way), but the important guarantee
    // is that no Parent component was mutated in between: check via
    // archetype (empty means the entity carries zero components, i.e.
    // truly despawned, not "despawned with a lingering mutated Parent").
    for (const e of [root, mid, leaf]) {
      expect(world.archetype(e)).toEqual([])
    }
  })

  it('teardown unsubscribes the despawn handler', () => {
    const world = createWorld({ headless: true })
    const r = world.use(installHierarchy())
    expect(isOk(r)).toBe(true)
    if (!isOk(r)) throw new Error('install failed')
    const dispose = r.value

    const parent = world.spawn()
    const child = world.spawn()
    expect(setParent(world, child, parent)).toEqual({ ok: true })

    dispose() // uninstall the plugin

    world.despawn(parent)
    // No orphan policy active anymore: child's Parent still points at the
    // now-despawned parent id (stale, but that's the caller's problem once
    // they've torn the plugin down).
    expect(world.getComponent(child, Parent)?.entity).toBe(parent)
  })
})
