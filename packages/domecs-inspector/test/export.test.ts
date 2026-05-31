import { createWorld, defineComponent, entry } from '@domecs/core'
import type { SystemFault } from '@domecs/core'
import { describe, expect, it } from 'vitest'
import { createInspector } from '../src/index.js'

const Health = defineComponent<{ hp: number }>('Health', { defaults: { hp: 10 } })

function install(world: ReturnType<typeof createWorld>, ins: ReturnType<typeof createInspector>) {
  const r = world.use(ins.plugin)
  if (!r.ok) throw new Error(`expected ok install; got err(${r.error.kind})`)
  return r.value
}

describe('InspectorView.export — serializable snapshot', () => {
  it('returns a plain-object snapshot with copies of the live arrays', () => {
    const w = createWorld()
    const ins = createInspector({ recordStateChanges: true })
    install(w, ins)

    const e = w.spawn([entry(Health, { hp: -1 })])
    w.system('validator', { schedule: 'tick' }, () => ({
      errors: [
        {
          entity: e,
          component: Health.name,
          error: { kind: 'schema_mismatch', component: Health.name, expected: 'hp>=0', got: 'hp=-1', retryable: false },
          recoverable: true,
        } satisfies SystemFault,
      ],
    }))
    w.step(0.016)

    const view = ins.view

    // Verify there is something to snapshot
    expect(view.entries.length).toBeGreaterThan(0)
    expect(view.timeline.length).toBeGreaterThan(0)

    const snap = view.export()

    // Shape check: all four fields present as arrays
    expect(snap).toHaveProperty('entries')
    expect(snap).toHaveProperty('systemic')
    expect(snap).toHaveProperty('entityScoped')
    expect(snap).toHaveProperty('timeline')
    expect(Array.isArray(snap.entries)).toBe(true)
    expect(Array.isArray(snap.systemic)).toBe(true)
    expect(Array.isArray(snap.entityScoped)).toBe(true)
    expect(Array.isArray(snap.timeline)).toBe(true)

    // Copies, not the live references
    expect(snap.entries).not.toBe(view.entries)
    expect(snap.timeline).not.toBe(view.timeline)

    // Contents equal the live view at snapshot time
    expect(snap.entries).toEqual([...view.entries])
    expect(snap.systemic).toEqual([...view.systemic])
    expect(snap.entityScoped).toEqual([...view.entityScoped])
    expect(snap.timeline).toEqual([...view.timeline])
  })

  it('snapshot is stable after the live view grows', () => {
    const w = createWorld()
    const ins = createInspector()
    install(w, ins)

    const e = w.spawn([entry(Health, { hp: -1 })])
    w.system('validator', { schedule: 'tick' }, () => ({
      errors: [
        {
          entity: e,
          component: Health.name,
          error: { kind: 'schema_mismatch', component: Health.name, expected: 'hp>=0', got: 'hp=-1', retryable: false },
          recoverable: true,
        } satisfies SystemFault,
      ],
    }))
    w.step(0.016)

    const snap = ins.view.export()
    const countAtSnapshot = snap.entries.length

    // Run more ticks to grow the live buffer
    w.step(0.016)
    w.step(0.016)

    // Snapshot is frozen — does not reflect new entries
    expect(snap.entries.length).toBe(countAtSnapshot)
    // Live view has grown
    expect(ins.view.entries.length).toBeGreaterThan(countAtSnapshot)
  })
})
