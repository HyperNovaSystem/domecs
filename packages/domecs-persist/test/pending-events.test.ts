import { createWorld, defineComponent, defineEvent, entry, hashSnapshot, type World } from '@domecs/core'
import { describe, expect, it } from 'vitest'
import { columnarCodec } from '../src/codecs.js'
import { load, save } from '../src/persist.js'
import { createMemoryStorage } from '../src/storage.js'

// H-19 (Harbor 3.0 findings): save() took world.snapshot() without the
// events in flight, so an event emitted in fixed step k — handled by a fixed
// event system in step k + 1 — was lost by a save between the two steps.

const Order = defineEvent<{ n: number }>('PeOrder')
const Count = defineComponent<{ n: number }>('PeCount', { defaults: { n: 0 } })
const STEP = 1 / 16

function build(): { w: World; id: number } {
  const w = createWorld({ headless: true, fixedStep: STEP })
  w.register(Order, Count)
  let emitted = false
  w.system('emit', { schedule: 'fixed' }, (ctx) => {
    if (!emitted && ctx.time.fixedTick === 1) {
      emitted = true
      ctx.events.emit(Order, { n: 1 })
    }
  })
  w.system('works', { schedule: 'event', fixed: true, triggers: [Order] }, (ctx) => {
    for (const { n } of ctx.events.of(Order)) {
      const c = ctx.world.getComponent(0, Count)!
      c.n += n
      ctx.world.markChanged(0, Count)
    }
  })
  const id = w.spawn([entry(Count, { n: 0 })])
  return { w, id }
}

describe('H-19: save() keeps events not delivered yet', () => {
  for (const codec of [undefined, columnarCodec]) {
    it(`a fixed event in flight survives a save and load (${codec?.name ?? 'json'})`, () => {
      const storage = createMemoryStorage()
      const live = build()
      live.w.step(STEP) // emitted in step 1, not yet delivered
      expect(save(live.w, storage, 's', { savedAt: 0, ...(codec ? { codec } : {}) }).ok).toBe(true)
      const twin = build()
      // The twin's own emitter has already fired in the saved world.
      twin.w.step(STEP)
      const loaded = load(twin.w, storage, 's')
      expect(loaded.ok).toBe(true)
      live.w.step(STEP)
      twin.w.step(STEP)
      expect(live.w.getComponent(live.id, Count)!.n).toBe(1)
      expect(twin.w.getComponent(twin.id, Count)!.n).toBe(1)
      expect(hashSnapshot(twin.w.snapshot())).toBe(hashSnapshot(live.w.snapshot()))
    })
  }

  it('pendingEvents: false writes the snapshot without them, as 3.0 did', () => {
    const storage = createMemoryStorage()
    const live = build()
    live.w.step(STEP)
    expect(save(live.w, storage, 's', { pendingEvents: false }).ok).toBe(true)
    const twin = build()
    twin.w.step(STEP)
    expect(load(twin.w, storage, 's').ok).toBe(true)
    twin.w.step(STEP)
    expect(twin.w.getComponent(twin.id, Count)!.n).toBe(0)
  })

  it('a pending payload that is not plain data is a persist_io error, and the slot is untouched', () => {
    const storage = createMemoryStorage({ s: 'before' })
    const Odd = defineEvent<{ f: () => void }>('PeOdd')
    const w = createWorld({ headless: true })
    w.register(Odd)
    w.emit(Odd, { f: () => {} })
    const r = save(w, storage, 's')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('persist_io')
      expect(String((r.error as { cause: { message: string } }).cause.message)).toMatch(/PeOdd/)
    }
    expect(storage.read('s')).toEqual({ ok: true, value: 'before' })
    expect(save(w, storage, 's', { pendingEvents: false }).ok).toBe(true)
  })
})
