/**
 * Koota soak + windowed baselines (PLAN WS-1).
 * Uses the koota package from the workspace root.
 *
 * Warmup and windowed priming mirror bench/run.mjs exactly: `warmupTicks`
 * unmeasured iterations before sampling, and the windowed prime mounts the
 * first window then advances windowStart to 3 with its updates excluded
 * from domUpdates — so timings and counters compare equal work across
 * engines.
 *
 * Soak tracks changes like DOMECS does, using Koota's fastest stable
 * configuration we found: the default `changeDetection: 'auto'`, which
 * diffs a trait only when something subscribes to it, plus a
 * `world.onChange(Position)` reader that counts deliveries. (A separate
 * Changed(Position) query does not switch 'auto' tracking on, so the old
 * harness measured Koota doing no change tracking at all; 'always' plus a
 * Changed query delivers too, but ran 1–4 ms per tick from run to run.)
 */
import { createWorld, trait } from 'koota'
import { measureTicks } from '../measure.mjs'

const Position = trait({ x: 0, y: 0 })
const Velocity = trait({ x: 0, y: 0 })
const Telemetry = trait({ value: 0 })
const Visible = trait({ rank: 0 })

export function runKootaSoak({ entityCount, ticks, warmupTicks = 0 }) {
  const world = createWorld()
  for (let i = 0; i < entityCount; i++) {
    world.spawn(
      Position({ x: i % 100, y: (i * 3) % 100 }),
      Velocity({ x: 0.01, y: -0.02 }),
    )
  }

  let changesDelivered = 0
  world.onChange(Position, () => {
    changesDelivered++
  })
  const tickFn = () => {
    world.query(Position, Velocity).updateEach(([position, velocity]) => {
      position.x += velocity.x
      position.y += velocity.y
    })
  }
  for (let t = 0; t < warmupTicks; t++) tickFn()
  changesDelivered = 0

  const measured = measureTicks(tickFn, ticks)
  // Koota registers worlds globally (16 at most): release this one, or GC
  // cannot reclaim it and later trials run out of worlds.
  world.destroy()
  return {
    workload: 'koota-soak',
    engine: 'koota',
    entities: entityCount,
    ticks,
    ...measured,
    changesDelivered,
  }
}

export function runKootaWindowed({ entityCount, ticks, windowSize, warmupTicks = 0 }) {
  const world = createWorld()
  const entities = []
  for (let i = 0; i < entityCount; i++) {
    entities.push(world.spawn(Telemetry({ value: i })))
  }

  let windowStart = 0
  const dom = { create: 0, update: 0, remove: 0 }
  const visible = new Set()

  const tickFn = () => {
    const next = new Set()
    for (let k = 0; k < windowSize; k++) {
      next.add(entities[(windowStart + k) % entities.length])
    }
    for (const e of visible) {
      if (!next.has(e)) {
        e.remove(Visible)
        visible.delete(e)
        dom.remove++
      }
    }
    for (const e of next) {
      if (!visible.has(e)) {
        e.add(Visible({ rank: 0 }))
        visible.add(e)
        dom.create++
      } else {
        e.set(Visible, (prev) => ({ rank: ((prev?.rank ?? 0) + 1) % 1000 }))
        dom.update++
      }
    }
    windowStart = (windowStart + 3) % entities.length
  }

  // Prime (mounts first window, advances windowStart to 3) + warmup —
  // excluded from timing and from the reported domUpdates.
  for (let t = 0; t < 1 + warmupTicks; t++) tickFn()
  Object.assign(dom, { create: 0, update: 0, remove: 0 })

  const measured = measureTicks(tickFn, ticks)
  world.destroy()
  return {
    workload: 'koota-windowed',
    engine: 'koota',
    entities: entityCount,
    ticks,
    windowSize,
    ...measured,
    domUpdates: dom.create + dom.update + dom.remove,
    domSplit: { ...dom },
  }
}
