import { describe, expect, it } from 'vitest'
import { createWorld, isOk } from '@domecs/core'
import { createInputPlugin } from '../src/collector.js'

// O-57: a heartbeat (step(0)) runs plugin hooks but no systems, so it must
// not consume the edges and deltas systems read once per tick.
describe('@domecs/input — heartbeat keeps edges (O-57)', () => {
  it('a key press and pointer deltas made before a heartbeat reach the next tick', () => {
    const world = createWorld()
    const r = world.use(createInputPlugin({ pollGamepads: false }))
    if (!isOk(r)) throw new Error('install failed')
    const seen: Array<{ pressed: string[]; dx: number; wheel: number }> = []
    world.system('read', { schedule: 'tick' }, ({ world: w }) => {
      seen.push({
        pressed: [...w.input.keyDelta.pressed],
        dx: w.input.pointer.delta.x,
        wheel: w.input.pointer.wheel,
      })
    })
    world.step(1 / 60)

    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', key: 'j', bubbles: true }))
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 5, clientY: 0, bubbles: true }))
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 12, clientY: 0, bubbles: true }))
    document.dispatchEvent(new WheelEvent('wheel', { deltaY: 3, bubbles: true }))

    world.step(0)
    // The heartbeat publishes held state but no edges, so a tickStart
    // hotkey cannot see the press twice...
    expect(world.input.keys.has('KeyJ')).toBe(true)
    expect(world.input.keyDelta.pressed.size).toBe(0)
    expect(world.input.pointer.wheel).toBe(0)
    world.step(0)

    world.step(1 / 60)
    // ...and the next real tick still sees the edge and the deltas, once.
    expect(seen.at(-1)).toMatchObject({ pressed: ['KeyJ'], wheel: 3 })
    expect(seen.at(-1)!.dx).toBeGreaterThan(0)
    world.step(1 / 60)
    expect(seen.at(-1)).toEqual({ pressed: [], dx: 0, wheel: 0 })
  })
})
