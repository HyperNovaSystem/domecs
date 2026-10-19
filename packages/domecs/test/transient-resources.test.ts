// E17.1 (harness spec §6.4; O-36): transient resources. A resource defined
// with `{ transient: true }` is left out of `snapshot()` (value and change
// marks), and `restore()` keeps its live value, so render caches such as a
// camera never change a hash or get restored over freshly derived state.
import { describe, expect, it } from 'vitest'
import {
  And,
  Has,
  OnChangedResource,
  createWorld,
  defineComponent,
  defineResource,
  entry,
  hashSnapshot,
  type World,
} from '../src/index.js'

const Camera = defineResource<{ x: number; y: number; zoom: number }>('TrCamera', {
  default: () => ({ x: 0, y: 0, zoom: 1 }),
  transient: true,
  validate: (v) => v.zoom > 0 || 'zoom must be positive',
})
const Score = defineResource<number>('TrScore', { default: 0 })
const Pos = defineComponent<{ x: number }>('TrPos', { defaults: { x: 0 } })

function strict(w: World): string {
  return hashSnapshot(w.snapshot(), { includeChanges: true })
}

function build(): { world: World; id: number; cameraRuns: { n: number } } {
  const world = createWorld({ headless: true, seed: [1, 2, 3, 4] })
  const cameraRuns = { n: 0 }
  // A change-gated reader of the camera: an unseen
  // camera mark would be carried in `changes` if transient marks were recorded.
  world.system(
    'camera-reader',
    { schedule: 'tick', priority: 10, query: And(Has(Pos), OnChangedResource(Camera)) },
    ({ entities }) => {
      if (entities.length > 0) cameraRuns.n++
    },
  )
  world.system('move', { schedule: 'tick' }, ({ world: w }) => {
    for (const e of w.listEntities([Pos] as const)) {
      w.getComponent(e, Pos)!.x += 1
      w.markChanged(e, Pos)
    }
  })
  const id = world.spawn([entry(Pos, { x: 0 })])
  world.setResource(Score, 5)
  return { world, id, cameraRuns }
}

describe('transient resources (E17.1, O-36)', () => {
  it('snapshot() omits a transient resource value', () => {
    const { world } = build()
    world.setResource(Camera, { x: 3, y: 4, zoom: 2 })
    const snap = world.snapshot()
    expect(snap.resources).toEqual({ TrScore: 5 })
  })

  it('omits the resources field when only transient resources have values', () => {
    const world = createWorld({ headless: true })
    world.getResource(Camera) // materializes the default
    expect(world.snapshot().resources).toBeUndefined()
  })

  it('restore() keeps the live value of a transient resource', () => {
    const { world, id } = build()
    world.setResource(Camera, { x: 1, y: 1, zoom: 1 })
    const snap = world.snapshot()
    world.stepOnce()
    world.setResource(Camera, { x: 9, y: 8, zoom: 3 })
    world.setResource(Score, 99)
    world.restore(snap)
    expect(world.getResource(Camera)).toEqual({ x: 9, y: 8, zoom: 3 })
    expect(world.getResource(Score)).toBe(5)
    expect(world.getComponent(id, Pos)?.x).toBe(0)
  })

  it('a fresh world restored from the snapshot falls back to the default', () => {
    const a = build()
    a.world.setResource(Camera, { x: 7, y: 7, zoom: 4 })
    const snap = a.world.snapshot()
    const b = build()
    b.world.restore(snap)
    expect(b.world.getResource(Camera)).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(strict(b.world)).toBe(strict(a.world))
  })

  it('ignores a value a snapshot carries for a registered transient resource', () => {
    // e.g. a save written before the resource was declared transient
    const { world } = build()
    world.setResource(Camera, { x: 2, y: 2, zoom: 2 })
    const snap = world.snapshot()
    const legacy = {
      ...snap,
      resources: { ...snap.resources, TrCamera: { x: 0, y: 0, zoom: -1 } },
    }
    // the stale value would fail validation; it is neither validated nor applied
    expect(() => world.restore(legacy)).not.toThrow()
    expect(world.getResource(Camera)).toEqual({ x: 2, y: 2, zoom: 2 })
    expect(world.snapshot().resources).toEqual({ TrScore: 5 })
  })

  it('the default and strict hashes are stable when a camera resource changes', () => {
    const { world } = build()
    world.stepOnce()
    const plain = hashSnapshot(world.snapshot())
    const strictBefore = strict(world)
    // Between ticks (out of tick), as a renderer would
    world.setResource(Camera, { x: 10, y: 0, zoom: 1 })
    world.markResourceChanged(Camera)
    expect(hashSnapshot(world.snapshot())).toBe(plain)
    expect(strict(world)).toBe(strictBefore)
    expect(world.snapshot().changes).toBeUndefined()
  })

  it('a camera change made mid-tick leaves no carried mark', () => {
    const run = (camera: boolean): string => {
      const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
      // The reader runs before the camera follow, so the follow's mark is
      // unseen at the end of the tick.
      w.system(
        'camera-reader',
        { schedule: 'tick', priority: 10, query: And(Has(Pos), OnChangedResource(Camera)) },
        () => {},
      )
      w.system('follow', { schedule: 'tick', priority: 200 }, ({ world: ww }) => {
        if (camera) ww.setResource(Camera, { x: ww.time.tick, y: 0, zoom: 1 })
      })
      w.spawn([entry(Pos, { x: 0 })])
      w.stepOnce()
      w.stepOnce()
      return strict(w)
    }
    expect(run(true)).toBe(run(false))
  })

  it('a transient resource still marks changes for live readers', () => {
    const { world, cameraRuns } = build()
    world.stepOnce()
    const before = cameraRuns.n
    world.setResource(Camera, { x: 1, y: 2, zoom: 1 })
    world.stepOnce()
    expect(cameraRuns.n).toBe(before + 1)
  })

  it('validation is unchanged', () => {
    const world = createWorld({ headless: true })
    expect(() => world.setResource(Camera, { x: 0, y: 0, zoom: 0 })).toThrow(
      /invalid resource "TrCamera": zoom must be positive/,
    )
  })

  it('describeResource reports the flag', () => {
    const world = createWorld({ headless: true })
    expect(world.describeResource(Camera)).toEqual({
      name: 'TrCamera',
      hasValue: false,
      hasDefault: true,
      transient: true,
    })
    expect(world.describeResource(Score).transient).toBe(false)
    expect(world.describe().resources.find((r) => r.name === 'TrCamera')?.transient).toBe(true)
  })

  it('live and restored worlds continue identically with a camera in play', () => {
    const live = build()
    live.world.stepOnce()
    live.world.setResource(Camera, { x: 5, y: 5, zoom: 2 })
    const snap = live.world.snapshot({ pendingEvents: true })
    const fork = build()
    fork.world.restore(snap)
    for (let i = 0; i < 3; i++) {
      live.world.stepOnce()
      fork.world.stepOnce()
    }
    expect(strict(fork.world)).toBe(strict(live.world))
  })
})
