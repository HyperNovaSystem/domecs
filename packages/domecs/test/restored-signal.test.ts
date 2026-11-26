import { describe, expect, it } from 'vitest'
import { createAgentBridge } from '../src/agent.js'
import { createBranch } from '../src/branch.js'
import { defineComponent } from '../src/component.js'
import { ok } from '../src/result.js'
import type { WorldSnapshot } from '../src/snapshot.js'
import { entry } from '../src/types.js'
import { createWorld, type World } from '../src/world.js'

// H-15 (Harbor findings): plugin onRestore runs before the snapshot is
// applied (O-50), so there was no moment at which derived state could be
// rebuilt once for every restore: boot, a Load button, a test, an agent's
// bridge.reset() and a branch all restore from different call sites.

const Hp = defineComponent<{ hp: number }>('RsHp', { defaults: { hp: 0 } })

function world(): { w: World; id: number } {
  const w = createWorld({ headless: true })
  const id = w.spawn([entry(Hp, { hp: 10 })])
  return { w, id }
}

describe('signals.restored (H-15)', () => {
  it('fires once per restore, after the snapshot is applied, with the envelope applied', () => {
    const { w, id } = world()
    const snap = w.snapshot()
    w.getComponent(id, Hp)!.hp = 3
    const seen: Array<{ hp: number; tick: number; inTick: boolean }> = []
    let applied: WorldSnapshot | undefined
    w.signals.restored.subscribe((s) => {
      applied = s
      let inTick = false
      try {
        w.render() // throws inside a tick
      } catch {
        inTick = true
      }
      seen.push({ hp: w.getComponent(id, Hp)!.hp, tick: w.time.tick, inTick })
    })
    w.stepOnce()
    w.restore(snap)
    expect(seen).toEqual([{ hp: 10, tick: 0, inTick: false }])
    expect(applied!.entities).toEqual(snap.entities)
  })

  it('passes the envelope the onRestore hooks produced', () => {
    const { w } = world()
    w.use({
      name: 'rs-codec',
      install: () => ok({ onRestore: (s: WorldSnapshot): WorldSnapshot => ({ ...s, meta: { decoded: true } }) }),
    })
    let meta: unknown
    w.signals.restored.subscribe((s) => void (meta = s.meta))
    w.restore(w.snapshot())
    expect(meta).toEqual({ decoded: true })
  })

  it('does not fire when the restore is refused', () => {
    const { w } = world()
    let n = 0
    w.signals.restored.subscribe(() => void n++)
    const good = w.snapshot()
    expect(() => w.restore({ ...good, tick: -1 })).toThrow()
    expect(n).toBe(0)
    w.restore(good)
    expect(n).toBe(1)
  })

  it('fires for bridge.reset() and for a branch built from a snapshot', () => {
    const { w } = world()
    const bridge = createAgentBridge(w)
    let resets = 0
    w.signals.restored.subscribe(() => void resets++)
    bridge.reset()
    bridge.reset()
    expect(resets).toBe(2)

    let branched = 0
    const b = createBranch((bw) => {
      bw.signals.restored.subscribe(() => void branched++)
    }, w.snapshot())
    expect(b.ok).toBe(true)
    expect(branched).toBe(1)
  })

  it('unsubscribes', () => {
    const { w } = world()
    let n = 0
    const off = w.signals.restored.subscribe(() => void n++)
    off()
    w.restore(w.snapshot())
    expect(n).toBe(0)
  })
})

// H-7: what is not a system (a HUD panel) needs to know a resource changed,
// even in a world with no entities for a query to report.
describe('signals.resourceChanged (H-7)', () => {
  it('fires for setResource and markResourceChanged, transient resources too, and not for restore', async () => {
    const { defineResource } = await import('../src/resource.js')
    const Cash = defineResource<number>('RsCash', { default: 0 })
    const Cam = defineResource<{ x: number }>('RsCam', { default: { x: 0 }, transient: true })
    const w = createWorld({ headless: true })
    const seen: string[] = []
    w.signals.resourceChanged.subscribe((type) => void seen.push(type.name))
    w.setResource(Cash, 5)
    w.getResource(Cam)!.x = 3
    w.markResourceChanged(Cam)
    const snap = w.snapshot()
    w.setResource(Cash, 6)
    w.restore(snap)
    expect(seen).toEqual(['RsCash', 'RsCam', 'RsCash'])
  })
})
