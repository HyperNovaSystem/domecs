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

  it('removes World_ when the entity loses Local, the same after a restore', () => {
    const mk = () => {
      const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
      w.use(composeTransforms(Local, WorldX, add))
      return w
    }
    const live = mk()
    const e = live.spawn([entry(Local, { x: 1 })])
    live.stepOnce()
    const restored = mk()
    restored.restore(live.snapshot())
    for (const w of [live, restored]) {
      w.removeComponent(e, Local)
      w.stepOnce()
      expect(w.has(e, WorldX)).toBe(false)
    }
    expect(JSON.stringify(restored.snapshot())).toEqual(JSON.stringify(live.snapshot()))
  })

  it('marks a World_ whose fields hold objects every time (in-place changes are invisible)', () => {
    const L = defineComponent<{ p: { x: number } }>('ClLn', { defaults: { p: { x: 0 } } })
    const W = defineComponent<{ p: { x: number } }>('ClWn', { defaults: { p: { x: 0 } } })
    const w = createWorld({ headless: true })
    w.use(composeTransforms(L, W, (pw, l) => ({ p: pw ? { x: pw.p.x + l.p.x } : l.p })))
    const e = w.spawn([entry(L, { p: { x: 1 } })])
    w.stepOnce()
    const q = w.query(OnChanged(W))
    expect(q.entities.map((v) => v.id)).toEqual([])
    w.getComponent(e, L)!.p.x = 5
    w.markChanged(e, L)
    w.stepOnce()
    expect(q.entities.map((v) => v.id)).toEqual([e])
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
