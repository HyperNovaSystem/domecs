import { afterEach, describe, expect, it } from 'vitest'
import { createWorld, type World } from '@domecs/core'
import { createInputPlugin, INTERACTIVE_SELECTOR } from '../src/collector.js'

// H-1 (Harbor findings): a key pressed and released between two ticks was
// published as a release with no press, so edge-triggered handlers never
// fired — every Playwright `keyboard.press` and every tap during a long frame.
// H-2: preventDefaultKeys blocked Ctrl/Cmd shortcuts and keyboard activation
// of a focused button.

function kbd(type: 'keydown' | 'keyup', code: string, opts: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true, ...opts })
}

const worlds: Array<() => void> = []
function install(options: Parameters<typeof createInputPlugin>[0] = {}): World {
  const w = createWorld()
  const r = w.use(createInputPlugin({ pollGamepads: false, ...options }))
  if (!r.ok) throw new Error('install failed')
  worlds.push(r.value)
  return w
}
afterEach(() => {
  for (const off of worlds.splice(0)) off()
  document.body.innerHTML = ''
})

describe('a tap inside one frame (H-1)', () => {
  it('publishes both edges, and the key is not held', () => {
    const w = install()
    document.dispatchEvent(kbd('keydown', 'Space'))
    document.dispatchEvent(kbd('keyup', 'Space'))
    w.step(1 / 60)
    expect([...w.input.keyDelta.pressed]).toEqual(['Space'])
    expect([...w.input.keyDelta.released]).toEqual(['Space'])
    expect(w.input.keys.has('Space')).toBe(false)
    w.step(1 / 60)
    expect(w.input.keyDelta.pressed.size).toBe(0)
    expect(w.input.keyDelta.released.size).toBe(0)
  })

  it('a tap then a press in one frame is a press of a held key', () => {
    const w = install()
    for (const t of ['keydown', 'keyup', 'keydown'] as const) document.dispatchEvent(kbd(t, 'KeyA'))
    w.step(1 / 60)
    expect(w.input.keyDelta.pressed.has('KeyA')).toBe(true)
    expect(w.input.keyDelta.released.has('KeyA')).toBe(false)
    expect(w.input.keys.has('KeyA')).toBe(true)
  })
})

describe('preventDefaultKeys leaves the browser its keys (H-2)', () => {
  it('true: game keys only — never with Ctrl, Meta or Alt held', () => {
    install({ preventDefaultKeys: true })
    const plain = kbd('keydown', 'KeyR')
    document.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(true)
    document.dispatchEvent(kbd('keyup', 'KeyR'))
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      const e = kbd('keydown', 'KeyR', { [mod]: true })
      document.dispatchEvent(e)
      expect({ mod, prevented: e.defaultPrevented }).toEqual({ mod, prevented: false })
      document.dispatchEvent(kbd('keyup', 'KeyR'))
    }
    const shifted = kbd('keydown', 'KeyR', { shiftKey: true })
    document.dispatchEvent(shifted)
    expect(shifted.defaultPrevented).toBe(true)
  })

  it('true: a focused button, link or slider keeps its keys; the game still sees them', () => {
    const w = install({ preventDefaultKeys: true })
    document.body.innerHTML = '<button id="b">Buy</button><a id="a" href="#x">Go</a><input id="r" type="range">'
    for (const [id, code] of [['b', 'Space'], ['b', 'Enter'], ['a', 'Enter'], ['r', 'ArrowLeft']] as const) {
      const el = document.getElementById(id)!
      el.focus()
      const e = kbd('keydown', code)
      el.dispatchEvent(e)
      expect({ id, code, prevented: e.defaultPrevented }).toEqual({ id, code, prevented: false })
      w.step(1 / 60)
      expect(w.input.keyDelta.pressed.has(code)).toBe(true)
      el.dispatchEvent(kbd('keyup', code))
      w.step(1 / 60)
    }
    expect(INTERACTIVE_SELECTOR).toContain('button')
  })

  it('a list of codes: only those, under the same rules', () => {
    install({ preventDefaultKeys: ['Space', 'ArrowUp'] })
    const space = kbd('keydown', 'Space')
    const letter = kbd('keydown', 'KeyW')
    document.dispatchEvent(space)
    document.dispatchEvent(letter)
    expect([space.defaultPrevented, letter.defaultPrevented]).toEqual([true, false])
    const ctrlSpace = kbd('keydown', 'ArrowUp', { ctrlKey: true })
    document.dispatchEvent(ctrlSpace)
    expect(ctrlSpace.defaultPrevented).toBe(false)
  })

  it('a function decides alone', () => {
    const seen: string[] = []
    install({ preventDefaultKeys: (e) => (seen.push(e.code), e.code === 'KeyQ' && e.ctrlKey) })
    const q = kbd('keydown', 'KeyQ', { ctrlKey: true })
    document.dispatchEvent(q)
    expect(q.defaultPrevented).toBe(true)
    expect(seen).toEqual(['KeyQ'])
  })

  it('rejects anything else at install', () => {
    const w = createWorld()
    const r = w.use(createInputPlugin({ pollGamepads: false, preventDefaultKeys: 'yes' as never }))
    expect(r.ok).toBe(false)
  })
})
