import { describe, expect, it } from 'vitest'
import { OnChanged, createWorld, defineComponent, entry, isOk } from '@domecs/core'
import { Parent, childrenOf, composeTransforms, setParent } from '../src/index.js'

const Local = defineComponent<{ x: number }>('ClLocal', { defaults: { x: 0 } })
const WorldX = defineComponent<{ x: number }>('ClWorld', { defaults: { x: 0 } })
const Local2 = defineComponent<{ x: number }>('ClLocal2', { defaults: { x: 0 } })
const World2 = defineComponent<{ x: number }>('ClWorld2', { defaults: { x: 0 } })
const add = (pw: { x: number } | null, l: { x: number }) => ({ x: (pw?.x ?? 0) + l.x })

// O-65: composeTransforms marks only what moved, cleans up after itself,
// and can be installed per component pair.
describe('composeTransforms — marking and lifecycle (O-65)', () => {
  it('marks World_ changed only when its value moved', () => {
    const w = createWorld({ headless: true })
    w.use(composeTransforms(Local, WorldX, add))
    const a = w.spawn([entry(Local, { x: 1 })])
    const b = w.spawn([entry(Local, { x: 2 })])
    w.stepOnce()
    const q = w.query(OnChanged(WorldX))
    expect(q.entities).toEqual([])
    w.stepOnce()
    expect(q.entities).toEqual([])
    w.getComponent(a, Local)!.x = 5
    w.markChanged(a, Local)
    w.stepOnce()
    expect(q.entities.map((e) => e.id)).toEqual([a])
    expect(w.getComponent(b, WorldX)!.x).toBe(2)
  })

  it('removes the World_ it added when the entity loses Local, not one the user added', () => {
    const w = createWorld({ headless: true })
    w.use(composeTransforms(Local, WorldX, add))
    const mine = w.spawn([entry(Local, { x: 1 })])
    const users = w.spawn([entry(Local, { x: 1 }), entry(WorldX, { x: 0 })])
    w.stepOnce()
    w.removeComponent(mine, Local)
    w.removeComponent(users, Local)
    w.stepOnce()
    expect(w.has(mine, WorldX)).toBe(false)
    expect(w.has(users, WorldX)).toBe(true)
  })

  it('two component pairs coexist, and disposal stops the system', () => {
    const w = createWorld({ headless: true })
    const r1 = w.use(composeTransforms(Local, WorldX, add))
    const r2 = w.use(composeTransforms(Local2, World2, add, { priority: -1 }))
    expect(isOk(r1) && isOk(r2)).toBe(true)
    if (!isOk(r1)) return
    const e = w.spawn([entry(Local, { x: 3 }), entry(Local2, { x: 4 })])
    w.stepOnce()
    expect(w.getComponent(e, WorldX)!.x).toBe(3)
    expect(w.getComponent(e, World2)!.x).toBe(4)
    r1.value()
    w.getComponent(e, Local)!.x = 9
    w.markChanged(e, Local)
    w.stepOnce()
    expect(w.getComponent(e, WorldX)!.x).toBe(3)
  })
})

describe('childrenOf order (O-65 S6)', () => {
  it('is ascending by id, before and after restore', () => {
    const w = createWorld({ headless: true })
    const root = w.spawn()
    const kids = [w.spawn(), w.spawn(), w.spawn()]
    // Parent kids in reverse id order so store insertion order differs.
    for (const k of [...kids].reverse()) expect(setParent(w, k, root).ok).toBe(true)
    expect(childrenOf(w, root)).toEqual(kids)
    w.restore(w.snapshot())
    expect(childrenOf(w, root)).toEqual(kids)
    expect(w.getComponent(kids[0]!, Parent)!.entity).toBe(root)
  })
})
