import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Has, createWorld, defineComponent, entry, isOk } from '@domecs/core'
import { defineView, mountDOM } from '../src/index.js'

const Glyph = defineComponent<{ ch: string }>('RrGlyph')

// O-48: restore() under an idle startLoop repaints the restored state with a
// heartbeat frame, and does not tick the world past the checkpoint.
describe('mountDOM — restore under an idle startLoop (O-48)', () => {
  let stage: HTMLElement
  let frames: Array<(t: number) => void> = []
  let clock = 0
  const g = globalThis as unknown as {
    requestAnimationFrame: (cb: (t: number) => void) => number
    cancelAnimationFrame: (h: number) => void
  }
  const prevRaf = g.requestAnimationFrame
  const prevCaf = g.cancelAnimationFrame

  function advance(n: number): void {
    for (let i = 0; i < n; i++) {
      clock += 16
      const due = frames
      frames = []
      for (const cb of due) cb(clock)
    }
  }

  beforeEach(() => {
    document.body.innerHTML = ''
    stage = document.createElement('div')
    document.body.appendChild(stage)
    frames = []
    g.requestAnimationFrame = (cb) => frames.push(cb)
    g.cancelAnimationFrame = () => {}
  })

  afterEach(() => {
    g.requestAnimationFrame = prevRaf
    g.cancelAnimationFrame = prevCaf
  })

  for (const paused of [false, true]) {
    it(`paints the checkpoint${paused ? ' while paused' : ''}`, () => {
      const world = createWorld()
      const r = mountDOM(world, {
        slots: { stage },
        views: [
          defineView({
            slot: 'stage',
            query: Has(Glyph),
            create: () => document.createElement('span'),
            update: (el, e) => {
              el.textContent = (e as unknown as { RrGlyph: { ch: string } }).RrGlyph.ch
            },
          }),
        ],
      })
      expect(isOk(r)).toBe(true)
      const id = world.spawn([entry(Glyph, { ch: 'a' })])
      world.startLoop()
      advance(3)
      expect(stage.textContent).toBe('a')
      const snap = world.snapshot()

      world.getComponent(id, Glyph)!.ch = 'b'
      world.markChanged(id, Glyph)
      advance(3)
      expect(stage.textContent).toBe('b')
      if (paused) {
        world.pause()
        advance(3)
      }

      world.restore(snap)
      advance(3)
      expect(stage.textContent).toBe('a')
      expect(world.time.tick).toBe(snap.tick)
      world.stop()
    })
  }
})
