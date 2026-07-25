import { describe, expect, it } from 'vitest'
import { createWorld } from '@domecs/core'
import { Parent, ancestorsOf, childrenOf, setParent } from '../src/index.js'

describe('Parent survives world.snapshot() -> world.restore()', () => {
  it('round-trips a hierarchy on the SAME world instance', () => {
    const world = createWorld({ headless: true })
    const root = world.spawn()
    const mid = world.spawn()
    const leaf = world.spawn()
    expect(setParent(world, mid, root)).toEqual({ ok: true })
    expect(setParent(world, leaf, mid)).toEqual({ ok: true })

    const snap = world.snapshot()

    // Mutate the live hierarchy after the snapshot was taken, to prove
    // restore() actually reinstates the snapshotted shape (not just
    // observing already-live state).
    expect(setParent(world, leaf, root)).toEqual({ ok: true })
    expect(ancestorsOf(world, leaf)).toEqual([root])

    world.restore(snap)

    expect(world.getComponent(mid, Parent)?.entity).toBe(root)
    expect(world.getComponent(leaf, Parent)?.entity).toBe(mid)
    expect(ancestorsOf(world, leaf)).toEqual([mid, root])
    expect(childrenOf(world, root)).toEqual([mid])
  })

  it('round-trips a hierarchy onto a FRESH world instance', () => {
    const source = createWorld({ headless: true })
    const root = source.spawn()
    const mid = source.spawn()
    const leaf = source.spawn()
    expect(setParent(source, mid, root)).toEqual({ ok: true })
    expect(setParent(source, leaf, mid)).toEqual({ ok: true })

    const snap = source.snapshot()

    const target = createWorld({ headless: true })
    target.restore(snap)

    expect(target.getComponent(mid, Parent)?.entity).toBe(root)
    expect(target.getComponent(leaf, Parent)?.entity).toBe(mid)
    expect(ancestorsOf(target, leaf)).toEqual([mid, root])
  })

  it('a root entity (Parent.entity === null) also round-trips correctly', () => {
    const world = createWorld({ headless: true })
    const root = world.spawn()
    expect(setParent(world, root, null)).toEqual({ ok: true }) // explicit root

    const snap = world.snapshot()
    const target = createWorld({ headless: true })
    target.restore(snap)

    expect(target.getComponent(root, Parent)?.entity).toBe(null)
  })
})
