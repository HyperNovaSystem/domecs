import { afterEach, describe, expect, it } from 'vitest'
import { createWorld, isOk } from '@domecs/core'
import { createInputPlugin } from '../src/index.js'

// O-59 (I6): focus classification and pointer deltas.
describe('@domecs/input — details (O-59)', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  function focusOf(html: string): boolean {
    document.body.innerHTML = html
    const el = document.body.firstElementChild as HTMLElement
    el.tabIndex = 0
    el.focus()
    const w = createWorld()
    const r = w.use(createInputPlugin({ pollGamepads: false }))
    if (!isOk(r)) throw new Error('install failed')
    w.step(1 / 60)
    const consumes = w.input.focus.consumesKeys
    r.value() // teardown resets world.input
    return consumes
  }

  it('treats typing fields as text input and toggles/sliders as not', () => {
    expect(focusOf('<input type="text">')).toBe(true)
    expect(focusOf('<input>')).toBe(true)
    expect(focusOf('<textarea></textarea>')).toBe(true)
    expect(focusOf('<div contenteditable=""></div>')).toBe(true)
    expect(focusOf('<div contenteditable="true"></div>')).toBe(true)
    expect(focusOf('<input type="checkbox">')).toBe(false)
    expect(focusOf('<input type="range">')).toBe(false)
    expect(focusOf('<div contenteditable="false"></div>')).toBe(false)
  })

  it('under pointer lock, deltas come from movementX/Y', () => {
    const w = createWorld()
    const r = w.use(createInputPlugin({ pollGamepads: false }))
    if (!isOk(r)) throw new Error('install failed')
    const target = document.createElement('div')
    document.body.appendChild(target)
    Object.defineProperty(document, 'pointerLockElement', { value: target, configurable: true })
    try {
      const move = new PointerEvent('pointermove', { clientX: 50, clientY: 50, bubbles: true })
      Object.defineProperty(move, 'movementX', { value: 7 })
      Object.defineProperty(move, 'movementY', { value: -3 })
      document.dispatchEvent(move)
      w.step(1 / 60)
      expect(w.input.pointer.delta).toEqual({ x: 7, y: -3 })
    } finally {
      delete (document as unknown as Record<string, unknown>).pointerLockElement
      r.value()
    }
  })
})
