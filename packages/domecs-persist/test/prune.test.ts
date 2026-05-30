import { createWorld, defineComponent, entry, type WorldSnapshot } from '@domecs/core'
import { describe, expect, it } from 'vitest'
import { save } from '../src/persist.js'
import { pruneTransientOnlyEntities } from '../src/persist.js'
import { createMemoryStorage } from '../src/storage.js'

const Health = defineComponent<{ hp: number }>('Health', { defaults: { hp: 10 } })
const Hover = defineComponent<{ over: number }>('Hover', { transient: true })

describe('@domecs/persist — pruneTransientOnlyEntities (review #12)', () => {
  it('drops transient-only entities from the saved envelope', () => {
    const storage = createMemoryStorage()
    const w = createWorld()
    w.use(pruneTransientOnlyEntities())
    const real = w.spawn([entry(Health, { hp: 7 })])
    const ghost = w.spawn([entry(Hover, { over: 1 })])

    expect(save(w, storage, 'slot').ok).toBe(true)

    const raw = storage.read('slot')
    expect(raw.ok).toBe(true)
    if (!raw.ok || raw.value === null) throw new Error('expected bytes')
    const snap = JSON.parse(raw.value) as WorldSnapshot
    const ids = snap.entities.map((e) => e.id)
    expect(ids).toContain(real)
    expect(ids).not.toContain(ghost)
  })

  it('without the plugin, transient-only entities persist as empty bags', () => {
    const storage = createMemoryStorage()
    const w = createWorld()
    const ghost = w.spawn([entry(Hover, { over: 1 })])
    expect(save(w, storage, 'slot').ok).toBe(true)
    const raw = storage.read('slot')
    if (!raw.ok || raw.value === null) throw new Error('expected bytes')
    const snap = JSON.parse(raw.value) as WorldSnapshot
    expect(snap.entities.map((e) => e.id)).toContain(ghost)
  })
})
