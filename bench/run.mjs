#!/usr/bin/env node
/**
 * Headless DOMECS micro-benchmarks (PLAN WS-1 / FINDINGS O-14).
 *
 * Imports built ESM from packages/{name}/dist. Workspace package.json exports
 * still point at TypeScript source for monorepo DX, so we import dist by file
 * URL rather than package name (avoids resolving @domecs scope to src/).
 *
 * Usage:
 *   pnpm build
 *   node bench/run.mjs
 *   node bench/run.mjs --workload soak|telemetry|snapshot|windowed|baseline|all
 *   node bench/run.mjs --entities 20000 --ticks 200
 *   node bench/run.mjs --write   # also write bench/results.json
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { writeFileSync, mkdirSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const coreUrl = pathToFileURL(join(root, 'packages/domecs/dist/index.js')).href
const { createWorld, defineComponent, entry } = await import(coreUrl)

const args = parseArgs(process.argv.slice(2))
const workload = args.workload ?? 'all'
const entityCount = Number(args.entities ?? 5_000)
const ticks = Number(args.ticks ?? 100)
const windowSize = Number(args.window ?? 50)
const fixedStep = 1 / 60
const writeResults = !!args.write

const Position = defineComponent('BenchPosition', {
  defaults: { x: 0, y: 0 },
})
const Velocity = defineComponent('BenchVelocity', {
  defaults: { dx: 0, dy: 0 },
})
const Telemetry = defineComponent('BenchTelemetry', {
  defaults: { value: 0, dirty: false },
})
const Row = defineComponent('BenchRow', {
  defaults: { rank: 0, label: '' },
})

const results = []

if (workload === 'all' || workload === 'soak') {
  results.push(runSoak({ entityCount, ticks, fixedStep }))
}
if (workload === 'all' || workload === 'telemetry') {
  results.push(
    runTelemetry({
      entityCount: Math.min(entityCount, 2_000),
      ticks,
      updatesPerTick: 8,
    }),
  )
}
if (workload === 'all' || workload === 'snapshot') {
  results.push(runSnapshot({ entityCount: Math.min(entityCount, 5_000) }))
}
if (workload === 'all' || workload === 'windowed') {
  results.push(
    runWindowed({
      entityCount: Math.min(entityCount, 2_000),
      ticks,
      windowSize,
    }),
  )
}
if (workload === 'all' || workload === 'baseline') {
  results.push(
    runPlainBaseline({
      entityCount: Math.min(entityCount, 5_000),
      ticks,
      fixedStep,
    }),
  )
}

const summary = {
  when: new Date().toISOString(),
  host: process.version,
  results,
}
console.log(JSON.stringify(summary, null, 2))
for (const r of results) {
  console.error(
    `[${r.workload}] n=${r.entities} ticks=${r.ticks ?? '-'} ` +
      `p50=${fmtMs(r.p50Ms)} p95=${fmtMs(r.p95Ms)}` +
      (r.snapshotBytes != null ? ` snapBytes=${r.snapshotBytes}` : '') +
      (r.snapshotMs != null ? ` snapMs=${fmtMs(r.snapshotMs)}` : '') +
      (r.deterministic != null ? ` deterministic=${r.deterministic}` : '') +
      (r.domUpdates != null ? ` domUpdates=${r.domUpdates}` : ''),
  )
}

if (writeResults) {
  mkdirSync(join(root, 'bench'), { recursive: true })
  const out = join(root, 'bench/results.json')
  writeFileSync(out, JSON.stringify(summary, null, 2) + '\n')
  console.error(`[bench] wrote ${out}`)
}

// --- workloads ----------------------------------------------------------------

function runSoak({ entityCount, ticks, fixedStep }) {
  const world = createWorld({ headless: true, fixedStep })
  world.system(
    'bench-move',
    { schedule: 'fixed', query: [Position, Velocity] },
    ({ entities }) => {
      for (const e of entities) {
        e.BenchPosition.x += e.BenchVelocity.dx
        e.BenchPosition.y += e.BenchVelocity.dy
        world.markChanged(e.id, Position)
      }
    },
  )
  for (let i = 0; i < entityCount; i++) {
    world.spawn([
      entry(Position, { x: i % 100, y: (i * 3) % 100 }),
      entry(Velocity, { dx: 0.01, dy: -0.02 }),
    ])
  }

  const samples = []
  for (let t = 0; t < ticks; t++) {
    const t0 = performance.now()
    world.step(fixedStep)
    samples.push(performance.now() - t0)
  }
  const { p50, p95 } = percentiles(samples)
  return {
    workload: 'soak',
    entities: entityCount,
    ticks,
    p50Ms: p50,
    p95Ms: p95,
  }
}

function runTelemetry({ entityCount, ticks, updatesPerTick }) {
  const world = createWorld({ headless: true })
  const ids = []
  for (let i = 0; i < entityCount; i++) {
    ids.push(world.spawn([entry(Telemetry, { value: 0, dirty: false })]))
  }
  let cursor = 0
  world.system('bench-coalesce', { schedule: 'tick' }, () => {
    for (let k = 0; k < updatesPerTick; k++) {
      const id = ids[(cursor + k) % ids.length]
      const t = world.getComponent(id, Telemetry)
      if (!t) continue
      t.value += 1
      t.dirty = true
      world.markChanged(id, Telemetry)
    }
    cursor = (cursor + updatesPerTick) % ids.length
  })

  const samples = []
  for (let t = 0; t < ticks; t++) {
    const t0 = performance.now()
    world.step(1 / 60)
    samples.push(performance.now() - t0)
  }
  const { p50, p95 } = percentiles(samples)
  return {
    workload: 'telemetry',
    entities: entityCount,
    ticks,
    updatesPerTick,
    p50Ms: p50,
    p95Ms: p95,
  }
}

function runSnapshot({ entityCount }) {
  const world = createWorld({ headless: true, seed: [1, 2, 3, 4] })
  for (let i = 0; i < entityCount; i++) {
    world.spawn([
      entry(Position, { x: i, y: i * 2 }),
      entry(Velocity, { dx: 1, dy: -1 }),
    ])
  }
  for (let i = 0; i < 10; i++) world.step(1 / 60)

  const t0 = performance.now()
  const snap = world.snapshot()
  const snapshotMs = performance.now() - t0
  const bytes = JSON.stringify(snap).length

  const world2 = createWorld({ headless: true })
  world2.restore(snap)
  const a = JSON.stringify(world.snapshot())
  const b = JSON.stringify(world2.snapshot())
  const deterministic = a === b

  return {
    workload: 'snapshot',
    entities: entityCount,
    p50Ms: snapshotMs,
    p95Ms: snapshotMs,
    snapshotMs,
    snapshotBytes: bytes,
    deterministic,
  }
}

/**
 * Windowed projection: maintain a visible window of `windowSize` rows over
 * a larger entity set by add/remove of a Row component (fleet-shaped).
 * Counts synthetic DOM updates (create/update/destroy callbacks), no real DOM.
 */
function runWindowed({ entityCount, ticks, windowSize }) {
  const world = createWorld({ headless: true })
  const ids = []
  for (let i = 0; i < entityCount; i++) {
    ids.push(world.spawn([entry(Telemetry, { value: i, dirty: false })]))
  }

  let domUpdates = 0
  let windowStart = 0
  const visible = new Set()

  // Simulate retained view: only entities with Row are "mounted"
  world.system('window-project', { schedule: 'tick' }, () => {
    const next = new Set()
    for (let k = 0; k < windowSize; k++) {
      next.add(ids[(windowStart + k) % ids.length])
    }
    for (const id of visible) {
      if (!next.has(id)) {
        world.removeComponent(id, Row)
        domUpdates++ // destroy
        visible.delete(id)
      }
    }
    for (const id of next) {
      if (!visible.has(id)) {
        world.addComponent(id, Row, { rank: 0, label: String(id) })
        domUpdates++ // create + first paint
        visible.add(id)
      } else {
        const r = world.getComponent(id, Row)
        if (r) {
          r.rank = (r.rank + 1) % 1000
          world.markChanged(id, Row)
          domUpdates++ // update
        }
      }
    }
    windowStart = (windowStart + 3) % ids.length
  })

  // Prime first window
  world.step(1 / 60)

  const samples = []
  const startUpdates = domUpdates
  for (let t = 0; t < ticks; t++) {
    const t0 = performance.now()
    world.step(1 / 60)
    samples.push(performance.now() - t0)
  }
  const { p50, p95 } = percentiles(samples)
  return {
    workload: 'windowed',
    entities: entityCount,
    ticks,
    windowSize,
    p50Ms: p50,
    p95Ms: p95,
    domUpdates: domUpdates - startUpdates,
  }
}

/**
 * Plain hand-rolled baseline for soak-shaped work: arrays + for-loops,
 * no ECS. Used to compare plumbing cost / overhead narrative.
 */
function runPlainBaseline({ entityCount, ticks, fixedStep }) {
  const xs = new Float64Array(entityCount)
  const ys = new Float64Array(entityCount)
  const dx = new Float64Array(entityCount)
  const dy = new Float64Array(entityCount)
  for (let i = 0; i < entityCount; i++) {
    xs[i] = i % 100
    ys[i] = (i * 3) % 100
    dx[i] = 0.01
    dy[i] = -0.02
  }
  const samples = []
  for (let t = 0; t < ticks; t++) {
    const t0 = performance.now()
    for (let i = 0; i < entityCount; i++) {
      xs[i] += dx[i]
      ys[i] += dy[i]
    }
    samples.push(performance.now() - t0)
  }
  const { p50, p95 } = percentiles(samples)
  return {
    workload: 'baseline-plain',
    entities: entityCount,
    ticks,
    p50Ms: p50,
    p95Ms: p95,
    note: 'hand-rolled Float64Array loops; not feature-equivalent',
  }
}

// --- utils --------------------------------------------------------------------

function percentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (p) => {
    if (sorted.length === 0) return 0
    const idx = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))
    return sorted[idx]
  }
  return { p50: at(0.5), p95: at(0.95) }
}

function fmtMs(n) {
  return `${n.toFixed(3)}ms`
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out[key] = next
        i++
      } else {
        out[key] = true
      }
    }
  }
  return out
}
