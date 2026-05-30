import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import type { ComponentSchema } from '../src/types.js'
import { createWorld } from '../src/world.js'

const HealthSchema: ComponentSchema = {
  fields: {
    hp: { kind: 'number', min: 0, max: 100, step: 1, label: 'Hit points' },
    team: { kind: 'enum', options: ['red', 'blue'] },
  },
}

const Health = defineComponent<{ hp: number; team: string }>('Health', {
  defaults: { hp: 10, team: 'red' },
  schema: HealthSchema,
})
const Position = defineComponent<{ x: number; y: number; tag: string; alive: boolean }>(
  'Position',
  { defaults: { x: 0, y: 0, tag: '', alive: true } },
)
const Marker = defineComponent<{ n: number }>('Marker')
const Ghost = defineComponent<{ over: number }>('Ghost', {
  defaults: { over: 0 },
  transient: true,
})

describe('world.describeComponent — schema reflection (review #14)', () => {
  it('reports name and transient flag', () => {
    const w = createWorld()
    expect(w.describeComponent(Health).name).toBe('Health')
    expect(w.describeComponent(Health).transient).toBe(false)
    expect(w.describeComponent(Ghost).transient).toBe(true)
  })

  it('surfaces an explicit schema verbatim with fieldsSource "schema"', () => {
    const w = createWorld()
    const d = w.describeComponent(Health)
    expect(d.fieldsSource).toBe('schema')
    expect(d.fields.hp).toEqual({ kind: 'number', min: 0, max: 100, step: 1, label: 'Hit points' })
    expect(d.fields.team).toEqual({ kind: 'enum', options: ['red', 'blue'] })
  })

  it('infers field kinds from defaults when no schema is given', () => {
    const w = createWorld()
    const d = w.describeComponent(Position)
    expect(d.fieldsSource).toBe('defaults')
    expect(d.fields.x?.kind).toBe('number')
    expect(d.fields.tag?.kind).toBe('string')
    expect(d.fields.alive?.kind).toBe('boolean')
  })

  it('returns empty fields with fieldsSource "none" for a bare component', () => {
    const w = createWorld()
    const d = w.describeComponent(Marker)
    expect(d.fieldsSource).toBe('none')
    expect(Object.keys(d.fields)).toHaveLength(0)
    expect(d.defaults).toBeUndefined()
  })

  it('returns defaults as an independent clone', () => {
    const w = createWorld()
    const d = w.describeComponent(Health)
    expect(d.defaults).toEqual({ hp: 10, team: 'red' })
    ;(d.defaults as { hp: number }).hp = 999
    // Mutating the descriptor must not corrupt the next create().
    expect(Health.create().hp).toBe(10)
  })

  it('describes any ComponentType without prior registration (from the world alone)', () => {
    const w = createWorld()
    const names = [Health, Position, Marker, Ghost].map((t) => w.describeComponent(t).name)
    expect(names).toEqual(['Health', 'Position', 'Marker', 'Ghost'])
  })
})
