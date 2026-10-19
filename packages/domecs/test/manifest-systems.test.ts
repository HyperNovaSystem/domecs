import { describe, expect, it } from 'vitest'
import {
  createWorld,
  defineComponent,
  defineEvent,
  defineResource,
  Has,
  Not,
  OnChanged,
  OnChangedResource,
  Or,
  Where,
  And,
  OnAdded,
  OnRemoved,
} from '../src/index.js'
import type { JsonValue } from '../src/index.js'

// §4.5 (G10; O-78): richer manifest systems entries and field descriptions.

const Pos = defineComponent<{ x: number }>('Pos', { defaults: { x: 0 } })
const Vel = defineComponent<{ v: number }>('Vel', { defaults: { v: 0 } })
const Dead = defineComponent('Dead')
const Armor = defineComponent<{ a: number }>('Armor', { defaults: { a: 0 } })
const Tag = defineComponent('Tag')
const Score = defineResource<number>('Score', { default: 0 })

const world = () => createWorld({ headless: true })
const entryFor = (w: ReturnType<typeof world>, name: string) => {
  const s = w.describe().systems.find((x) => x.name === name)
  if (!s) throw new Error(`no system ${name}`)
  return s
}

describe('describe().systems — priority, order, components, meta', () => {
  it('carries priority and order', () => {
    const w = world()
    w.system('a', { priority: 7, order: -2 }, () => {})
    w.system('b', {}, () => {})
    expect(entryFor(w, 'a')).toMatchObject({ priority: 7, order: -2 })
    expect(entryFor(w, 'b')).toMatchObject({ priority: 0, order: 0 })
  })

  it('lists the component names a tuple query references, sorted', () => {
    const w = world()
    w.system('mover', { query: [Vel, Pos] }, () => {})
    w.system('idle', {}, () => {})
    expect(entryFor(w, 'mover').components).toEqual(['Pos', 'Vel'])
    expect(entryFor(w, 'idle').components).toEqual([])
  })

  it('includes every component a combinator query names, de-duplicated', () => {
    const w = world()
    w.system(
      'combo',
      {
        query: And(
          Has(Pos),
          Not(Dead),
          Or(Has(Vel), Where(Armor, (v) => (v as { a: number }).a > 0)),
          OnAdded(Pos),
          OnRemoved(Tag),
        ),
      },
      () => {},
    )
    expect(entryFor(w, 'combo').components).toEqual(['Armor', 'Dead', 'Pos', 'Tag', 'Vel'])
  })

  it('includes reactsTo components (change nodes) and ignores resource leaves', () => {
    const w = world()
    w.system(
      'react',
      {
        schedule: 'reactive',
        query: [Pos],
        reactsTo: Or(OnChanged(Vel), OnChangedResource(Score)),
      },
      () => {},
    )
    expect(entryFor(w, 'react').components).toEqual(['Pos', 'Vel'])
  })

  it('omits meta when none was given', () => {
    const w = world()
    w.system('plain', {}, () => {})
    expect('meta' in entryFor(w, 'plain')).toBe(false)
  })

  it('surfaces meta as a clone: mutating the result does not leak', () => {
    const w = world()
    const meta: JsonValue = { rule: 'gravity', tags: ['physics'] }
    w.system('g', { meta }, () => {})
    const first = entryFor(w, 'g').meta as { rule: string; tags: string[] }
    expect(first).toEqual({ rule: 'gravity', tags: ['physics'] })
    first.rule = 'changed'
    first.tags.push('oops')
    expect(entryFor(w, 'g').meta).toEqual({ rule: 'gravity', tags: ['physics'] })
  })

  it('is not affected by later mutation of the def passed to system()', () => {
    const w = world()
    const meta = { owner: 'a' }
    w.system('m', { meta }, () => {})
    meta.owner = 'b'
    expect(entryFor(w, 'm').meta).toEqual({ owner: 'a' })
  })

  it('accepts scalar meta values', () => {
    const w = world()
    w.system('n', { meta: 3 }, () => {})
    w.system('s', { meta: 'x' }, () => {})
    w.system('z', { meta: null }, () => {})
    expect(entryFor(w, 'n').meta).toBe(3)
    expect(entryFor(w, 's').meta).toBe('x')
    expect(entryFor(w, 'z').meta).toBe(null)
  })
})

describe('field and event descriptions', () => {
  it('FieldSchema.description surfaces through describeComponent', () => {
    const Hp = defineComponent<{ hp: number }>('Hp', {
      defaults: { hp: 10 },
      schema: { fields: { hp: { kind: 'number', description: 'Hit points; 0 means dead' } } },
    })
    expect(world().describeComponent(Hp).fields.hp).toEqual({
      kind: 'number',
      description: 'Hit points; 0 means dead',
    })
  })

  it('EventDefOptions.description surfaces through describeEvent and describe()', () => {
    const Damage = defineEvent<{ amount: number }>('Damage', {
      description: 'Deal damage to the player',
      schema: { fields: { amount: { kind: 'number', description: 'HP to remove' } } },
    })
    const w = world()
    w.register(Damage)
    const d = w.describeEvent(Damage)
    expect(d.description).toBe('Deal damage to the player')
    expect(d.fields.amount).toEqual({ kind: 'number', description: 'HP to remove' })
    expect(w.describe().events[0]?.description).toBe('Deal damage to the player')
  })

  it('an event without a description has no description key', () => {
    const Ping = defineEvent('Ping')
    expect('description' in world().describeEvent(Ping)).toBe(false)
    const Pong = defineEvent('Pong', { description: 'pong' })
    expect(world().describeEvent(Pong)).toEqual({
      name: 'Pong',
      fields: {},
      fieldsSource: 'none',
      description: 'pong',
    })
  })
})

// §4.5: `meta` is a JSON-safe annotation. A value JSON cannot carry is
// refused at world.system() (like a non-finite `order`) instead of leaking a
// live function / NaN into the plain-data manifest or overflowing the stack
// on a cycle.
describe('describe().systems — meta must be JSON-safe', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const bad: [string, unknown, RegExp][] = [
    ['function', { fn: () => 1 }, /meta\.fn/],
    ['undefined member', { u: undefined }, /meta\.u/],
    ['NaN', { n: NaN }, /meta\.n/],
    ['Infinity', [1, Infinity], /meta\[1\]/],
    ['sparse array hole', [1, , 3], /meta\[1\]/],
    ['bigint', { b: 1n }, /meta\.b/],
    ['symbol', Symbol('s'), /meta\b/],
    ['class instance', { d: new Date(0) }, /meta\.d/],
    ['Map', new Map(), /meta\b/],
    ['cycle', cyclic, /meta\.self/],
  ]
  for (const [label, meta, path] of bad) {
    it(`throws TypeError for a ${label} and registers nothing`, () => {
      const w = world()
      expect(() => w.system('bad', { meta: meta as JsonValue }, () => {})).toThrow(TypeError)
      expect(() => w.system('bad', { meta: meta as JsonValue }, () => {})).toThrow(path)
      expect(w.describe().systems.some((s) => s.name === 'bad')).toBe(false)
    })
  }

  it('accepts nested plain JSON, null-prototype objects and shared (acyclic) references', () => {
    const w = world()
    const shared = { k: 1 }
    const bare = Object.assign(Object.create(null) as Record<string, JsonValue>, { z: true })
    w.system('ok', { meta: { a: [1, 'x', null, false, { b: -0 }], s1: shared, s2: shared, bare } }, () => {})
    expect(entryFor(w, 'ok').meta).toEqual({
      a: [1, 'x', null, false, { b: -0 }],
      s1: { k: 1 },
      s2: { k: 1 },
      bare: { z: true },
    })
  })
})
