/**
 * Hand-rolled fine-grained reactive store baseline (PLAN WS-1).
 * Not Solid/TanStack — a minimal signal+store that an app would write
 * instead of adopting an ECS, for plumbing / runtime comparison.
 *
 * Warmup and windowed priming mirror bench/run.mjs exactly — see the note
 * in baselines/koota.mjs.
 */
import { performance } from 'node:perf_hooks'

function percentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (p) => {
    if (sorted.length === 0) return 0
    return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]
  }
  return { p50: at(0.5), p95: at(0.95) }
}

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

  const samples = []
  for (let t = 0; t < ticks; t++) {
    const t0 = performance.now()
    tickFn()
    samples.push(performance.now() - t0)
  }
  const { p50, p95 } = percentiles(samples)
  return {
    workload: 'signals-soak',
    engine: 'signals',
    entities: entityCount,
    ticks,
    p50Ms: p50,
    p95Ms: p95,
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
  let domUpdates = 0
  // Subscribe only to currently visible ranks (fine-grained)
  const unsubs = new Map()

  function mount(e) {
    e.visible.set(true)
    unsubs.set(
      e.id,
      e.rank.subscribe(() => {
        domUpdates++
      }),
    )
    domUpdates++ // create
  }
  function unmount(e) {
    e.visible.set(false)
    unsubs.get(e.id)?.()
    unsubs.delete(e.id)
    domUpdates++ // destroy
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

  const samples = []
  const startUpdates = domUpdates
  for (let t = 0; t < ticks; t++) {
    const t0 = performance.now()
    tickFn()
    samples.push(performance.now() - t0)
  }

  const { p50, p95 } = percentiles(samples)
  return {
    workload: 'signals-windowed',
    engine: 'signals',
    entities: entityCount,
    ticks,
    windowSize,
    p50Ms: p50,
    p95Ms: p95,
    domUpdates: domUpdates - startUpdates,
  }
}
