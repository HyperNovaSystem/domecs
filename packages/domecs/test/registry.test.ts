import { describe, expect, it } from 'vitest'
import {
  createWorld,
  defineComponent,
  defineEvent,
  defineResource,
  entry,
  hashSnapshot,
} from '../src/index.js'
import type { ComponentType, EventType, ResourceType } from '../src/index.js'

// §4.5 (G10; O-30, O-78): eager `register` and by-name lookup.

const Health = defineComponent<{ hp: number }>('Health', { defaults: { hp: 10 } })
const Mana = defineComponent<{ mp: number }>('Mana', { defaults: { mp: 5 } })
const Score = defineResource<number>('Score', { default: 0 })
const Damage = defineEvent<{ amount: number }>('Damage')
const Heal = defineEvent<{ amount: number }>('Heal')

const world = () => createWorld({ headless: true, seed: [1, 2, 3, 4] })
// `Faulted` is a built-in component every world registers.
const userComponents = (w: ReturnType<typeof world>) =>
  w.componentTypes().filter((t) => t.name !== 'Faulted')

describe('World.register — eager registration (O-30)', () => {
  it('lists a registered-but-unused component in componentTypes()', () => {
    const w = world()
    expect(w.componentTypes()).not.toContain(Mana)
    const r = w.register(Mana)
    expect(r).toEqual({ ok: true, value: undefined })
    expect(w.componentTypes()).toContain(Mana)
    expect(w.describe().components.map((c) => c.name)).toContain('Mana')
  })

  it('an unregistered, unused component is not listed', () => {
    const w = world()
    w.spawn([entry(Health, { hp: 1 })])
    expect(userComponents(w).map((t) => t.name)).toEqual(['Health'])
  })

  it('lists a registered event in eventTypes() and describe().events', () => {
    const w = world()
    expect(w.eventTypes()).toEqual([])
    expect(w.register(Damage).ok).toBe(true)
    expect(w.eventTypes()).toEqual([Damage])
    expect(w.describe().events.map((e) => e.name)).toEqual(['Damage'])
  })

  it('lists a registered resource without materializing its default', () => {
    const w = world()
    expect(w.register(Score).ok).toBe(true)
    expect(w.resourceTypes()).toEqual([Score])
    expect(w.describeResource(Score)).toEqual({ name: 'Score', hasValue: false, hasDefault: true, transient: false })
  })

  it('accepts a mix of kinds in one call and is idempotent', () => {
    const w = world()
    expect(w.register(Health, Damage, Score).ok).toBe(true)
    expect(w.register(Health, Damage, Score, Health).ok).toBe(true)
    expect(userComponents(w)).toEqual([Health])
    expect(w.eventTypes()).toEqual([Damage])
    expect(w.resourceTypes()).toEqual([Score])
  })

  it('returns name_conflict for a distinct component under a taken name (no throw)', () => {
    const w = world()
    w.spawn([entry(Health, { hp: 1 })])
    const Other = defineComponent<{ hp: number }>('Health')
    const r = w.register(Other)
    expect(r).toEqual({
      ok: false,
      error: { kind: 'name_conflict', registry: 'component', name: 'Health' },
    })
    expect(w.lookupComponent('Health')).toBe(Health)
  })

  it('returns name_conflict for a distinct resource under a taken name', () => {
    const w = world()
    w.register(Score)
    const Other = defineResource<number>('Score')
    expect(w.register(Other)).toEqual({
      ok: false,
      error: { kind: 'name_conflict', registry: 'resource', name: 'Score' },
    })
    expect(w.lookupResource('Score')).toBe(Score)
  })

  it('returns name_conflict for a distinct event under a taken name', () => {
    const w = world()
    expect(w.register(Damage).ok).toBe(true)
    const Damage2 = defineEvent<{ amount: number }>('Damage')
    expect(w.register(Damage2)).toEqual({
      ok: false,
      error: { kind: 'name_conflict', registry: 'event', name: 'Damage' },
    })
    // A failed register has no effect: the name stays unambiguous.
    expect(w.lookupEvent('Damage')).toBe(Damage)
    expect(w.eventTypes()).toEqual([Damage])
  })

  it('is all-or-nothing: a conflict registers none of the call', () => {
    const w = world()
    w.register(Health)
    const OtherHealth = defineComponent<{ hp: number }>('Health')
    const r = w.register(Mana, Damage, Score, OtherHealth)
    expect(r.ok).toBe(false)
    expect(userComponents(w)).toEqual([Health])
    expect(w.eventTypes()).toEqual([])
    expect(w.resourceTypes()).toEqual([])
  })

  it('detects a conflict between two arguments of the same call', () => {
    const w = world()
    const A1 = defineEvent('Ping')
    const A2 = defineEvent('Ping')
    expect(w.register(A1, A2)).toEqual({
      ok: false,
      error: { kind: 'name_conflict', registry: 'event', name: 'Ping' },
    })
    expect(w.eventTypes()).toEqual([])
    const C1 = defineComponent('Tag')
    const C2 = defineComponent('Tag')
    expect(w.register(C1, C2)).toEqual({
      ok: false,
      error: { kind: 'name_conflict', registry: 'component', name: 'Tag' },
    })
  })

  it('keeps separate namespaces per kind', () => {
    const w = world()
    const C = defineComponent('Thing')
    const E = defineEvent('Thing')
    const R = defineResource('Thing')
    expect(w.register(C, E, R).ok).toBe(true)
    expect(w.lookupComponent('Thing')).toBe(C)
    expect(w.lookupEvent('Thing')).toBe(E)
    expect(w.lookupResource('Thing')).toBe(R)
  })

  it('throws TypeError for a value that is not a component, event or resource type', () => {
    const w = world()
    expect(() => w.register({ name: 'Nope' } as unknown as EventType<unknown>)).toThrow(TypeError)
  })

  it('does not change the snapshot or its hash', () => {
    const a = world()
    const b = world()
    a.spawn([entry(Health, { hp: 3 })])
    b.spawn([entry(Health, { hp: 3 })])
    b.register(Mana, Damage, Score)
    expect(b.snapshot()).toEqual(a.snapshot())
    expect(hashSnapshot(b.snapshot(), { includeChanges: true })).toBe(
      hashSnapshot(a.snapshot(), { includeChanges: true }),
    )
  })

  it('survives restore (registries are not snapshotted)', () => {
    const w = world()
    const snap = w.snapshot()
    w.register(Mana, Damage, Score)
    w.restore(snap)
    expect(w.lookupComponent('Mana')).toBe(Mana)
    expect(w.lookupEvent('Damage')).toBe(Damage)
    expect(w.lookupResource('Score')).toBe(Score)
  })
})

describe('World.lookupComponent / lookupEvent / lookupResource', () => {
  it('hit after registration or implicit use, miss otherwise', () => {
    const w = world()
    expect(w.lookupComponent('Health')).toBeUndefined()
    expect(w.lookupEvent('Damage')).toBeUndefined()
    expect(w.lookupResource('Score')).toBeUndefined()

    w.spawn([entry(Health, { hp: 1 })]) // implicit component discovery
    w.emit(Damage, { amount: 1 }) // implicit event discovery
    w.getResource(Score) // implicit resource discovery

    expect(w.lookupComponent('Health')).toBe(Health)
    expect(w.lookupEvent('Damage')).toBe(Damage)
    expect(w.lookupResource('Score')).toBe(Score)
    expect(w.lookupComponent('Mana')).toBeUndefined()
    expect(w.lookupEvent('Heal')).toBeUndefined()
    expect(w.lookupResource('Nope')).toBeUndefined()
  })

  it('finds events named as triggers or subscribed to', () => {
    const w = world()
    w.system('heal', { schedule: 'event', triggers: [Heal as EventType<unknown>] }, () => {})
    w.on(Damage, () => {})
    expect(w.lookupEvent('Heal')).toBe(Heal)
    expect(w.lookupEvent('Damage')).toBe(Damage)
  })

  it('two same-named events coexist (F-8); the name is ambiguous', () => {
    const w = world()
    const Twin = defineEvent<number>('Damage')
    const seen: string[] = []
    w.on(Damage, () => seen.push('a'))
    w.on(Twin, () => seen.push('b'))
    expect(w.lookupEvent('Damage')).toBeUndefined()
    // Identity semantics unchanged: each object still has its own channel.
    w.emit(Twin, 1)
    w.stepOnce()
    expect(seen).toEqual(['b'])
    // Both stay listed; registering either one now reports the conflict.
    expect(w.eventTypes()).toEqual([Damage, Twin])
    expect(w.register(Twin)).toEqual({
      ok: false,
      error: { kind: 'name_conflict', registry: 'event', name: 'Damage' },
    })
    expect(w.register(Damage).ok).toBe(false)
  })

  it('an ambiguous name stays ambiguous after restore', () => {
    const w = world()
    const snap = w.snapshot()
    w.emit(Damage, { amount: 1 })
    w.emit(defineEvent('Damage'), 2)
    w.restore(snap)
    expect(w.lookupEvent('Damage')).toBeUndefined()
  })
})

describe('World.eventTypes — first-seen order', () => {
  it('orders by first registration, emit, subscription or trigger', () => {
    const w = world()
    const A = defineEvent('A')
    const B = defineEvent('B')
    const C = defineEvent('C')
    const D = defineEvent('D')
    w.emit(B, undefined)
    w.register(A)
    w.on(D, () => {})
    w.system('c', { schedule: 'event', triggers: [C] }, () => {})
    w.register(B) // already known: keeps its first-seen slot
    expect(w.eventTypes().map((t) => t.name)).toEqual(['B', 'A', 'D', 'C'])
  })

  it('returns a fresh array each call', () => {
    const w = world()
    w.register(Damage)
    const list = w.eventTypes()
    list.push(Heal as EventType<unknown>)
    expect(w.eventTypes()).toEqual([Damage])
  })
})

// Compile-time shape checks for the new surface.
export type _Check = [
  ReturnType<ReturnType<typeof world>['lookupComponent']> extends ComponentType<unknown> | undefined ? true : never,
  ReturnType<ReturnType<typeof world>['lookupResource']> extends ResourceType<unknown> | undefined ? true : never,
]
