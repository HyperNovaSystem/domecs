import { describe, expect, it } from 'vitest'
import { createWorld, defineComponent, entry, isOk } from '@domecs/core'
import { Parent, composeTransforms, despawnTree, installHierarchy, setParent } from '../src/index.js'

const Local = defineComponent<{ x: number }>('RbLocal', { defaults: { x: 0 } })
const WorldX = defineComponent<{ x: number }>('RbWorld', { defaults: { x: 0 } })

describe('setParent — parent liveness (O-61)', () => {
  it('rejects a despawned or never-spawned parent and leaves the child untouched', () => {
    const world = createWorld({ headless: true })
    const child = world.spawn()
    const gone = world.spawn()
    world.despawn(gone)
    const r1 = setParent(world, child, gone)
    expect(r1.ok).toBe(false)
    expect(setParent(world, child, 9999).ok).toBe(false)
    expect(world.has(child, Parent)).toBe(false)
    expect(setParent(world, child, null)).toEqual({ ok: true })
  })
})

describe('hierarchy at scale and over corrupted graphs (O-64)', () => {
  it('despawnTree terminates on a cyclic Parent graph', () => {
    const world = createWorld({ headless: true })
    world.use(installHierarchy())
    const a = world.spawn()
    const b = world.spawn([entry(Parent, { entity: a })])
    // Corrupt the graph directly (setParent would refuse the cycle).
    world.addComponent(a, Parent, { entity: b })
    const bystander = world.spawn([entry(Parent, { entity: b })])
    despawnTree(world, a)
    expect(world.isAlive(a)).toBe(false)
    expect(world.isAlive(b)).toBe(false)
    expect(world.isAlive(bystander)).toBe(false)
  })

  it('despawnTree on a 4k star is linear, and plain despawn still orphans to root', () => {
    const world = createWorld({ headless: true })
    world.use(installHierarchy())
    const hub = world.spawn()
    const kids: number[] = []
    for (let i = 0; i < 4000; i++) kids.push(world.spawn([entry(Parent, { entity: hub })]))
    const t0 = performance.now()
    despawnTree(world, hub)
    const ms = performance.now() - t0
    expect(kids.every((k) => !world.isAlive(k))).toBe(true)
    // Was ~800 ms (quadratic); generous bound for slow CI.
    expect(ms).toBeLessThan(200)

    const p = world.spawn()
    const c = world.spawn([entry(Parent, { entity: p })])
    world.despawn(p)
    expect(world.getComponent(c, Parent)!.entity).toBeNull()
  })

  it('despawnTree orphans an entity a despawn subscriber parented under the subtree', () => {
    const w = createWorld({ headless: true })
    w.use(installHierarchy())
    const root = w.spawn()
    const kid = w.spawn([entry(Parent, { entity: root })])
    const other = w.spawn([entry(Parent, { entity: null })])
    let done = false
    w.signals.entityDespawned.subscribe((id) => {
      if (id !== kid || done) return
      done = true
      w.getComponent(other, Parent)!.entity = root
      w.markChanged(other, Parent)
    })
    despawnTree(w, root)
    expect(w.isAlive(other)).toBe(true)
    expect(w.getComponent(other, Parent)!.entity).toBeNull()
  })

  it('composeTransforms handles a 50k-deep chain without overflowing the stack', () => {
    const world = createWorld({ headless: true })
    const r = world.use(composeTransforms(Local, WorldX, (pw, l) => ({ x: (pw?.x ?? 0) + l.x })))
    expect(isOk(r)).toBe(true)
    // Ids ascend leaf → root, so resolution starts at the deepest leaf.
    const ids: number[] = []
    for (let i = 0; i < 50_000; i++) ids.push(world.spawn([entry(Local, { x: 1 })]))
    for (let i = 0; i < ids.length - 1; i++) world.addComponent(ids[i]!, Parent, { entity: ids[i + 1]! })
    const leaf = ids[0]!
    expect(() => world.stepOnce()).not.toThrow()
    expect(world.getComponent(leaf, WorldX)!.x).toBe(50_000)
  })

  it('composeTransforms composes the entity that meets a cycle as a root', () => {
    const world = createWorld({ headless: true })
    world.use(composeTransforms(Local, WorldX, (pw, l) => ({ x: (pw?.x ?? 0) + l.x })))
    const a = world.spawn([entry(Local, { x: 1 })])
    const b = world.spawn([entry(Local, { x: 10 }), entry(Parent, { entity: a })])
    world.addComponent(a, Parent, { entity: b })
    world.stepOnce()
    // The walk from a reaches b, whose parent a is already on the chain.
    expect(world.getComponent(b, WorldX)!.x).toBe(10)
    expect(world.getComponent(a, WorldX)!.x).toBe(11)
  })
})
