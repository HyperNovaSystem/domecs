/**
 * Koota soak + windowed baselines (PLAN WS-1).
 * Uses the koota package from the workspace root.
 */
import { performance } from 'node:perf_hooks'
import { createWorld, trait } from 'koota'

const Position = trait({ x: 0, y: 0 })
const Velocity = trait({ x: 0, y: 0 })
const Telemetry = trait({ value: 0 })
const Visible = trait({ rank: 0 })

function percentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (p) => {
    if (sorted.length === 0) return 0
    return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]
  }
  return { p50: at(0.5), p95: at(0.95) }
}

export function runKootaSoak({ entityCount, ticks }) {
  const world = createWorld()
  for (let i = 0; i < entityCount; i++) {
    world.spawn(
      Position({ x: i % 100, y: (i * 3) % 100 }),
      Velocity({ x: 0.01, y: -0.02 }),
    )
  }

  const samples = []
  for (let t = 0; t < ticks; t++) {
    const t0 = performance.now()
    world.query(Position, Velocity).updateEach(([position, velocity]) => {
      position.x += velocity.x
      position.y += velocity.y
    })
    samples.push(performance.now() - t0)
  }
  const { p50, p95 } = percentiles(samples)
  return {
    workload: 'koota-soak',
    engine: 'koota',
    entities: entityCount,
    ticks,
    p50Ms: p50,
    p95Ms: p95,
  }
}

export function runKootaWindowed({ entityCount, ticks, windowSize }) {
  const world = createWorld()
  const entities = []
  for (let i = 0; i < entityCount; i++) {
    entities.push(world.spawn(Telemetry({ value: i })))
  }

  let windowStart = 0
  let domUpdates = 0
  const visible = new Set()

  const samples = []
  // prime
  for (let k = 0; k < windowSize; k++) {
    const e = entities[k]
    e.add(Visible({ rank: 0 }))
    visible.add(e)
    domUpdates++
  }

  for (let t = 0; t < ticks; t++) {
    const t0 = performance.now()
    const next = new Set()
    for (let k = 0; k < windowSize; k++) {
      next.add(entities[(windowStart + k) % entities.length])
    }
    for (const e of visible) {
      if (!next.has(e)) {
        e.remove(Visible)
        visible.delete(e)
        domUpdates++
      }
    }
    for (const e of next) {
      if (!visible.has(e)) {
        e.add(Visible({ rank: 0 }))
        visible.add(e)
        domUpdates++
      } else {
        e.set(Visible, (prev) => ({ rank: ((prev?.rank ?? 0) + 1) % 1000 }))
        domUpdates++
      }
    }
    windowStart = (windowStart + 3) % entities.length
    samples.push(performance.now() - t0)
  }

  const { p50, p95 } = percentiles(samples)
  return {
    workload: 'koota-windowed',
    engine: 'koota',
    entities: entityCount,
    ticks,
    windowSize,
    p50Ms: p50,
    p95Ms: p95,
    domUpdates,
  }
}
