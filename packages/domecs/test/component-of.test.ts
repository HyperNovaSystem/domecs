import { describe, expect, expectTypeOf, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import { defineResource } from '../src/resource.js'
import { entry } from '../src/types.js'
import { createWorld } from '../src/world.js'

// P-3 (Harbor findings): `defineComponent<T, 'Name'>('Name')` states the name
// twice to keep it as a literal type, which typed tuple queries need.
// `defineComponent.of<T>()('Name', …)` states it once, with an explicit T.

interface ShipData {
  name: string
  hold: number[]
}

describe('a typed component that states its name once (P-3)', () => {
  it('defineComponent.of<T>() keeps the literal name and the explicit type', () => {
    const Ship = defineComponent.of<ShipData>()('PcShip', { defaults: { name: '', hold: [] } })
    expectTypeOf(Ship.name).toEqualTypeOf<'PcShip'>()
    const w = createWorld({ headless: true })
    w.spawn([entry(Ship, { name: 'Ada', hold: [1] })])
    const view = w.query([Ship] as const).entities[0]!
    expectTypeOf(view.PcShip.name).toEqualTypeOf<string>() // typed: no `!`, no cast
    expect(view.PcShip.hold).toEqual([1])
    expect(Ship.create().hold).toEqual([])
  })

  it('without type arguments the type and the literal name are inferred from defaults', () => {
    const Tug = defineComponent('PcTug', { defaults: { power: 3, moored: false } })
    expectTypeOf(Tug.name).toEqualTypeOf<'PcTug'>()
    const w = createWorld({ headless: true })
    w.spawn([entry(Tug, { power: 5, moored: true })])
    expectTypeOf(w.query([Tug] as const).entities[0]!.PcTug.power).toEqualTypeOf<number>()
  })

  it('defineResource.of<T>() does the same for resources', () => {
    const Cash = defineResource.of<number>()('PcCash', { default: 10 })
    expectTypeOf(Cash.name).toEqualTypeOf<'PcCash'>()
    expect(createWorld({ headless: true }).getResource(Cash)).toBe(10)
  })
})
