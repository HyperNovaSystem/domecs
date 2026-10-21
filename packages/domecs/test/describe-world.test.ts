import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import { defineResource } from '../src/resource.js'
import { defineEvent } from '../src/events.js'
import { definePlugin } from '../src/plugin.js'
import { SNAPSHOT_VERSION } from '../src/snapshot.js'
import { entry } from '../src/types.js'
import { createWorld } from '../src/world.js'

const Position = defineComponent<{ x: number; y: number }>('Position', {
  defaults: { x: 0, y: 0 },
})
const Velocity = defineComponent<{ dx: number }>('Velocity', { defaults: { dx: 0 } })
const Score = defineResource<{ points: number }>('Score', { default: () => ({ points: 0 }) })
const Tick = defineEvent<void>('Tick')

describe('world.describe — composed manifest (§6)', () => {
  it('composes the describe* family and the static surface', () => {
    const w = createWorld()
    // Register Position in the type registry by spawning an entity with it
    w.spawn([entry(Position, { x: 0, y: 0 })])
    w.describeResource(Score)
    w.on(Tick, () => {})
    w.system('mover', { schedule: 'tick' }, () => {})

    const m = w.describe()
    expect(m.components.map((c) => c.name)).toContain('Position')
    expect(m.resources.map((r) => r.name)).toContain('Score')
    expect(m.events.map((e) => e.name)).toContain('Tick')
    expect(m.systems.find((s) => s.name === 'mover')).toMatchObject({
      schedule: 'tick',
      enabled: true,
    })
    expect(m.snapshotVersion).toBe(SNAPSHOT_VERSION)
    expect(Array.isArray(m.capabilities)).toBe(true)
    expect(Array.isArray(m.plugins)).toBe(true)
  })

  it('projects installed plugins and dedupes+sorts their capabilities', () => {
    const w = createWorld()
    const physics = definePlugin({
      name: 'physics',
      version: '1.0.0',
      provides: ['gravity', 'collision'],
      install: () => {},
    })
    const audio = definePlugin({
      name: 'audio', // no version
      provides: ['sound'],
      install: () => {},
    })
    expect(w.use(physics).ok).toBe(true)
    expect(w.use(audio).ok).toBe(true)

    const m = w.describe()
    // capabilities: union of all provides, deduped and sorted
    expect(m.capabilities).toEqual(['collision', 'gravity', 'sound'])

    const physicsEntry = m.plugins.find((p) => p.name === 'physics')
    expect(physicsEntry).toEqual({
      name: 'physics',
      version: '1.0.0',
      provides: ['gravity', 'collision'],
    })

    const audioEntry = m.plugins.find((p) => p.name === 'audio')
    expect(audioEntry).toMatchObject({ name: 'audio', provides: ['sound'] })
    // version is omitted entirely (not present as undefined) when not declared
    expect(audioEntry).not.toHaveProperty('version')
  })

  it('reports live debug counts: entityCount, componentCounts, archetypes', () => {
    const w = createWorld()
    w.spawn([entry(Position, { x: 1, y: 2 })])
    // spawn the two-component archetype with types in reverse-alphabetical
    // order to prove the manifest sorts archetype component lists.
    w.spawn([entry(Velocity, { dx: 1 }), entry(Position, { x: 3, y: 4 })])

    const m = w.describe()
    expect(m.entityCount).toBe(2)
    expect(m.componentCounts.Position).toBe(2)
    expect(m.componentCounts.Velocity).toBe(1)

    const archByKey = Object.fromEntries(
      m.archetypes.map((a) => [a.components.join('|'), a.entityCount]),
    )
    expect(archByKey.Position).toBe(1)
    expect(archByKey['Position|Velocity']).toBe(1)

    // the two-component archetype's component list is sorted, not insertion-order
    const multi = m.archetypes.find((a) => a.components.length === 2)
    expect(multi?.components).toEqual(['Position', 'Velocity'])
  })

  it('is a snapshot — counts reflect the moment describe() was called', () => {
    const w = createWorld()
    const e = w.spawn([entry(Position, { x: 0, y: 0 })])
    expect(w.describe().entityCount).toBe(1)
    w.despawn(e)
    expect(w.describe().entityCount).toBe(0)
  })
})

describe('world.describe — commands are discoverable (O-51)', () => {
  it('lists an event system trigger with its schema before anything emits it', () => {
    const Move = defineEvent<{ dx: number }>('DwMove', {
      schema: { fields: { dx: { kind: 'number', min: -1, max: 1 } } },
    })
    const w = createWorld({ headless: true })
    w.system('move', { schedule: 'event', triggers: [Move] }, () => {})
    const entry = w.describe().events.find((e) => e.name === 'DwMove')
    expect(entry).toEqual({
      name: 'DwMove',
      fields: { dx: { kind: 'number', min: -1, max: 1 } },
      fieldsSource: 'schema',
    })
  })
})

describe('describe().componentCounts across restore (E11 verify)', () => {
  it('restore keeps an empty store for every registered type, so reads after it change nothing', () => {
    // Before: a registered type nobody holds counted 0 until restore, then
    // vanished, then came back as 0 on the next read of it (has, getComponent,
    // listEntities) — a read changed describe(), which a read-only probe
    // (a rules world expression) must not do.
    const w = createWorld({ headless: true })
    const e = w.spawn([entry(Position, { x: 1, y: 2 })])
    w.despawn(w.spawn([entry(Velocity, { dx: 1 })]))
    const live = JSON.stringify(w.describe().componentCounts)
    expect(w.describe().componentCounts.Velocity).toBe(0)
    w.restore(w.snapshot())
    expect(JSON.stringify(w.describe().componentCounts)).toBe(live)
    expect(w.has(e, Velocity)).toBe(false)
    expect(w.getComponent(e, Velocity)).toBeUndefined()
    expect(w.listEntities([Velocity])).toEqual([])
    expect(JSON.stringify(w.describe().componentCounts)).toBe(live)
  })
})
