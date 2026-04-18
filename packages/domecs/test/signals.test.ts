import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import { createWorld } from '../src/world.js'

const Position = defineComponent<{ x: number; y: number }>('Position', {
  defaults: { x: 0, y: 0 },
})

describe('world.signals', () => {
  it('entitySpawned fires on spawn()', () => {
    const w = createWorld()
    const seen: number[] = []
    w.signals.entitySpawned.subscribe((id) => seen.push(id))
    const a = w.spawn()
    const b = w.spawn()
    expect(seen).toEqual([a, b])
  })

  it('entityDespawned fires on despawn()', () => {
    const w = createWorld()
    const seen: number[] = []
    w.signals.entityDespawned.subscribe((id) => seen.push(id))
    const a = w.spawn()
    w.despawn(a)
    expect(seen).toEqual([a])
  })

  it('componentAdded fires on addComponent', () => {
    const w = createWorld()
    const seen: { entity: number; name: string }[] = []
    w.signals.componentAdded.subscribe(({ entity, type }) => {
      seen.push({ entity, name: type.name })
    })
    const e = w.spawn()
    w.addComponent(e, Position, { x: 1, y: 2 })
    expect(seen).toEqual([{ entity: e, name: 'Position' }])
  })

  it('componentRemoved fires before component is dropped (SPEC §2.10)', () => {
    const w = createWorld()
    const readings: unknown[] = []
    w.signals.componentRemoved.subscribe(({ entity, type }) => {
      // SPEC §2.10: subscriber may still read the outgoing value synchronously.
      readings.push(w.getComponent(entity, type))
    })
    const e = w.spawn()
    w.addComponent(e, Position, { x: 7, y: 9 })
    w.removeComponent(e, Position)
    expect(readings).toEqual([{ x: 7, y: 9 }])
  })

  it('componentRemoved fires for each component on despawn', () => {
    const w = createWorld()
    const seen: string[] = []
    w.signals.componentRemoved.subscribe(({ type }) => seen.push(type.name))
    const e = w.spawn()
    w.addComponent(e, Position, { x: 0, y: 0 })
    w.despawn(e)
    expect(seen).toEqual(['Position'])
  })

  it('tickStart / tickEnd fire each step', () => {
    const w = createWorld()
    const order: string[] = []
    w.signals.tickStart.subscribe(() => order.push('start'))
    w.signals.tickEnd.subscribe(() => order.push('end'))
    w.step(0.016)
    w.step(0.016)
    expect(order).toEqual(['start', 'end', 'start', 'end'])
  })

  it('subscribe returns an unsubscribe', () => {
    const w = createWorld()
    let count = 0
    const off = w.signals.entitySpawned.subscribe(() => count++)
    w.spawn()
    off()
    w.spawn()
    expect(count).toBe(1)
  })

  it('throws from subscriber propagate to emitter', () => {
    const w = createWorld()
    w.signals.entitySpawned.subscribe(() => {
      throw new Error('boom')
    })
    expect(() => w.spawn()).toThrowError('boom')
  })
})
