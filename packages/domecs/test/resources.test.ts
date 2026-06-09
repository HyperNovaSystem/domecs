import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import { defineResource } from '../src/resource.js'
import { And, OnChangedResource, Has } from '../src/query.js'
import { SNAPSHOT_VERSION } from '../src/snapshot.js'
import { entry } from '../src/types.js'
import { createWorld } from '../src/world.js'

describe('defineResource + world.getResource/setResource (review #16)', () => {
  it('getResource() returns the declared default (lazily materialized)', () => {
    const Count = defineResource<number>('Count', { default: 7 })
    const w = createWorld()
    expect(w.getResource(Count)).toBe(7)
  })

  it('getResource() returns undefined when no default is declared', () => {
    const Opt = defineResource<number>('Opt')
    const w = createWorld()
    expect(w.getResource(Opt)).toBeUndefined()
  })

  it('setResource then getResource() returns the stored value', () => {
    const Score = defineResource<number>('Score', { default: 0 })
    const w = createWorld()
    w.setResource(Score, 42)
    expect(w.getResource(Score)).toBe(42)
  })

  it('a function default is treated as a per-world factory (no cross-world sharing)', () => {
    const List = defineResource<number[]>('List', { default: () => [] })
    const w1 = createWorld()
    const w2 = createWorld()
    w1.getResource(List)!.push(1)
    expect(w1.getResource(List)).toEqual([1])
    expect(w2.getResource(List)).toEqual([])
  })

  it('a returned resource object is the live, mutable singleton', () => {
    const Cfg = defineResource<{ v: number }>('Cfg', { default: { v: 1 } })
    const w = createWorld()
    w.getResource(Cfg)!.v = 9
    expect(w.getResource(Cfg)!.v).toBe(9)
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
    w.stepOnce() // quiet tick
    expect(fired).toBe(0)
    w.setResource(Score, 10) // between ticks -> pending
    w.stepOnce() // promoted at step 0 -> reactive fires
    expect(fired).toBe(1)
    w.stepOnce() // quiet again
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
    w.stepOnce()
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
    w.stepOnce() // tick 1: setter runs (step 4) -> reactor (step 6) sees the change
    expect(reactFired).toBe(1)
    w.stepOnce() // tick 2: quiet
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
    w.stepOnce() // quiet
    expect(fired).toBe(0)
    w.setResource(Score, 5)
    w.stepOnce() // fires over Hud entities
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
    w.getResource(Cfg)!.v = 2 // mutate in place
    w.markResourceChanged(Cfg) // between ticks -> pending
    w.stepOnce()
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
    w.stepOnce() // change drained into this tick's delta
    expect(q.size).toBe(1)
    w.stepOnce() // delta cleared at step 0
    expect(q.size).toBe(0)
    q.dispose()
  })

  it('one-shot selectors reject ChangedResource (it is per-tick reactive)', () => {
    const Score = defineResource<number>('Score', { default: 0 })
    const w = createWorld()
    // Temporal OnChangedResource is rejected at compile time by OneShotQueryDef;
    // the `as never` casts exercise the surviving runtime guard for untyped JS callers.
    // @ts-expect-error temporal On* nodes are illegal in one-shot selectors
    void (() => w.countEntities(OnChangedResource(Score)))
    // @ts-expect-error temporal On* nodes are illegal in one-shot selectors
    void (() => w.listEntities(OnChangedResource(Score)))
    // @ts-expect-error temporal On* nodes are illegal in one-shot selectors
    void (() => w.selectViews(OnChangedResource(Score)))
    expect(() => w.countEntities(OnChangedResource(Score) as never)).toThrow(/one-shot|reactive/i)
    expect(() => w.listEntities(OnChangedResource(Score) as never)).toThrow(/one-shot|reactive/i)
    expect(() => w.selectViews(OnChangedResource(Score) as never)).toThrow(/one-shot|reactive/i)
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
    expect(w2.getResource(Score)).toBe(42)
    expect(w2.getResource(Phase)).toEqual({ name: 'combat' })
  })

  it('deep-clones resource values (post-snapshot mutation does not leak)', () => {
    const Phase = defineResource<{ name: string }>('Phase', { default: { name: 'init' } })
    const w = createWorld()
    w.setResource(Phase, { name: 'a' })
    const snap = w.snapshot()
    w.getResource(Phase)!.name = 'b'
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
    expect(w.getResource(Score)).toBe(0) // back to default; the 5 is gone
  })
})

describe('restore() validates registered resources (O-18)', () => {
  it('throws on an invalid resource value and leaves the world untouched', () => {
    const Hp = defineResource<number>('HpRestoreO18', {
      default: 10,
      validate: (v) => (v >= 0 ? true : 'must be >= 0'),
    })
    const w = createWorld()
    w.setResource(Hp, 5)
    const evil = JSON.parse(JSON.stringify(w.snapshot())) as ReturnType<typeof w.snapshot>
    ;(evil.resources as Record<string, unknown>).HpRestoreO18 = -1
    expect(() => w.restore(evil)).toThrow(/invalid resource "HpRestoreO18".*must be >= 0/)
    // the throw happened before any state was wiped
    expect(w.getResource(Hp)).toBe(5)
  })

  it('accepts valid values and passes unregistered names through untouched', () => {
    const Hp = defineResource<number>('HpRestoreO18b', {
      default: 10,
      validate: (v) => (v >= 0 ? true : 'must be >= 0'),
    })
    const w = createWorld()
    w.setResource(Hp, 5)
    const snap = JSON.parse(JSON.stringify(w.snapshot())) as ReturnType<typeof w.snapshot>
    ;(snap.resources as Record<string, unknown>).NeverRegisteredO18 = { weird: true }
    expect(() => w.restore(snap)).not.toThrow()
    expect(w.getResource(Hp)).toBe(5)
  })
})
