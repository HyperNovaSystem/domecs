import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import { Has } from '../src/query.js'
import { ok } from '../src/result.js'
import { entry } from '../src/types.js'
import { createWorld } from '../src/world.js'

const Position = defineComponent<{ x: number; y: number }>('Position', {
  defaults: { x: 0, y: 0 },
})
const Velocity = defineComponent<{ dx: number; dy: number }>('Velocity', {
  defaults: { dx: 0, dy: 0 },
})
const Ephemeral = defineComponent<{ tag: string }>('Ephemeral', { transient: true })

describe('snapshot — shape (SPEC §7.1)', () => {
  it('captures version, seed, tick, and entities', () => {
    const w = createWorld({ seed: 0xc0ffee })
    w.spawn([entry(Position, { x: 1, y: 2 })])
    w.step(0.016)
    const snap = w.snapshot()
    expect(typeof snap.version).toBe('number')
    expect(snap.version).toBeGreaterThanOrEqual(1)
    expect(snap.seed).toHaveLength(4)
    expect(snap.tick).toBe(1)
    expect(snap.entities).toHaveLength(1)
    expect(snap.entities[0]?.components.Position).toEqual({ x: 1, y: 2 })
  })

  it('excludes transient components', () => {
    const w = createWorld()
    const e = w.spawn([
      entry(Position, { x: 1, y: 2 }),
      entry(Ephemeral, { tag: 'temp' }),
    ])
    const snap = w.snapshot()
    const captured = snap.entities.find((r) => r.id === e)!
    expect(captured.components.Position).toEqual({ x: 1, y: 2 })
    expect(captured.components.Ephemeral).toBeUndefined()
  })

  it('deep-clones component values (mutation after snapshot does not leak)', () => {
    const w = createWorld()
    const e = w.spawn([entry(Position, { x: 10, y: 20 })])
    const snap = w.snapshot()
    const pos = w.getComponent(e, Position)!
    pos.x = 999
    expect((snap.entities[0]!.components.Position as { x: number }).x).toBe(10)
  })
})

describe('restore — roundtrip (SPEC §7.1)', () => {
  it('restores entities + components from a snapshot', () => {
    const w = createWorld({ seed: 7 })
    const a = w.spawn([entry(Position, { x: 1, y: 1 })])
    const b = w.spawn([
      entry(Position, { x: 2, y: 2 }),
      entry(Velocity, { dx: 1, dy: 0 }),
    ])
    w.step(0.016)
    w.step(0.016)
    const snap = w.snapshot()

    const w2 = createWorld({ seed: 999 })
    w2.restore(snap)
    expect(w2.time.tick).toBe(2)
    expect(w2.getComponent(a, Position)).toEqual({ x: 1, y: 1 })
    expect(w2.getComponent(b, Position)).toEqual({ x: 2, y: 2 })
    expect(w2.getComponent(b, Velocity)).toEqual({ dx: 1, dy: 0 })
  })

  it('restored world produces the same PRNG sequence as the original from that tick', () => {
    const w = createWorld({ seed: 0xabc })
    w.step(0.016)
    w.step(0.016)
    for (let i = 0; i < 3; i++) w.rand.next()
    const snap = w.snapshot()
    const original = [w.rand.next(), w.rand.next(), w.rand.next()]

    const w2 = createWorld()
    w2.restore(snap)
    const replayed = [w2.rand.next(), w2.rand.next(), w2.rand.next()]
    expect(replayed).toEqual(original)
  })

  it('reassigns spawn ids above the restored max (no collisions)', () => {
    const w = createWorld()
    const a = w.spawn()
    const b = w.spawn()
    const snap = w.snapshot()
    const w2 = createWorld()
    w2.restore(snap)
    const fresh = w2.spawn()
    expect(fresh).not.toBe(a)
    expect(fresh).not.toBe(b)
    expect(fresh).toBeGreaterThan(b)
  })

  it('wipes prior state before restoring', () => {
    const w = createWorld()
    w.spawn([entry(Position, { x: 1, y: 1 })])
    const snap = w.snapshot()
    const w2 = createWorld()
    w2.spawn([entry(Position, { x: 99, y: 99 })])
    w2.spawn([entry(Position, { x: 77, y: 77 })])
    w2.restore(snap)
    const all = w2.query(Has(Position)).entities
    expect(all).toHaveLength(1)
    expect(
      (all[0] as unknown as { Position: { x: number; y: number } }).Position.x,
    ).toBe(1)
  })
})



  it('fires query remove/add hooks when restore changes membership', () => {
    const w = createWorld()
    const adds: number[] = []
    const removes: number[] = []
    const q = w.query(Has(Position))
    q.onAdd((e) => adds.push(e.id))
    q.onRemove((e) => removes.push(e.id))
    const a = w.spawn([entry(Position, { x: 1, y: 1 })])
    w.step(0.016)
    const snap = w.snapshot()
    w.despawn(a)
    w.step(0.016)
    w.restore(snap)
    expect(removes.length).toBeGreaterThan(0)
    expect(adds.length).toBeGreaterThan(0)
  })

describe('snapshot — plugin hooks (SPEC §9.4)', () => {
  it('onSnapshot and onRestore receive the snap', () => {
    const w = createWorld()
    let savedWith: unknown = null
    let restoredWith: unknown = null
    w.use({
      name: 'spy',
      install: () => ok({
        onSnapshot: (s) => {
          savedWith = s
          return s
        },
        onRestore: (s) => {
          restoredWith = s
          return s
        },
      }),
    })
    const snap = w.snapshot()
    expect(savedWith).toBe(snap)
    w.restore(snap)
    expect(restoredWith).toBeTruthy()
  })
})
