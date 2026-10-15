import type { WorldSnapshot } from '@domecs/core'
import { SNAPSHOT_VERSION, createWorld, ok } from '@domecs/core'
import { describe, expect, it } from 'vitest'
import { migrate, type Migration } from '../src/migrate.js'
import { registerComponentTypes, type ComponentTypeData } from '../src/schema.js'

const snap = (version: number): WorldSnapshot => ({ version, seed: [1, 2, 3, 4], tick: 0, entities: [] })

// O-63: persist validation gaps.
describe('migrate — one version per step (O-63 P3)', () => {
  it('rejects a step that skips versions', () => {
    const jump: Migration = (s) => ok({ ...s, version: 5 })
    const r = migrate(snap(1), 2, new Map([[1, jump]]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toMatch(/must produce version 2, got 5/)
  })

  it('restore rejects a snapshot newer than the engine', () => {
    const w = createWorld({ headless: true })
    expect(() => w.restore(snap(SNAPSHOT_VERSION + 1))).toThrow(/newer than this engine supports/)
    expect(() => w.restore({ ...snap(1), version: 1.5 })).toThrow(/version/)
    expect(() => w.restore(snap(SNAPSHOT_VERSION))).not.toThrow()
  })
})

describe('registerComponentTypes — malformed documents (O-63 P5)', () => {
  const none = new Set<string>()
  const register = (data: unknown) => registerComponentTypes(data as ComponentTypeData[], none)

  it('never throws on malformed entries and fields', () => {
    const r = register([
      null,
      { name: 'NoFields' },
      { name: 'Ok', fields: [null, { kind: 'number' }, { name: 'x', kind: 'number', default: 1 }] },
    ])
    expect(r.types.map((t) => t.name)).toEqual(['Ok'])
    expect(r.problems.map((p) => p.path)).toEqual([
      'componentTypes[0]',
      'componentTypes[1].fields',
      'componentTypes[2].fields[0]',
      'componentTypes[2].fields[1]',
    ])
    expect(register('nope').problems).toHaveLength(1)
  })

  it('reports __proto__ and duplicate fields instead of dropping or overwriting them', () => {
    const r = register([{
      name: 'VdDup',
      fields: [
        { name: '__proto__', kind: 'number', default: 1 },
        { name: 'a', kind: 'number', default: 1 },
        { name: 'a', kind: 'string', default: 'x' },
        { name: 'constructor', kind: 'string', default: 'c' },
      ],
    }])
    expect(r.problems.map((p) => p.message)).toEqual([
      'field name "__proto__" is not allowed',
      'duplicate field name "a"',
    ])
    expect(r.types[0]!.create()).toEqual({ a: 1, constructor: 'c' })
  })

  it('drops a default that does not match its kind, keeping the field', () => {
    const r = register([{
      name: 'VdKinds',
      fields: [
        { name: 'n', kind: 'number', default: 'one' },
        { name: 'e', kind: 'enum', options: ['a', 'b'], default: 'c' },
        { name: 'ok', kind: 'enum', options: ['a', 'b'], default: 'b' },
        { name: 'u', kind: 'unknown', default: null },
      ],
    }])
    expect(r.problems.map((p) => p.path)).toEqual([
      'componentTypes[0].fields[0].default',
      'componentTypes[0].fields[1].default',
    ])
    expect(r.types[0]!.create()).toEqual({ ok: 'b', u: null })
  })
})
