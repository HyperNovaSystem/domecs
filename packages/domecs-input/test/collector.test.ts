import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWorld } from 'domecs'
import { createInputPlugin } from '../src/collector.js'

function kbd(type: 'keydown' | 'keyup', code: string, opts: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent(type, { code, key: code, bubbles: true, ...opts })
}

describe('domecs-input collector', () => {
  let originalGetGamepads: typeof navigator.getGamepads | undefined

  beforeEach(() => {
    originalGetGamepads = (navigator as any).getGamepads
    // Clear any residual getGamepads between tests by default.
    ;(navigator as any).getGamepads = undefined
  })

  afterEach(() => {
    ;(navigator as any).getGamepads = originalGetGamepads
  })

  it('publishes empty snapshot before any events', () => {
    const world = createWorld()
    const dispose = world.use(createInputPlugin({ pollGamepads: false }))
    world.step(1 / 60)
    expect(world.input.keys.size).toBe(0)
    expect(world.input.keyDelta.pressed.size).toBe(0)
    expect(world.input.keyDelta.released.size).toBe(0)
    dispose()
  })

  it('records pressed on keydown and clears on subsequent tick', () => {
    const world = createWorld()
    world.use(createInputPlugin({ pollGamepads: false }))

    document.dispatchEvent(kbd('keydown', 'KeyW'))
    world.step(1 / 60)
    expect(world.input.keys.has('KeyW')).toBe(true)
    expect(world.input.keyDelta.pressed.has('KeyW')).toBe(true)
    expect(world.input.keyDelta.released.has('KeyW')).toBe(false)

    world.step(1 / 60)
    expect(world.input.keys.has('KeyW')).toBe(true)
    expect(world.input.keyDelta.pressed.size).toBe(0)
  })

  it('records released on keyup', () => {
    const world = createWorld()
    world.use(createInputPlugin({ pollGamepads: false }))

    document.dispatchEvent(kbd('keydown', 'Space'))
    world.step(1 / 60)
    document.dispatchEvent(kbd('keyup', 'Space'))
    world.step(1 / 60)
    expect(world.input.keys.has('Space')).toBe(false)
    expect(world.input.keyDelta.released.has('Space')).toBe(true)
  })

  it('tracks modifier keys', () => {
    const world = createWorld()
    world.use(createInputPlugin({ pollGamepads: false }))
    document.dispatchEvent(kbd('keydown', 'KeyA', { ctrlKey: true, shiftKey: true }))
    world.step(1 / 60)
    expect(world.input.mods.ctrl).toBe(true)
    expect(world.input.mods.shift).toBe(true)
    expect(world.input.mods.alt).toBe(false)
    expect(world.input.mods.meta).toBe(false)
  })

  it('clears held on blur when clearOnBlur=true (default)', () => {
    const world = createWorld()
    world.use(createInputPlugin({ pollGamepads: false }))
    document.dispatchEvent(kbd('keydown', 'KeyA'))
    document.dispatchEvent(kbd('keydown', 'KeyB'))
    world.step(1 / 60)
    expect(world.input.keys.size).toBe(2)

    window.dispatchEvent(new Event('blur'))
    world.step(1 / 60)
    expect(world.input.keys.size).toBe(0)
    expect(world.input.keyDelta.released.has('KeyA')).toBe(true)
    expect(world.input.keyDelta.released.has('KeyB')).toBe(true)
  })

  it('does not clear held on blur when clearOnBlur=false', () => {
    const world = createWorld()
    world.use(createInputPlugin({ clearOnBlur: false, pollGamepads: false }))
    document.dispatchEvent(kbd('keydown', 'KeyQ'))
    world.step(1 / 60)
    window.dispatchEvent(new Event('blur'))
    world.step(1 / 60)
    expect(world.input.keys.has('KeyQ')).toBe(true)
  })

  it('ignores repeat keydowns (no duplicate pressed)', () => {
    const world = createWorld()
    world.use(createInputPlugin({ pollGamepads: false }))
    document.dispatchEvent(kbd('keydown', 'KeyR'))
    document.dispatchEvent(kbd('keydown', 'KeyR', { repeat: true }))
    world.step(1 / 60)
    expect(world.input.keys.size).toBe(1)
    expect(world.input.keyDelta.pressed.size).toBe(1)
  })

  it('accumulates pointer delta and resets per tick', () => {
    const world = createWorld()
    world.use(createInputPlugin({ pollGamepads: false }))

    document.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 10, clientY: 20, bubbles: true }),
    )
    document.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 15, clientY: 25, bubbles: true }),
    )
    world.step(1 / 60)
    expect(world.input.pointer.x).toBe(15)
    expect(world.input.pointer.y).toBe(25)
    expect(world.input.pointer.delta.x).toBe(15)
    expect(world.input.pointer.delta.y).toBe(25)

    world.step(1 / 60)
    expect(world.input.pointer.delta.x).toBe(0)
    expect(world.input.pointer.delta.y).toBe(0)
  })

  it('accumulates wheel delta', () => {
    const world = createWorld()
    world.use(createInputPlugin({ pollGamepads: false }))
    document.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }))
    document.dispatchEvent(new WheelEvent('wheel', { deltaY: 50, bubbles: true }))
    world.step(1 / 60)
    expect(world.input.pointer.wheel).toBe(150)
    world.step(1 / 60)
    expect(world.input.pointer.wheel).toBe(0)
  })

  it('detects text-input focus via default selector', () => {
    const world = createWorld()
    world.use(createInputPlugin({ pollGamepads: false }))
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    ta.focus()
    world.step(1 / 60)
    expect(world.input.focus.consumesKeys).toBe(true)
    expect(world.input.focus.activeTag).toBe('textarea')
    ta.remove()
  })

  it('teardown removes listeners', () => {
    const world = createWorld()
    const dispose = world.use(createInputPlugin({ pollGamepads: false }))
    dispose()
    document.dispatchEvent(kbd('keydown', 'KeyZ'))
    world.step(1 / 60)
    expect(world.input.keys.has('KeyZ')).toBe(false)
  })

  it('polls gamepads when available', () => {
    ;(navigator as any).getGamepads = () => [
      {
        index: 0,
        axes: [0.5, -0.25],
        buttons: [{ pressed: true, value: 1 }, { pressed: false, value: 0 }],
      },
      null,
    ]
    const world = createWorld()
    world.use(createInputPlugin())
    world.step(1 / 60)
    expect(world.input.gamepads.length).toBe(1)
    const g = world.input.gamepads[0]!
    expect(g.index).toBe(0)
    expect(g.axes).toEqual([0.5, -0.25])
    expect(g.buttons[0]!.pressed).toBe(true)
  })
})
