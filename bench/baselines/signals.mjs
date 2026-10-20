/**
 * Hand-rolled fine-grained reactive store baseline (PLAN WS-1).
 * Not Solid/TanStack — a minimal signal+store that an app would write
 * instead of adopting an ECS, for plumbing / runtime comparison.
 *
 * Warmup and windowed priming mirror bench/run.mjs exactly — see the note
 * in baselines/koota.mjs.
 */
import { measureTicks } from '../measure.mjs'

/** Per-entity signal: value + subscriber set. */
function signal(initial) {
  let v = initial
  const subs = new Set()
  return {
    get: () => v,
    set: (next) => {
      v = typeof next === 'function' ? next(v) : next
      for (const s of subs) s(v)
    },
    subscribe: (fn) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
  }
}

export function runSignalsSoak({ entityCount, ticks, warmupTicks = 0 }) {
  // Array of { x, y, dx, dy } as signals — fine-grained style.
  const entities = []
  for (let i = 0; i < entityCount; i++) {
    entities.push({
      x: signal(i % 100),
      y: signal((i * 3) % 100),
      dx: signal(0.01),
      dy: signal(-0.02),
    })
  }

  // Dummy subscribers (simulate reactive views reading position)
  let notifications = 0
  for (const e of entities) {
    e.x.subscribe(() => {
      notifications++
    })
    e.y.subscribe(() => {
      notifications++
    })
  }

  const tickFn = () => {
    for (const e of entities) {
      e.x.set(e.x.get() + e.dx.get())
      e.y.set(e.y.get() + e.dy.get())
    }
  }
  for (let t = 0; t < warmupTicks; t++) tickFn()
  notifications = 0

  const measured = measureTicks(tickFn, ticks)
  return {
    workload: 'signals-soak',
    engine: 'signals',
    entities: entityCount,
    ticks,
    ...measured,
    // Per field (x and y), so 2 per entity per tick.
    notifications,
  }
}

export function runSignalsWindowed({ entityCount, ticks, windowSize, warmupTicks = 0 }) {
  const entities = []
  for (let i = 0; i < entityCount; i++) {
    entities.push({
      id: i,
      value: signal(i),
      rank: signal(0),
      visible: signal(false),
    })
  }

  let windowStart = 0
  const dom = { create: 0, update: 0, remove: 0 }
  // Subscribe only to currently visible ranks (fine-grained)
  const unsubs = new Map()

  function mount(e) {
    e.visible.set(true)
    unsubs.set(
      e.id,
      e.rank.subscribe(() => {
        dom.update++
      }),
    )
    dom.create++
  }
  function unmount(e) {
    e.visible.set(false)
    unsubs.get(e.id)?.()
    unsubs.delete(e.id)
    dom.remove++
  }

  const visible = new Set()

  const tickFn = () => {
    const next = new Set()
    for (let k = 0; k < windowSize; k++) {
      next.add(entities[(windowStart + k) % entities.length])
    }
    for (const e of visible) {
      if (!next.has(e)) {
        unmount(e)
        visible.delete(e)
      }
    }
    for (const e of next) {
      if (!visible.has(e)) {
        mount(e)
        visible.add(e)
      } else {
        e.rank.set((r) => (r + 1) % 1000)
      }
    }
    windowStart = (windowStart + 3) % entities.length
  }

  // Prime (mounts first window, advances windowStart to 3) + warmup —
  // excluded from timing and from the reported domUpdates.
  for (let t = 0; t < 1 + warmupTicks; t++) tickFn()
  Object.assign(dom, { create: 0, update: 0, remove: 0 })

  const measured = measureTicks(tickFn, ticks)
  return {
    workload: 'signals-windowed',
    engine: 'signals',
    entities: entityCount,
    ticks,
    windowSize,
    ...measured,
    domUpdates: dom.create + dom.update + dom.remove,
    domSplit: { ...dom },
  }
}
