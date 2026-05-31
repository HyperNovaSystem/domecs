import { createWorld, defineComponent, err, ok, type WorldSnapshot } from '@domecs/core'
import { entry } from '@domecs/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { load, save } from '../src/persist.js'
import { createMemoryStorage, type Storage } from '../src/storage.js'
import type { Migration } from '../src/migrate.js'

const Health = defineComponent<{ hp: number }>('Health', { defaults: { hp: 10 } })
const Tag = defineComponent<{ name: string }>('Tag', { defaults: { name: '' } })

describe('@domecs/persist — save/load round-trip', () => {
  let storage: Storage

  beforeEach(() => {
    storage = createMemoryStorage()
  })

  it('save then load round-trips entities and components', () => {
    const w1 = createWorld()
    const e = w1.spawn([entry(Health, { hp: 7 }), entry(Tag, { name: 'goblin' })])
    expect(save(w1, storage, 'slot').ok).toBe(true)

    const w2 = createWorld()
    expect(load(w2, storage, 'slot').ok).toBe(true)
    const h = w2.getComponent(e, Health)
    const t = w2.getComponent(e, Tag)
    expect(h?.hp).toBe(7)
    expect(t?.name).toBe('goblin')
  })

  it('load on an empty slot returns persist_io', () => {
    const w = createWorld()
    const r = load(w, storage, 'missing')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('persist_io')
      if (r.error.kind === 'persist_io') {
        expect(r.error.op).toBe('load')
        expect(r.error.cause.message).toMatch(/empty/)
      }
    }
  })

  it('load on malformed JSON returns persist_io with the parse cause', () => {
    storage.write('bad', '{this is not json')
    const w = createWorld()
    const r = load(w, storage, 'bad')
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === 'persist_io') {
      expect(r.error.op).toBe('load')
      expect(typeof r.error.cause.message).toBe('string')
    }
  })

  it('load on a non-snapshot JSON object returns persist_io', () => {
    storage.write('weird', JSON.stringify({ hello: 'world' }))
    const w = createWorld()
    const r = load(w, storage, 'weird')
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === 'persist_io') {
      expect(r.error.cause.message).toMatch(/does not contain a WorldSnapshot/)
    }
  })

  it('save serialization failure (BigInt) leaves the slot untouched', () => {
    const Bad = defineComponent<{ huge: bigint }>('Bad', { defaults: { huge: 1n } })
    const w = createWorld()
    w.spawn([entry(Bad, { huge: 42n })])
    storage.write('slot', 'original-bytes')
    const r = save(w, storage, 'slot')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('persist_io')
    const after = storage.read('slot')
    expect(after.ok && after.value).toBe('original-bytes')
  })

  it('migration failure during load leaves the slot bytes intact', () => {
    // Write a v0 snapshot directly, then attempt to load with no v0→v1
    // migration registered. The slot must still read back the original
    // bytes — "mark the slot, do not corrupt it."
    const v0: WorldSnapshot = { version: 0, seed: [1, 2, 3, 4], tick: 0, entities: [] }
    const bytes = JSON.stringify(v0)
    storage.write('legacy', bytes)
    const w = createWorld()
    const r = load(w, storage, 'legacy', { targetVersion: 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('migration_failed')
    const after = storage.read('legacy')
    expect(after.ok && after.value).toBe(bytes)
  })

  it('load applies a registered migration chain before restore', () => {
    // Write a v0 snapshot with one entity, register v0→v1 that renames a
    // legacy "HP" component key into the real "Health" component.
    const v0: WorldSnapshot = {
      version: 0,
      seed: [1, 2, 3, 4],
      tick: 5,
      entities: [{ id: 0 as never, components: { HP: { hp: 11 } } }],
    }
    storage.write('legacy', JSON.stringify(v0))

    const rename: Migration = (snap) =>
      ok({
        ...snap,
        version: snap.version + 1,
        entities: snap.entities.map((ent) => {
          const { HP, ...rest } = ent.components as { HP?: unknown }
          return HP !== undefined
            ? { ...ent, components: { ...rest, Health: HP } }
            : ent
        }),
      })

    const w = createWorld()
    // Pre-register the Health component so restore can re-attach it.
    w.spawn([entry(Health, { hp: 0 })])

    const r = load(w, storage, 'legacy', {
      targetVersion: 1,
      migrations: new Map([[0, rename]]),
    })
    expect(r.ok).toBe(true)
    // Tick was preserved through migration.
    expect(w.time.tick).toBe(5)
    const h = w.getComponent(0 as never, Health)
    expect(h?.hp).toBe(11)
  })

  it('save stamps a numeric savedAt into the snapshot meta (review #9)', () => {
    const w = createWorld()
    w.spawn([entry(Health, { hp: 1 })])
    expect(save(w, storage, 'slot').ok).toBe(true)
    const read = storage.read('slot')
    expect(read.ok).toBe(true)
    const snap = JSON.parse((read as { value: string }).value) as WorldSnapshot
    expect(typeof snap.meta?.savedAt).toBe('number')
  })

  it('save merges caller meta into the envelope (review #9)', () => {
    const w = createWorld()
    expect(save(w, storage, 'slot', { meta: { label: 'checkpoint', n: 3 } }).ok).toBe(true)
    const read = storage.read('slot')
    const snap = JSON.parse((read as { value: string }).value) as WorldSnapshot
    expect(snap.meta?.label).toBe('checkpoint')
    expect(snap.meta?.n).toBe(3)
    expect(typeof snap.meta?.savedAt).toBe('number')
  })

  it('an explicit savedAt opt is honored verbatim (review #9)', () => {
    const w = createWorld()
    expect(save(w, storage, 'slot', { savedAt: 1234567 }).ok).toBe(true)
    const read = storage.read('slot')
    const snap = JSON.parse((read as { value: string }).value) as WorldSnapshot
    expect(snap.meta?.savedAt).toBe(1234567)
  })

  it('save preserves plugin-provided snapshot meta alongside savedAt (review #9)', () => {
    const w = createWorld()
    w.use({
      name: 'stamp',
      install: () =>
        ok({
          onSnapshot: (s: WorldSnapshot) => ({ ...s, meta: { ...s.meta, source: 'plugin' } }),
        }),
    })
    expect(save(w, storage, 'slot', { meta: { label: 'x' } }).ok).toBe(true)
    const read = storage.read('slot')
    const snap = JSON.parse((read as { value: string }).value) as WorldSnapshot
    expect(snap.meta?.source).toBe('plugin')
    expect(snap.meta?.label).toBe('x')
    expect(typeof snap.meta?.savedAt).toBe('number')
  })

  it('3-arg save is unchanged and round-trips via load (review #9 back-compat)', () => {
    const w1 = createWorld()
    const e = w1.spawn([entry(Health, { hp: 5 })])
    expect(save(w1, storage, 'slot').ok).toBe(true)
    const w2 = createWorld()
    expect(load(w2, storage, 'slot').ok).toBe(true)
    expect(w2.getComponent(e, Health)?.hp).toBe(5)
  })

  it('loads a legacy v1 snapshot via the built-in 1->2 migration (review #16)', () => {
    // A v1 save predates resources. Loading it with the default target
    // (current SNAPSHOT_VERSION) must succeed via the built-in 1->2 step,
    // restoring entities with an empty resource set.
    const v1: WorldSnapshot = {
      version: 1,
      seed: [1, 2, 3, 4],
      tick: 3,
      entities: [{ id: 0 as never, components: { Health: { hp: 8 } } }],
    }
    storage.write('legacy', JSON.stringify(v1))
    const w = createWorld()
    const r = load(w, storage, 'legacy') // default target = current version
    expect(r.ok).toBe(true)
    expect(w.time.tick).toBe(3)
    expect(w.getComponent(0 as never, Health)?.hp).toBe(8)
  })

  it('built-in migrations do not paper over pre-v1 gaps (v0 with no user migration fails)', () => {
    const v0: WorldSnapshot = { version: 0, seed: [1, 2, 3, 4], tick: 0, entities: [] }
    storage.write('ancient', JSON.stringify(v0))
    const w = createWorld()
    const r = load(w, storage, 'ancient') // default target, only the built-in 1->2
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('migration_failed')
  })

  it('migration that returns err propagates the kind through load', () => {
    const v0: WorldSnapshot = { version: 0, seed: [1, 2, 3, 4], tick: 0, entities: [] }
    storage.write('legacy', JSON.stringify(v0))
    const refuse: Migration = () =>
      err({
        kind: 'migration_failed',
        from: 0,
        to: 1,
        reason: 'incompatible schema',
        recoverable: false,
        retryable: false,
      })
    const w = createWorld()
    const r = load(w, storage, 'legacy', {
      targetVersion: 1,
      migrations: new Map([[0, refuse]]),
    })
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === 'migration_failed') {
      expect(r.error.reason).toBe('incompatible schema')
    }
  })
})
