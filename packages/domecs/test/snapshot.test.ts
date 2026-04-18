import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
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
    w.spawn([[Position as never, { x: 1, y: 2 }]])
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
      [Position as never, { x: 1, y: 2 }],
      [Ephemeral as never, { tag: 'temp' }],
    ])
    const snap = w.snapshot()
    const captured = snap.entities.find((r) => r.id === e)!
    expect(captured.components.Position).toEqual({ x: 1, y: 2 })
    expect(captured.components.Ephemeral).toBeUndefined()
  })

  it('deep-clones component values (mutation after snapshot does not leak)', () => {
    const w = createWorld()
    const e = w.spawn([[Position as never, { x: 10, y: 20 }]])
    const snap = w.snapshot()
    const pos = w.getComponent(e, Position)!
    pos.x = 999
    expect((snap.entities[0]!.components.Position as { x: number }).x).toBe(10)
  })
})

describe('restore — roundtrip (SPEC §7.1)', () => {
  it('restores entities + components from a snapshot', () => {
    const w = createWorld({ seed: 7 })
    const a = w.spawn([[Position as never, { x: 1, y: 1 }]])
    const b = w.spawn([
      [Position as never, { x: 2, y: 2 }],
      [Velocity as never, { dx: 1, dy: 0 }],
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
    w.spawn([[Position as never, { x: 1, y: 1 }]])
    const snap = w.snapshot()
    const w2 = createWorld()
    w2.spawn([[Position as never, { x: 99, y: 99 }]])
    w2.spawn([[Position as never, { x: 77, y: 77 }]])
    w2.restore(snap)
    const all = w2.query({ kind: 'has', type: Position as never }).entities
    expect(all).toHaveLength(1)
    expect(
      (all[0] as unknown as { Position: { x: number; y: number } }).Position.x,
    ).toBe(1)
  })
})

describe('snapshot — plugin hooks (SPEC §9.4)', () => {
  it('onSnapshot and onRestore receive the snap', () => {
    const w = createWorld()
    let savedWith: unknown = null
    let restoredWith: unknown = null
    w.use({
      name: 'spy',
      install: () => ({
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
