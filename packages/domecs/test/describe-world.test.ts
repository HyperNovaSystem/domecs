import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import { defineResource } from '../src/resource.js'
import { defineEvent } from '../src/events.js'
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
    expect(typeof m.snapshotVersion).toBe('number')
    expect(Array.isArray(m.capabilities)).toBe(true)
    expect(Array.isArray(m.plugins)).toBe(true)
  })

  it('reports live debug counts: entityCount, componentCounts, archetypes', () => {
    const w = createWorld()
    w.spawn([entry(Position, { x: 1, y: 2 })])
    w.spawn([entry(Position, { x: 3, y: 4 }), entry(Velocity, { dx: 1 })])

    const m = w.describe()
    expect(m.entityCount).toBe(2)
    expect(m.componentCounts.Position).toBe(2)
    expect(m.componentCounts.Velocity).toBe(1)

    const archByKey = Object.fromEntries(
      m.archetypes.map((a) => [a.components.join('|'), a.entityCount]),
    )
    expect(archByKey.Position).toBe(1)
    expect(archByKey['Position|Velocity']).toBe(1)
  })

  it('is a snapshot — counts reflect the moment describe() was called', () => {
    const w = createWorld()
    const e = w.spawn([entry(Position, { x: 0, y: 0 })])
    expect(w.describe().entityCount).toBe(1)
    w.despawn(e)
    expect(w.describe().entityCount).toBe(0)
  })
})
