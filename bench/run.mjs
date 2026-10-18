#!/usr/bin/env node
/**
 * Headless DOMECS micro-benchmarks (PLAN WS-1 / FINDINGS O-14).
 *
 * Imports built ESM from packages/{name}/dist. Workspace package.json exports
 * still point at TypeScript source for monorepo DX, so we import dist by file
 * URL rather than package name (avoids resolving @domecs scope to src/).
 *
 * Methodology:
 * - Every workload runs `--warmup` unmeasured ticks first (default 30) so
 *   p50/p95 describe warmed steady state, not JIT/IC cold-start.
 * - When Node is started with --expose-gc, a full GC runs between workloads
 *   so one engine's garbage is not attributed to the next; `gcBetween` in
 *   the summary records whether that isolation was active. All engines
 *   still share one process — child-process-per-engine is the stronger
 *   isolation if numbers look noisy.
 * - Compare-mode rows are tagged `phase: 'compare'` and the verdict is
 *   computed ONLY from those rows, so a standalone soak at a different
 *   entity count can never leak into the ratios.
 *
 * Usage:
 *   pnpm build
 *   node bench/run.mjs
 *   node bench/run.mjs --workload soak|telemetry|snapshot|hash|windowed|baseline|compare|all
 *   node bench/run.mjs --entities 20000 --ticks 200 --warmup 50
 *   node bench/run.mjs --workload compare --trials 9   # compare trials (default 5)
 *   node bench/run.mjs --write   # also write bench/results.json
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { runKootaSoak, runKootaWindowed } from './baselines/koota.mjs'
import { runSignalsSoak, runSignalsWindowed } from './baselines/signals.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distEntry = join(root, 'packages/domecs/dist/index.js')
if (!existsSync(distEntry)) {
  console.error('[bench] packages/domecs/dist not found.')
  console.error('[bench] Build @domecs/core first:  pnpm --filter @domecs/core build')
  process.exit(1)
}
const { createWorld, defineComponent, entry, OnChanged, hashSnapshot, canonicalSnapshot } = await import(
  pathToFileURL(distEntry).href
)

const args = parseArgs(process.argv.slice(2))
const workload = args.workload ?? 'all'
const entityCount = Number(args.entities ?? 5_000)
const ticks = Number(args.ticks ?? 100)
const warmupTicks = Number(args.warmup ?? 30)
const windowSize = Number(args.window ?? 50)
const fixedStep = 1 / 60
const writeResults = !!args.write
const compareN = Math.min(entityCount, 5_000)
const compareWindowN = Math.min(entityCount, 2_000)
// O-72: the compare phase runs this many interleaved trials and reports the
// median and spread; one run per engine was not reproducible.
const compareTrials = Math.max(1, Number(args.trials ?? 5))
const gcAvailable = typeof globalThis.gc === 'function'

/** Full GC between workloads when --expose-gc is set (see header). */
function maybeGc() {
  if (gcAvailable) globalThis.gc()
}

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
const HashLabel = defineComponent('BenchHashLabel', {
  defaults: { name: '', hp: 0, tags: [] },
})

const results = []
function record(row) {
  maybeGc()
  results.push(row)
  return row
}

if (workload === 'all' || workload === 'soak') {
  record(runSoak({ entityCount, ticks, fixedStep }))
}
if (workload === 'all' || workload === 'telemetry') {
  record(
    runTelemetry({
      entityCount: Math.min(entityCount, 2_000),
      hotEntities: 100,
      updatesPerTick: 1_000,
      ticks,
    }),
  )
}
if (workload === 'all' || workload === 'snapshot') {
  record(runSnapshot({ entityCount: Math.min(entityCount, 5_000), repeats: 20 }))
}
if (workload === 'all' || workload === 'hash') {
  // Fixed at 1000 entities: the spec §4.1 cost target (≤ 2 ms, informational)
  // is stated for a 1000-entity snapshot.
  record(runHash({ entityCount: 1_000, repeats: 50 }))
}
if (workload === 'all' || workload === 'windowed') {
  record(
    runWindowed({
      entityCount: Math.min(entityCount, 2_000),
      ticks,
      windowSize,
    }),
  )
}
if (workload === 'all' || workload === 'baseline') {
  record(
    runPlainBaseline({
      entityCount: Math.min(entityCount, 5_000),
      ticks,
      fixedStep,
    }),
  )
}
// Cross-engine comparison (soak + windowed): DOMECS vs Koota vs signals.
// Rows are collected locally and tagged phase:'compare' — the verdict is
// derived ONLY from these rows (identical entity counts by construction).
if (workload === 'all' || workload === 'compare') {
  const bench = { ticks, warmupTicks }
  const compareRunners = [
    () => runSoak({ entityCount: compareN, ticks, fixedStep }),
    () => runKootaSoak({ entityCount: compareN, ...bench }),
    () => runSignalsSoak({ entityCount: compareN, ...bench }),
    () => runWindowed({ entityCount: compareWindowN, ticks, windowSize }),
    () => runKootaWindowed({ entityCount: compareWindowN, windowSize, ...bench }),
    () => runSignalsWindowed({ entityCount: compareWindowN, windowSize, ...bench }),
  ]
  // Trials interleave the engines, so host drift hits each one alike.
  const trials = []
  for (let t = 0; t < compareTrials; t++) {
    const rows = []
    for (const run of compareRunners) {
      maybeGc()
      rows.push(run())
    }
    trials.push(rows)
  }
  const compareRows = trials[0].map((row, i) => aggregateTrials(trials.map((rows) => rows[i])))
  for (const row of compareRows) record({ ...row, phase: 'compare' })
  record(summarizeComparison(compareRows, trials))
}

const summary = {
  when: new Date().toISOString(),
  host: process.version,
  warmupTicks,
  gcBetween: gcAvailable,
  results,
}
console.log(JSON.stringify(summary, null, 2))
for (const r of results) {
  console.error(
    `[${r.workload}${r.phase ? ':' + r.phase : ''}] n=${r.entities} ticks=${r.ticks ?? '-'} ` +
      `p50=${fmtMs(r.p50Ms)} p95=${fmtMs(r.p95Ms)}` +
      (r.snapshotBytes != null ? ` snapBytes=${r.snapshotBytes}` : '') +
      (r.canonicalBytes != null ? ` canonicalBytes=${r.canonicalBytes}` : '') +
      (r.targetP50Ms != null ? ` target=${fmtMs(r.targetP50Ms)} withinTarget=${r.withinTarget}` : '') +
      (r.deterministic != null ? ` deterministic=${r.deterministic}` : '') +
      (r.domUpdates != null ? ` domUpdates=${r.domUpdates}` : '') +
      (r.coalesceRatio != null ? ` coalesce=${r.coalesceRatio}` : ''),
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

  for (let t = 0; t < warmupTicks; t++) world.step(fixedStep)

  const samples = []
  for (let t = 0; t < ticks; t++) {
    const t0 = performance.now()
    world.step(fixedStep)
    samples.push(performance.now() - t0)
  }
  const { p50, p95 } = percentiles(samples)
  return {
    workload: 'soak',
    engine: 'domecs',
    entities: entityCount,
    ticks,
    p50Ms: p50,
    p95Ms: p95,
  }
}

/**
 * Telemetry firehose with genuine coalescing pressure: many updates per tick
 * repeatedly hitting a small hot subset, so multiple markChanged calls land
 * on the same entity+component within one tick. A reactive consumer counts
 * delivered change notifications; `coalesceRatio` = marks issued per change
 * delivered (≈ updatesPerTick / hotEntities when coalescing works).
 */
function runTelemetry({ entityCount, hotEntities, updatesPerTick, ticks }) {
  const world = createWorld({ headless: true })
  const ids = []
  for (let i = 0; i < entityCount; i++) {
    ids.push(world.spawn([entry(Telemetry, { value: 0, dirty: false })]))
  }
  const hot = ids.slice(0, Math.min(hotEntities, ids.length))
  let marksIssued = 0
  let changesDelivered = 0
  world.system('bench-firehose', { schedule: 'tick' }, () => {
    for (let k = 0; k < updatesPerTick; k++) {
      const id = hot[k % hot.length]
      const t = world.getComponent(id, Telemetry)
      if (!t) continue
      t.value += 1
      t.dirty = true
      world.markChanged(id, Telemetry)
      marksIssued++
    }
  })
  world.system(
    'bench-consume',
    { schedule: 'reactive', reactsTo: OnChanged(Telemetry) },
    ({ entities }) => {
      changesDelivered += entities.length
    },
  )

  for (let t = 0; t < warmupTicks; t++) world.step(1 / 60)
  marksIssued = 0
  changesDelivered = 0

  const samples = []
  for (let t = 0; t < ticks; t++) {
    const t0 = performance.now()
    world.step(1 / 60)
    samples.push(performance.now() - t0)
  }
  const { p50, p95 } = percentiles(samples)
  return {
    workload: 'telemetry',
    engine: 'domecs',
    entities: entityCount,
    hotEntities: hot.length,
    ticks,
    updatesPerTick,
    marksIssued,
    changesDelivered,
    coalesceRatio: changesDelivered > 0 ? Number((marksIssued / changesDelivered).toFixed(1)) : null,
    p50Ms: p50,
    p95Ms: p95,
  }
}

function registerSnapshotSystems(world) {
  world.system(
    'bench-move',
    { schedule: 'tick', query: [Position, Velocity] },
    ({ entities }) => {
      for (const e of entities) {
        e.BenchPosition.x += e.BenchVelocity.dx
        e.BenchPosition.y += e.BenchVelocity.dy
      }
    },
  )
  // A sub-base-rate fixed system: a restore that drops the accumulator or
  // the fixed-step phase fires it on different frames than the source.
  world.system(
    'bench-drift',
    { schedule: 'fixed', rateHz: 20, query: [Position] },
    ({ entities }) => {
      for (const e of entities) e.BenchPosition.x += 0.5
    },
  )
}

function runSnapshot({ entityCount, repeats }) {
  // Frame times that are not multiples of the 1/60 fixed step, so the
  // snapshot lands mid-accumulator and the determinism check exercises the
  // clock.
  const SNAPSHOT_DTS = [0.021, 1 / 144, 0.0333]
  const world = createWorld({ headless: true, seed: [1, 2, 3, 4] })
  registerSnapshotSystems(world)
  for (let i = 0; i < entityCount; i++) {
    world.spawn([
      entry(Position, { x: i, y: i * 2 }),
      entry(Velocity, { dx: 1, dy: -1 }),
    ])
  }
  for (let i = 0; i < 10; i++) world.step(SNAPSHOT_DTS[i % SNAPSHOT_DTS.length])

  // Warmed, repeated snapshot timing — a single cold call is not a percentile.
  for (let i = 0; i < 3; i++) world.snapshot()
  const samples = []
  let snap = null
  for (let i = 0; i < repeats; i++) {
    const t0 = performance.now()
    snap = world.snapshot()
    samples.push(performance.now() - t0)
  }
  const bytes = JSON.stringify(snap).length

  // Determinism proper: restore into a twin world with the SAME systems,
  // step both forward, and compare the resulting snapshots — a lossy
  // round-trip OR missing dynamic state (accumulator, clock) fails this.
  const world2 = createWorld({ headless: true, seed: [1, 2, 3, 4] })
  registerSnapshotSystems(world2)
  world2.restore(snap)
  for (let i = 0; i < 10; i++) {
    const dt = SNAPSHOT_DTS[(10 + i) % SNAPSHOT_DTS.length]
    world.step(dt)
    world2.step(dt)
  }
  // The clock is compared directly too: a lost accumulator does not always
  // change how many fixed steps land in a short window.
  const deterministic =
    JSON.stringify(world.snapshot()) === JSON.stringify(world2.snapshot()) &&
    world.time.elapsed === world2.time.elapsed &&
    world.time.fixedAccumulator === world2.time.fixedAccumulator

  const { p50, p95 } = percentiles(samples)
  return {
    workload: 'snapshot',
    engine: 'domecs',
    entities: entityCount,
    repeats,
    p50Ms: p50,
    p95Ms: p95,
    snapshotBytes: bytes,
    deterministic,
  }
}

/**
 * O-11 / spec §4.1: `hashSnapshot` (canonical JSON + FNV-1a-64) over a
 * 1000-entity snapshot of roughly the size the spec's target names
 * (~131 KB). Target p50 ≤ 2 ms on the reference host; informational, not a
 * gate. Reports the strict (`includeChanges`) hash time, which forks and
 * keyframes use, and checks the hash is stable across repeats.
 */
function runHash({ entityCount, repeats }) {
  const world = createWorld({ headless: true, seed: [1, 2, 3, 4] })
  registerSnapshotSystems(world)
  for (let i = 0; i < entityCount; i++) {
    world.spawn([
      entry(Position, { x: i * 0.5, y: -i * 1.25 }),
      entry(Velocity, { dx: (i % 7) - 3.5, dy: -0 }),
      entry(HashLabel, { name: `unit-${i}`, hp: 100 - (i % 50), tags: ['mobile', i % 2 ? 'red' : 'blue'] }),
    ])
  }
  for (let i = 0; i < 10; i++) world.step(1 / 60)
  const snap = world.snapshot()
  const bytes = JSON.stringify(snap).length
  const canonicalBytes = canonicalSnapshot(snap, { includeChanges: true }).length

  for (let i = 0; i < 5; i++) hashSnapshot(snap, { includeChanges: true })
  const samples = []
  let first = null
  let stable = true
  for (let i = 0; i < repeats; i++) {
    const t0 = performance.now()
    const h = hashSnapshot(snap, { includeChanges: true })
    samples.push(performance.now() - t0)
    if (first === null) first = h
    else if (h !== first) stable = false
  }
  const { p50, p95 } = percentiles(samples)
  const targetP50Ms = 2
  return {
    workload: 'hash',
    engine: 'domecs',
    entities: entityCount,
    repeats,
    p50Ms: p50,
    p95Ms: p95,
    snapshotBytes: bytes,
    canonicalBytes,
    targetP50Ms,
    withinTarget: p50 <= targetP50Ms,
    deterministic: stable,
  }
}

/**
 * Windowed projection: maintain a visible window of `windowSize` rows over
 * a larger entity set by add/remove of a Row component (fleet-shaped).
 * Counts synthetic DOM updates (create/update/destroy callbacks), no real DOM.
 * The priming step mounts the first window and advances windowStart to 3 and
 * is excluded from both timing and domUpdates — the koota/signals baselines
 * mirror this exactly so domUpdates is comparable across engines.
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

  // Prime first window + warmup (excluded from timing and counters)
  for (let t = 0; t < 1 + warmupTicks; t++) world.step(1 / 60)

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
    engine: 'domecs',
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
  const tickFn = () => {
    for (let i = 0; i < entityCount; i++) {
      xs[i] += dx[i]
      ys[i] += dy[i]
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
    workload: 'baseline-plain',
    engine: 'plain',
    entities: entityCount,
    ticks,
    p50Ms: p50,
    p95Ms: p95,
    note: 'hand-rolled Float64Array loops; not feature-equivalent',
  }
}

// --- compare --------------------------------------------------------------------

/** One row per engine/workload: median p50/p95 across trials, with spread. */
function aggregateTrials(rows) {
  const med = (xs) => {
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.floor((s.length - 1) / 2)]
  }
  const p95s = rows.map((r) => r.p95Ms)
  return {
    ...rows[0],
    trials: rows.length,
    p50Ms: med(rows.map((r) => r.p50Ms)),
    p95Ms: med(p95s),
    p95RangeMs: [Math.min(...p95s), Math.max(...p95s)],
  }
}

/**
 * Derives the verdict ONLY from the compare-phase rows passed in: ratios of
 * median p95s, with the per-trial range. A win must clear the bar in every
 * trial (O-72).
 */
function summarizeComparison(compareRows, trials) {
  const pick = (name) => compareRows.find((r) => r.workload === name)
  const soak = {
    domecs: pick('soak'),
    koota: pick('koota-soak'),
    signals: pick('signals-soak'),
  }
  const windowed = {
    domecs: pick('windowed'),
    koota: pick('koota-windowed'),
    signals: pick('signals-windowed'),
  }
  const ratio = (a, b) =>
    a && b && b.p95Ms > 0 ? Number((a.p95Ms / b.p95Ms).toFixed(3)) : null

  const pairs = {
    soak_domecs_vs_koota_p95: ['soak', 'koota-soak'],
    soak_domecs_vs_signals_p95: ['soak', 'signals-soak'],
    windowed_domecs_vs_koota_p95: ['windowed', 'koota-windowed'],
    windowed_domecs_vs_signals_p95: ['windowed', 'signals-windowed'],
  }
  const verdict = {
    soak_domecs_vs_koota_p95: ratio(soak.domecs, soak.koota),
    soak_domecs_vs_signals_p95: ratio(soak.domecs, soak.signals),
    windowed_domecs_vs_koota_p95: ratio(windowed.domecs, windowed.koota),
    windowed_domecs_vs_signals_p95: ratio(windowed.domecs, windowed.signals),
  }
  const verdictRange = {}
  for (const [k, [a, b]] of Object.entries(pairs)) {
    const rs = trials
      .map((rows) => ratio(rows.find((r) => r.workload === a), rows.find((r) => r.workload === b)))
      .filter((r) => r != null)
    verdictRange[k] = rs.length > 0 ? [Math.min(...rs), Math.max(...rs)] : null
  }

  // Work-equivalence check: the three windowed harnesses must report the
  // same domUpdates for the same logical work, or the timing comparison is
  // comparing different work.
  const domUpdateCounts = [windowed.domecs, windowed.koota, windowed.signals]
    .filter(Boolean)
    .map((r) => r.domUpdates)
  const windowedWorkEqual =
    domUpdateCounts.length === 3 && domUpdateCounts.every((n) => n === domUpdateCounts[0])

  // Success bar: ≥30% better p95 means ratio ≤ 0.70 vs competitor — in
  // every trial, not just the median.
  const wins = []
  for (const [k, range] of Object.entries(verdictRange)) {
    if (range && range[1] <= 0.7) wins.push(`${k} (${range[0]}–${range[1]}×)`)
  }

  return {
    workload: 'compare-summary',
    engine: 'meta',
    entities: compareN,
    p50Ms: 0,
    p95Ms: 0,
    trials: trials.length,
    verdict,
    verdictRange,
    windowedWorkEqual,
    windowedDomUpdates: domUpdateCounts,
    decisiveRuntimeWins: wins,
    note:
      (windowedWorkEqual ? '' : 'WARNING: windowed domUpdates differ across engines — timings are not comparing equal work. ') +
      (wins.length > 0
        ? `Decisive runtime win(s): ${wins.join('; ')}`
        : `No runtime win clearing ≥30% p95 in all ${trials.length} trials on this host; check plumbing comparison in bench/COMPARISON.md`),
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
