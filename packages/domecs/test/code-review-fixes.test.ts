import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  And,
  Has,
  Not,
  createWorld,
  defineComponent,
  type EntityView,
} from '../src/index.js'

// Typed-view inference (D-2) requires the literal component name to flow into
// the type — TypeScript will not infer the second generic when only the first
// is supplied, so the dual-type-arg form `defineComponent<T, 'Name'>('Name')`
// is the path that captures both T and Name. The single-type-arg form
// `defineComponent<T>('Name')` still works; it produces `ComponentType<T, string>`
// and falls back to the untyped `EntityView` shape.
const Position = defineComponent<{ x: number; y: number }, 'Position'>('Position')
const Velocity = defineComponent<{ dx: number; dy: number }, 'Velocity'>('Velocity')
const Sprite = defineComponent<{ glyph: string }, 'Sprite'>('Sprite')

// =============================================================================
// P-1 — makeView walks archetype, not every component store.
// =============================================================================

describe('EntityView only carries the entity’s own components (P-1)', () => {
  it('does not project unrelated component types onto the view', () => {
    const world = createWorld()
    const a = world.spawn()
    const b = world.spawn()
    world.addComponent(a, Position, { x: 1, y: 2 })
    world.addComponent(b, Velocity, { dx: 3, dy: 4 })

    const q = world.query(Has(Position))
    const view = q.entities[0]!
    expect(view.id).toBe(a)
    expect((view as Record<string, unknown>).Position).toEqual({ x: 1, y: 2 })
    // Critically: Velocity exists in some other store, but this entity does
    // not carry it. Pre-P-1, makeView iterated every store and added any
    // value it found — still keyed correctly for this entity, but it
    // forced O(allStores) Map.gets per view. The invariant we care about is
    // that views never expose components the entity lacks.
    expect((view as Record<string, unknown>).Velocity).toBeUndefined()
  })

  it('view rebuilds with the new key set after archetype change', () => {
    const world = createWorld()
    const e = world.spawn()
    world.addComponent(e, Position, { x: 1, y: 2 })
    const q = world.query(Has(Position))

    const first = q.entities[0]!
    expect((first as Record<string, unknown>).Velocity).toBeUndefined()

    world.addComponent(e, Velocity, { dx: 5, dy: 6 })
    const second = q.entities[0]!
    expect((second as Record<string, unknown>).Velocity).toEqual({ dx: 5, dy: 6 })
  })
})

// =============================================================================
// P-2 — cached EntityView reused across reads within an archetype.
// =============================================================================

describe('EntityView caching (P-2)', () => {
  it('returns the same view object across multiple reads while the archetype is stable', () => {
    const world = createWorld()
    const e = world.spawn()
    world.addComponent(e, Position, { x: 0, y: 0 })
    const q = world.query(Has(Position))

    const v1 = q.entities[0]!
    const v2 = q.entities[0]!
    expect(v1).toBe(v2)
  })

  it('invalidates the cached view when the archetype changes', () => {
    const world = createWorld()
    const e = world.spawn()
    world.addComponent(e, Position, { x: 0, y: 0 })
    const q = world.query(Has(Position))
    const before = q.entities[0]!

    world.addComponent(e, Velocity, { dx: 1, dy: 0 })
    const after = q.entities[0]!
    expect(after).not.toBe(before)
    expect((after as Record<string, unknown>).Velocity).toEqual({ dx: 1, dy: 0 })
  })

  it('invalidates the cached view on despawn so a respawned id gets a fresh view', () => {
    const world = createWorld()
    const a = world.spawn()
    world.addComponent(a, Position, { x: 9, y: 9 })
    const q = world.query(Has(Position))
    const first = q.entities[0]!
    world.despawn(a)

    const b = world.spawn()
    world.addComponent(b, Position, { x: 1, y: 1 })
    const second = q.entities[0]!
    // Distinct id => distinct view; the cache must not have replayed `first`.
    expect(second.id).toBe(b)
    expect(second).not.toBe(first)
  })
})

// =============================================================================
// D-2 — typed EntityView fields when the query is a tuple of types.
// =============================================================================

describe('typed query EntityView (D-2)', () => {
  it('infers component field types from a tuple-form query', () => {
    const world = createWorld()
    const e = world.spawn([
      [Position, { x: 10, y: 20 }],
      [Velocity, { dx: 3, dy: 4 }],
    ])
    void e

    const q = world.query([Position, Velocity] as const)
    const view = q.entities[0]!
    // Field access is typed; no `as` needed.
    const x: number = view.Position.x
    const dy: number = view.Velocity.dy
    expect(x).toBe(10)
    expect(dy).toBe(4)

    // Type-level: the inferred view has the typed component slots and the id.
    expectTypeOf(view.Position).toEqualTypeOf<{ x: number; y: number }>()
    expectTypeOf(view.Velocity).toEqualTypeOf<{ dx: number; dy: number }>()
    expectTypeOf(view.id).toEqualTypeOf<number>()
  })

  it('combinator-form queries fall back to the unconstrained EntityView shape', () => {
    const world = createWorld()
    const e = world.spawn()
    world.addComponent(e, Position, { x: 1, y: 2 })
    const q = world.query(And(Has(Position), Not(Sprite)))
    const view = q.entities[0]!
    // No compile-time field inference, but runtime access still works.
    expect((view as Record<string, unknown>).Position).toEqual({ x: 1, y: 2 })
    expectTypeOf(view).toMatchTypeOf<EntityView>()
  })
})

// =============================================================================
// D-3 — setScale(0) is pause; pre-pause scale is preserved across setScale.
// =============================================================================

describe('setScale semantics (D-3)', () => {
  it('setScale(0) sets scale to 0 (equivalent to pause)', () => {
    const world = createWorld()
    world.setScale(0.5)
    world.setScale(0)
    expect(world.time.scale).toBe(0)
  })

  it('resume() after setScale(0) restores the most recent positive scale', () => {
    const world = createWorld()
    world.setScale(0.5)
    world.setScale(0)
    world.resume()
    expect(world.time.scale).toBe(0.5)
  })

  it('setScale(x>0) on a paused world resumes to x (no need to call resume separately)', () => {
    const world = createWorld()
    world.pause()
    expect(world.time.scale).toBe(0)
    world.setScale(2)
    expect(world.time.scale).toBe(2)
  })

  it('setScale(0) -> setScale(0.5) replaces the pre-pause scale; resume picks the latest', () => {
    const world = createWorld()
    world.setScale(0.25)
    world.setScale(0)
    world.setScale(0.75)
    world.setScale(0)
    world.resume()
    expect(world.time.scale).toBe(0.75)
  })

  it('rejects negative and non-finite scales', () => {
    const world = createWorld()
    expect(() => world.setScale(-1)).toThrow(/non-negative/)
    expect(() => world.setScale(Number.NaN)).toThrow(/non-negative/)
    expect(() => world.setScale(Number.POSITIVE_INFINITY)).toThrow(/non-negative/)
  })
})

// =============================================================================
// D-4 — world.requestTick() is the public idle-driver wake.
// =============================================================================

describe('world.requestTick (D-4)', () => {
  it('is a no-op in headless / non-RAF environments (does not throw)', () => {
    const world = createWorld({ headless: true })
    expect(() => world.requestTick()).not.toThrow()
  })

  it('wakes a sleeping idle loop when called from outside a tick', () => {
    interface FrameQueue {
      queue: Map<number, FrameRequestCallback>
      advance(t: number): void
    }
    let nextHandle = 1
    let clock = 0
    const queue = new Map<number, FrameRequestCallback>()
    const globals = globalThis as unknown as {
      requestAnimationFrame?: (cb: FrameRequestCallback) => number
      cancelAnimationFrame?: (h: number) => void
    }
    const prevRaf = globals.requestAnimationFrame
    const prevCaf = globals.cancelAnimationFrame
    globals.requestAnimationFrame = (cb) => {
      const h = nextHandle++
      queue.set(h, cb)
      return h
    }
    globals.cancelAnimationFrame = (h) => {
      queue.delete(h)
    }
    const harness: FrameQueue = {
      queue,
      advance(t: number) {
        clock += t
        const pending = Array.from(queue.entries())
        queue.clear()
        for (const [, cb] of pending) cb(clock)
      },
    }
    try {
      const world = createWorld({ idle: true })
      world.start()
      harness.advance(16) // prime
      harness.advance(16) // first tick, then sleep
      expect(harness.queue.size).toBe(0)

      world.requestTick()
      expect(harness.queue.size).toBe(1)
      world.stop()
    } finally {
      if (prevRaf) globals.requestAnimationFrame = prevRaf
      else delete globals.requestAnimationFrame
      if (prevCaf) globals.cancelAnimationFrame = prevCaf
      else delete globals.cancelAnimationFrame
    }
  })
})
