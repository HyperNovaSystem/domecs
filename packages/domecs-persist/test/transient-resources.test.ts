// E17.1 (harness spec §6.4; O-36): `save()`, `load()` and snapshot history go
// through `snapshot()`/`restore()`, so a transient resource is never written
// to a slot and a load keeps the live value instead of restoring a stale one.
import { createWorld, defineResource } from '@domecs/core'
import { describe, expect, it } from 'vitest'
import { createSnapshotHistory } from '../src/history.js'
import { load, save } from '../src/persist.js'
import { createMemoryStorage } from '../src/storage.js'

const Camera = defineResource<{ x: number }>('PTrCamera', {
  default: () => ({ x: 0 }),
  transient: true,
})
const Gold = defineResource<number>('PTrGold', { default: 0 })

describe('@domecs/persist — transient resources (O-36)', () => {
  it('save() leaves a transient resource out of the slot; load() keeps the live value', () => {
    const storage = createMemoryStorage()
    const w = createWorld({ headless: true })
    w.setResource(Gold, 12)
    w.setResource(Camera, { x: 40 })
    expect(save(w, storage, 'slot').ok).toBe(true)
    const raw = storage.read('slot')
    if (!raw.ok || raw.value === null) throw new Error('slot not written')
    const written = JSON.parse(raw.value) as { resources?: Record<string, unknown> }
    expect(written.resources).toEqual({ PTrGold: 12 })

    w.setResource(Gold, 99)
    w.setResource(Camera, { x: 75 })
    expect(load(w, storage, 'slot').ok).toBe(true)
    expect(w.getResource(Gold)).toBe(12)
    expect(w.getResource(Camera)).toEqual({ x: 75 })
  })

  it('undo restores state but not the camera', () => {
    const w = createWorld({ headless: true })
    const history = createSnapshotHistory(w)
    w.setResource(Gold, 1)
    history.push()
    w.setResource(Gold, 2)
    w.setResource(Camera, { x: 5 })
    history.push()
    history.undo()
    expect(w.getResource(Gold)).toBe(1)
    expect(w.getResource(Camera)).toEqual({ x: 5 })
  })
})
