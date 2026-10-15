import { afterEach, describe, expect, it } from 'vitest'
import { createWorld, type DomecsError, type Result } from '@domecs/core'
import { createInputPlugin } from '../src/collector.js'

// O-56 / O-58 / O-59 (2026-10-13 engine review I1, I3, I4): held keys and
// pointer buttons must not stick, and teardown must not leave input live.

function kbd(type: 'keydown' | 'keyup', code: string): KeyboardEvent {
  return new KeyboardEvent(type, { code, key: code, bubbles: true })
}

function unuse(r: Result<() => void, DomecsError>): () => void {
  if (!r.ok) throw new Error(`install failed: ${JSON.stringify(r.error)}`)
  return r.value
}

describe('@domecs/input — stuck input', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('O-56: a key released while a textarea has focus is released', () => {
    const world = createWorld()
    const dispose = unuse(world.use(createInputPlugin({ pollGamepads: false })))
    document.dispatchEvent(kbd('keydown', 'KeyW'))
    world.step(1 / 60)
    expect(world.input.keys.has('KeyW')).toBe(true)

    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    ta.focus()
    ta.dispatchEvent(kbd('keyup', 'KeyW'))
    world.step(1 / 60)
    expect(world.input.keys.has('KeyW')).toBe(false)
    expect(world.input.keyDelta.released.has('KeyW')).toBe(true)

    // Typing in the textarea still passes through.
    ta.dispatchEvent(kbd('keydown', 'KeyA'))
    world.step(1 / 60)
    expect(world.input.keys.has('KeyA')).toBe(false)

    // The next press back in the game has an edge.
    ta.blur()
    document.dispatchEvent(kbd('keydown', 'KeyW'))
    world.step(1 / 60)
    expect(world.input.keyDelta.pressed.has('KeyW')).toBe(true)
    dispose()
  })

  it('O-56: an element keyTarget releases held keys when focus leaves it', () => {
    const game = document.createElement('div')
    game.tabIndex = 0
    const inside = document.createElement('button')
    game.appendChild(inside)
    const outside = document.createElement('button')
    document.body.append(game, outside)

    const world = createWorld()
    const dispose = unuse(world.use(createInputPlugin({ keyTarget: game, pollGamepads: false })))
    game.focus()
    game.dispatchEvent(kbd('keydown', 'ArrowLeft'))
    world.step(1 / 60)
    expect(world.input.keys.has('ArrowLeft')).toBe(true)

    inside.focus() // focus stays within the key target: still held
    world.step(1 / 60)
    expect(world.input.keys.has('ArrowLeft')).toBe(true)

    outside.focus()
    world.step(1 / 60)
    expect(world.input.keys.has('ArrowLeft')).toBe(false)
    expect(world.input.keyDelta.released.has('ArrowLeft')).toBe(true)
    dispose()
  })

  it('O-59: pointercancel and window blur clear pointer buttons', () => {
    const world = createWorld()
    const dispose = unuse(world.use(createInputPlugin({ pollGamepads: false })))
    const down = (): void =>
      void document.dispatchEvent(new PointerEvent('pointerdown', { buttons: 1, bubbles: true }))
    down()
    world.step(1 / 60)
    expect(world.input.pointer.buttons).toBe(1)
    document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }))
    world.step(1 / 60)
    expect(world.input.pointer.buttons).toBe(0)

    down()
    world.step(1 / 60)
    window.dispatchEvent(new Event('blur'))
    world.step(1 / 60)
    expect(world.input.pointer.buttons).toBe(0)
    dispose()
  })

  it('O-58: teardown resets world.input', () => {
    const world = createWorld()
    const dispose = unuse(world.use(createInputPlugin({ pollGamepads: false })))
    document.dispatchEvent(kbd('keydown', 'Space'))
    world.step(1 / 60)
    expect(world.input.keyDelta.pressed.has('Space')).toBe(true)
    dispose()
    let presses = 0
    world.system('jump', { schedule: 'tick' }, ({ input }) => {
      if (input.keyDelta.pressed.has('Space')) presses++
    })
    for (let i = 0; i < 5; i++) world.step(1 / 60)
    expect(presses).toBe(0)
    expect(world.input.keys.size).toBe(0)
  })
})

describe('@domecs/input — review follow-ups', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('focus leaving an element keyTarget keeps a held pointer button', () => {
    const game = document.createElement('div')
    game.tabIndex = 0
    const hud = document.createElement('button')
    document.body.append(game, hud)
    const world = createWorld()
    const dispose = unuse(world.use(createInputPlugin({ keyTarget: game, pollGamepads: false })))
    game.focus()
    hud.dispatchEvent(new PointerEvent('pointerdown', { buttons: 1, bubbles: true }))
    hud.focus()
    world.step(1 / 60)
    expect(world.input.pointer.buttons).toBe(1)
    dispose()
  })

  it('lostpointercapture keeps buttons that are still held', () => {
    const world = createWorld()
    const dispose = unuse(world.use(createInputPlugin({ pollGamepads: false })))
    document.dispatchEvent(new PointerEvent('pointerdown', { buttons: 1, bubbles: true }))
    document.dispatchEvent(new PointerEvent('lostpointercapture', { buttons: 1, bubbles: true }))
    world.step(1 / 60)
    expect(world.input.pointer.buttons).toBe(1)
    dispose()
  })
})
