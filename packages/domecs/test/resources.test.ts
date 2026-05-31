import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import { defineResource } from '../src/resource.js'
import { And, OnChangedResource, Has } from '../src/query.js'
import { SNAPSHOT_VERSION } from '../src/snapshot.js'
import { entry } from '../src/types.js'
import { createWorld } from '../src/world.js'

describe('defineResource + world.resource/setResource (review #16)', () => {
  it('resource() returns the declared default (lazily materialized)', () => {
    const Count = defineResource<number>('Count', { default: 7 })
    const w = createWorld()
    expect(w.resource(Count)).toBe(7)
  })

  it('resource() returns undefined when no default is declared', () => {
    const Opt = defineResource<number>('Opt')
    const w = createWorld()
    expect(w.resource(Opt)).toBeUndefined()
  })

  it('setResource then resource() returns the stored value', () => {
    const Score = defineResource<number>('Score', { default: 0 })
    const w = createWorld()
    w.setResource(Score, 42)
    expect(w.resource(Score)).toBe(42)
  })

  it('a function default is treated as a per-world factory (no cross-world sharing)', () => {
    const List = defineResource<number[]>('List', { default: () => [] })
    const w1 = createWorld()
    const w2 = createWorld()
    w1.resource(List)!.push(1)
    expect(w1.resource(List)).toEqual([1])
    expect(w2.resource(List)).toEqual([])
  })

  it('a returned resource object is the live, mutable singleton', () => {
    const Cfg = defineResource<{ v: number }>('Cfg', { default: { v: 1 } })
    const w = createWorld()
    w.resource(Cfg)!.v = 9
    expect(w.resource(Cfg)!.v).toBe(9)
  })

  it('setResource runs the validator and throws on a rejected value', () => {
    const Hp = defineResource<number>('GlobalHp', {
      default: 100,
      validate: (v) => v >= 0 || 'must be >= 0',
    })
    const w = createWorld()
    expect(() => w.setResource(Hp, -5)).toThrow(/invalid resource/i)
    expect(() => w.setResource(Hp, 10)).not.toThrow()
  })

  it('two distinct ResourceType objects sharing a name is an error', () => {
    const A = defineResource<number>('Dup')
    const B = defineResource<number>('Dup')
    const w = createWorld()
    w.setResource(A, 1)
    expect(() => w.setResource(B, 2)).toThrow(/distinct ResourceType/i)
  })
})

describe('ChangedResource — reactive gating (review #16)', () => {
  it('fires a reactive system on the tick a resource changes, not on quiet ticks', () => {
    const Score = defineResource<number>('Score', { default: 0 })
    const w = createWorld()
    let fired = 0
    w.system('react', { schedule: 'reactive', reactsTo: OnChangedResource(Score) }, () => {
      fired++
    })
    w.step() // quiet tick
    expect(fired).toBe(0)
    w.setResource(Score, 10) // between ticks -> pending
    w.step() // promoted at step 0 -> reactive fires
    expect(fired).toBe(1)
    w.step() // quiet again
    expect(fired).toBe(1)
  })

  it('fires a bare-resource reactive system even in an entity-less world', () => {
    const Score = defineResource<number>('Score', { default: 0 })
    const w = createWorld() // no entities at all
    let fired = 0
    w.system('react', { schedule: 'reactive', reactsTo: OnChangedResource(Score) }, (ctx) => {
      fired++
      expect(ctx.entities).toEqual([])
    })
    w.setResource(Score, 1)
    w.step()
    expect(fired).toBe(1)
  })

  it('sees a same-tick setResource made by an earlier tick system', () => {
    const Score = defineResource<number>('Score', { default: 0 })
    const w = createWorld()
    let reactFired = 0
    w.system('setter', { schedule: 'tick' }, (ctx) => {
      if (ctx.time.tick === 1) ctx.world.setResource(Score, 9)
    })
    w.system('reactor', { schedule: 'reactive', reactsTo: OnChangedResource(Score) }, () => {
      reactFired++
    })
    w.step() // tick 1: setter runs (step 4) -> reactor (step 6) sees the change
    expect(reactFired).toBe(1)
    w.step() // tick 2: quiet
    expect(reactFired).toBe(1)
  })

  it('scopes to entity predicates when composed with And(Has(...))', () => {
    const Hud = defineComponent<{ on: boolean }>('Hud', { defaults: { on: true } })
    const Score = defineResource<number>('Score', { default: 0 })
    const w = createWorld()
    const hud = w.spawn([entry(Hud, { on: true })])
    let seen: number[] = []
    let fired = 0
    w.system(
      'hudReact',
      { schedule: 'reactive', reactsTo: And(Has(Hud), OnChangedResource(Score)) },
      (ctx) => {
        fired++
        seen = ctx.entities.map((e) => e.id)
      },
    )
    w.step() // quiet
    expect(fired).toBe(0)
    w.setResource(Score, 5)
    w.step() // fires over Hud entities
    expect(fired).toBe(1)
    expect(seen).toEqual([hud])
  })

  it('markResourceChanged fires the reactive gate without a value change', () => {
    const Cfg = defineResource<{ v: number }>('Cfg', { default: { v: 1 } })
    const w = createWorld()
    let fired = 0
    w.system('react', { schedule: 'reactive', reactsTo: OnChangedResource(Cfg) }, () => {
      fired++
    })
    w.resource(Cfg)!.v = 2 // mutate in place
    w.markResourceChanged(Cfg) // between ticks -> pending
    w.step()
    expect(fired).toBe(1)
  })
})

describe('ChangedResource — live query (review #16)', () => {
  it('a live query with ChangedResource reflects the changed tick then clears', () => {
    const Hud = defineComponent<{ on: boolean }>('Hud', { defaults: { on: true } })
    const Score = defineResource<number>('Score', { default: 0 })
    const w = createWorld()
    w.spawn([entry(Hud, { on: true })])
    const q = w.query(And(Has(Hud), OnChangedResource(Score)))
    w.setResource(Score, 1)
    w.step() // change drained into this tick's delta
    expect(q.size).toBe(1)
    w.step() // delta cleared at step 0
    expect(q.size).toBe(0)
    q.dispose()
  })

  it('one-shot selectors reject ChangedResource (it is per-tick reactive)', () => {
    const Score = defineResource<number>('Score', { default: 0 })
    const w = createWorld()
    expect(() => w.count(OnChangedResource(Score))).toThrow(/one-shot|reactive/i)
    expect(() => w.entitiesMatching(OnChangedResource(Score))).toThrow(/one-shot|reactive/i)
    expect(() => w.select(OnChangedResource(Score))).toThrow(/one-shot|reactive/i)
  })
})

describe('snapshot.resources — round-trip (review #16)', () => {
  it('SNAPSHOT_VERSION is 2', () => {
    expect(SNAPSHOT_VERSION).toBe(2)
  })

  it('snapshot captures set resources and restore rehydrates them', () => {
    const Score = defineResource<number>('Score', { default: 0 })
    const Phase = defineResource<{ name: string }>('Phase', { default: { name: 'init' } })
    const w = createWorld()
    w.setResource(Score, 42)
    w.setResource(Phase, { name: 'combat' })

    const snap = w.snapshot()
    expect(snap.version).toBe(2)
    expect(snap.resources?.Score).toBe(42)
    expect(snap.resources?.Phase).toEqual({ name: 'combat' })

    const w2 = createWorld()
    w2.restore(snap)
    expect(w2.resource(Score)).toBe(42)
    expect(w2.resource(Phase)).toEqual({ name: 'combat' })
  })

  it('deep-clones resource values (post-snapshot mutation does not leak)', () => {
    const Phase = defineResource<{ name: string }>('Phase', { default: { name: 'init' } })
    const w = createWorld()
    w.setResource(Phase, { name: 'a' })
    const snap = w.snapshot()
    w.resource(Phase)!.name = 'b'
    expect((snap.resources!.Phase as { name: string }).name).toBe('a')
  })

  it('omits the resources field for a world that has no resources', () => {
    const w = createWorld()
    const snap = w.snapshot()
    expect(snap.resources).toBeUndefined()
  })

  it('restore clears resources absent from the incoming snapshot', () => {
    const Score = defineResource<number>('Score', { default: 0 })
    const w = createWorld()
    w.setResource(Score, 5)
    const empty = createWorld().snapshot() // no resources
    w.restore(empty)
    expect(w.resource(Score)).toBe(0) // back to default; the 5 is gone
  })
})
