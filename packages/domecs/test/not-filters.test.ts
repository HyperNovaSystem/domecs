import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import { And, Has, Not, OnAdded, Where } from '../src/query.js'
import { entry } from '../src/types.js'
import { createWorld } from '../src/world.js'

const Hp = defineComponent<{ hp: number }>('NfHp', { defaults: { hp: 10 } })
const Tag = defineComponent<{ on: boolean }>('NfTag', { defaults: { on: true } })

// O-74: Not over a per-entity filter negates the filter per entity, the
// same in structural candidate selection as in query.entities.
describe('Not over Where and change filters (O-74)', () => {
  function setup() {
    const w = createWorld({ headless: true })
    const alive = w.spawn([entry(Hp, { hp: 5 }), entry(Tag, { on: true })])
    const dead = w.spawn([entry(Hp, { hp: 0 }), entry(Tag, { on: true })])
    const noHp = w.spawn([entry(Tag, { on: true })])
    return { w, alive, dead, noHp }
  }
  const notAlive = And(Has(Tag), Not(Where(Hp, (v) => v.hp > 0)))

  it('Not(Where(T, p)) matches entities that lack T or whose T fails p', () => {
    const { w, dead, noHp } = setup()
    const q = w.query(notAlive)
    expect(q.entities.map((e) => e.id)).toEqual([dead, noHp])
    expect(w.listEntities(notAlive)).toEqual([dead, noHp])
    expect(w.countEntities(notAlive)).toBe(2)
  })

  it('follows predicate changes on a live query', () => {
    const { w, alive, dead, noHp } = setup()
    const q = w.query(notAlive)
    w.getComponent(alive, Hp)!.hp = 0
    w.markChanged(alive, Hp)
    expect(q.entities.map((e) => e.id)).toEqual([alive, dead, noHp])
  })

  it('Not(OnAdded(T)) matches holders of T not added in the window', () => {
    const { w, alive, dead, noHp } = setup()
    const seen: number[][] = []
    w.system('s', { schedule: 'tick', query: And(Has(Tag), Not(OnAdded(Hp))) }, (ctx) => {
      seen.push(ctx.entities.map((e) => e.id))
    })
    w.stepOnce() // the system's first window covers the spawns
    w.stepOnce()
    expect(seen).toEqual([[noHp], [alive, dead, noHp]])
  })
})
