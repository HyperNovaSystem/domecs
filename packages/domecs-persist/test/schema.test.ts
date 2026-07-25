import { createWorld, defineComponent } from '@domecs/core'
import { describe, expect, it } from 'vitest'
import {
  registerComponentTypes,
  serializeComponentType,
  type ComponentTypeData,
} from '../src/schema.js'

// Mirrors the GuestTransform pattern from DOMECS Studio
// (studio/src/components.ts) — an explicit schema + defaults, the shape
// user-authored component types will take once loaded from a document.
const GuestTransform = defineComponent<{
  x: number
  y: number
  rotation: number
  scale: number
}>('GuestTransform', {
  defaults: { x: 0, y: 0, rotation: 0, scale: 1 },
  schema: {
    fields: {
      x: { kind: 'number', min: -500, max: 500, step: 1 },
      y: { kind: 'number', min: -500, max: 500, step: 1 },
      rotation: { kind: 'number', min: -360, max: 360, step: 1 },
      scale: { kind: 'number', min: 0.1, max: 4, step: 0.1 },
    },
  },
})

describe('@domecs/persist — schema', () => {
  it('round-trips a defineComponent schema through serialize + register', () => {
    const world = createWorld()
    const descriptor = world.describeComponent(GuestTransform)
    const data = serializeComponentType(GuestTransform, descriptor)

    const { types, problems } = registerComponentTypes([data], new Set())
    expect(problems).toEqual([])
    expect(types).toHaveLength(1)

    const Rebuilt = types[0]!
    expect(Rebuilt.name).toBe('GuestTransform')
    expect(Rebuilt.create()).toEqual(GuestTransform.create())
    expect(Rebuilt.create({ x: 10, scale: 2 })).toEqual(GuestTransform.create({ x: 10, scale: 2 }))
  })

  it('serializes only the minimal shape (transient omitted when false)', () => {
    const world = createWorld()
    const descriptor = world.describeComponent(GuestTransform)
    const data = serializeComponentType(GuestTransform, descriptor)
    expect(data.transient).toBeUndefined()
    expect(data.name).toBe('GuestTransform')
    expect(data.fields).toEqual([
      { name: 'x', kind: 'number', default: 0, min: -500, max: 500, step: 1 },
      { name: 'y', kind: 'number', default: 0, min: -500, max: 500, step: 1 },
      { name: 'rotation', kind: 'number', default: 0, min: -360, max: 360, step: 1 },
      { name: 'scale', kind: 'number', default: 1, min: 0.1, max: 4, step: 0.1 },
    ])
  })

  it('marks transient: true when the source component is transient', () => {
    const Transient = defineComponent<{ v: number }>('TransientThing', {
      defaults: { v: 0 },
      transient: true,
      schema: { fields: { v: { kind: 'number' } } },
    })
    const world = createWorld()
    const data = serializeComponentType(Transient, world.describeComponent(Transient))
    expect(data.transient).toBe(true)
  })

  it('skips a component type whose name is reserved, reporting a SchemaProblem', () => {
    const data: ComponentTypeData[] = [{ name: 'Position', fields: [] }]
    const { types, problems } = registerComponentTypes(data, new Set(['Position']))
    expect(types).toHaveLength(0)
    expect(problems).toHaveLength(1)
    expect(problems[0]!.path).toBe('componentTypes[0]')
    expect(problems[0]!.message).toMatch(/reserved/i)
  })

  it('skips a field with an unrecognized kind but still registers the rest of the type', () => {
    const data: ComponentTypeData[] = [
      {
        name: 'Weird',
        fields: [
          { name: 'good', kind: 'number', default: 1 },
          { name: 'bad', kind: 'not-a-real-kind' as unknown as ComponentTypeData['fields'][number]['kind'], default: 2 },
        ],
      },
    ]
    const { types, problems } = registerComponentTypes(data, new Set())
    expect(types).toHaveLength(1)
    expect(problems).toEqual([
      { path: 'componentTypes[0].fields[1].kind', message: expect.stringMatching(/kind/i) },
    ])
    expect(types[0]!.create()).toEqual({ good: 1 })
  })

  it('skips a duplicate component type name within one call', () => {
    const data: ComponentTypeData[] = [
      { name: 'Dup', fields: [{ name: 'a', kind: 'number', default: 1 }] },
      { name: 'Dup', fields: [{ name: 'b', kind: 'number', default: 2 }] },
    ]
    const { types, problems } = registerComponentTypes(data, new Set())
    expect(types).toHaveLength(1)
    expect(problems).toEqual([{ path: 'componentTypes[1]', message: expect.stringMatching(/duplicate/i) }])
    expect(types[0]!.create()).toEqual({ a: 1 })
  })

  it('never throws — reserved, duplicate, and bad-kind problems all come back as data', () => {
    const data: ComponentTypeData[] = [
      { name: 'Position', fields: [] },
      { name: 'Dup', fields: [{ name: 'a', kind: 'number', default: 1 }] },
      { name: 'Dup', fields: [{ name: 'b', kind: 'number', default: 2 }] },
      {
        name: 'Weird',
        fields: [{ name: 'bad', kind: 'nope' as unknown as ComponentTypeData['fields'][number]['kind'] }],
      },
    ]
    expect(() => registerComponentTypes(data, new Set(['Position']))).not.toThrow()
  })
})
