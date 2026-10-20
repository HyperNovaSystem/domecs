#!/usr/bin/env node
/**
 * Headless DOMECS micro-benchmarks (PLAN WS-1 / FINDINGS O-14).
 *
 * Imports built ESM from packages/{name}/dist. Workspace package.json exports
 * still point at TypeScript source for monorepo DX, so we import dist by file
 * URL rather than package name (avoids resolving @domecs scope to src/).
 *
 * Methodology (frozen 2026-10-20, PLAN WS-5 A0):
 * - `pnpm bench` builds @domecs/core first. Run directly, this script
 *   refuses a dist whose index.js is older than any file in src (an mtime
 *   heuristic; --allow-stale overrides). The build-first script is the real
 *   guarantee.
 * - Every workload runs `--warmup` unmeasured ticks first (default 30) so
 *   p50/p95 describe warmed steady state, not JIT/IC cold-start.
 * - Every measured tick loop goes through measureTicks() (bench/measure.mjs):
 *   per-tick timing plus, via v8.GCProfiler, allocation per tick and the GC
 *   count and pause time inside the window.
 * - Soak is like-for-like: each engine records every change and a reader
 *   consumes them (DOMECS markChanged + an OnChanged reader; Koota
 *   changeDetection 'auto' + a world.onChange reader). In every trial both
 *   must deliver entities × ticks changes, or no win is declared.
 * - When Node is started with --expose-gc, a full GC runs between workloads
 *   so one engine's garbage is not attributed to the next; `gcBetween` in
 *   the summary records whether that isolation was active. All engines
 *   still share one process — child-process-per-engine is the stronger
 *   isolation if numbers look noisy.
 * - Compare-mode rows are tagged `phase: 'compare'` and the verdict is
 *   computed ONLY from those rows, so a standalone soak at a different
 *   entity count can never leak into the ratios.
 * - Verdict: per trial, the paired ratio DOMECS p95 / competitor p95. The
 *   headline is the median ratio with a seeded bootstrap 95% CI over
 *   trials; a decisive win needs the CI's upper bound ≤ 0.70.
 *
 * Usage:
 *   pnpm bench                      # builds @domecs/core, then runs all
 *   node --expose-gc bench/run.mjs  # assumes a fresh build
 *   node bench/run.mjs --workload soak|telemetry|snapshot|windowed|baseline|compare|all
 *   node bench/run.mjs --entities 20000 --ticks 200 --warmup 50
 *   node bench/run.mjs --workload compare --trials 9   # compare trials (default 7)
 *   node bench/run.mjs --write   # also write bench/results.json
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { runKootaSoak, runKootaWindowed } from './baselines/koota.mjs'
import { runSignalsSoak, runSignalsWindowed } from './baselines/signals.mjs'
import { bootstrapMedianCI, measureTicks, median, percentiles } from './measure.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distEntry = join(root, 'packages/domecs/dist/index.js')
if (!existsSync(distEntry)) {
  console.error('[bench] packages/domecs/dist not found.')
  console.error('[bench] Build @domecs/core first:  pnpm --filter @domecs/core build')
  process.exit(1)
}
// A dist older than src measures code that no longer exists (the stale-dist
// bug the 2026-10-20 audit found). `pnpm bench` builds first.
if (!process.argv.includes('--allow-stale')) {
  const newestSrc = newestMtime(join(root, 'packages/domecs/src'))
  if (newestSrc > statSync(distEntry).mtimeMs) {
    console.error('[bench] packages/domecs/dist is older than src. Run `pnpm bench` (it builds first),')
    console.error('[bench] or `pnpm --filter @domecs/core build`, or pass --allow-stale.')
    process.exit(1)
  }
}
const { createWorld, defineComponent, entry, OnChanged } = await import(
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
const compareTrials = Math.max(1, Number(args.trials ?? 7))
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
      (r.deterministic != null ? ` deterministic=${r.deterministic}` : '') +
      (r.domUpdates != null ? ` domUpdates=${r.domUpdates}` : '') +
      (r.changesDelivered != null ? ` changes=${r.changesDelivered}` : '') +
      (r.allocBytesPerTick != null ? ` alloc=${r.allocBytesPerTick}B/tick gc=${r.gcCount}/${r.gcMs}ms` : '') +
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

/**
 * Entity soak, like-for-like with the Koota baseline: every entity moves and
 * is marked changed each tick, and a reader consumes the changes.
 */
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
  let changesDelivered = 0
  world.system(
    'bench-read-changes',
    { schedule: 'reactive', reactsTo: OnChanged(Position) },
    ({ entities }) => {
      changesDelivered += entities.length
    },
  )
  for (let i = 0; i < entityCount; i++) {
    world.spawn([
      entry(Position, { x: i % 100, y: (i * 3) % 100 }),
      entry(Velocity, { dx: 0.01, dy: -0.02 }),
    ])
  }

  for (let t = 0; t < warmupTicks; t++) world.step(fixedStep)
  changesDelivered = 0

  const measured = measureTicks(() => world.step(fixedStep), ticks)
  return {
    workload: 'soak',
    engine: 'domecs',
    entities: entityCount,
    ticks,
    ...measured,
    changesDelivered,
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

  const measured = measureTicks(() => world.step(1 / 60), ticks)
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
    ...measured,
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

  const dom = { create: 0, update: 0, remove: 0 }
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
        dom.remove++
        visible.delete(id)
      }
    }
    for (const id of next) {
      if (!visible.has(id)) {
        world.addComponent(id, Row, { rank: 0, label: String(id) })
        dom.create++ // create + first paint
        visible.add(id)
      } else {
        const r = world.getComponent(id, Row)
        if (r) {
          r.rank = (r.rank + 1) % 1000
          world.markChanged(id, Row)
          dom.update++
        }
      }
    }
    windowStart = (windowStart + 3) % ids.length
  })

  // Prime first window + warmup (excluded from timing and counters)
  for (let t = 0; t < 1 + warmupTicks; t++) world.step(1 / 60)
  Object.assign(dom, { create: 0, update: 0, remove: 0 })

  const measured = measureTicks(() => world.step(1 / 60), ticks)
  return {
    workload: 'windowed',
    engine: 'domecs',
    entities: entityCount,
    ticks,
    windowSize,
    ...measured,
    domUpdates: dom.create + dom.update + dom.remove,
    domSplit: { ...dom },
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

  const measured = measureTicks(tickFn, ticks)
  return {
    workload: 'baseline-plain',
    engine: 'plain',
    entities: entityCount,
    ticks,
    ...measured,
    note: 'hand-rolled Float64Array loops; not feature-equivalent',
  }
}

// --- compare --------------------------------------------------------------------

/** One row per engine/workload: median p50/p95 across trials, with spread. */
function aggregateTrials(rows) {
  const p95s = rows.map((r) => r.p95Ms)
  const out = {
    ...rows[0],
    trials: rows.length,
    p50Ms: median(rows.map((r) => r.p50Ms)),
    p95Ms: median(p95s),
    p95RangeMs: [Math.min(...p95s), Math.max(...p95s)],
  }
  for (const key of ['allocBytesPerTick', 'gcCount', 'gcMs']) {
    if (rows.every((r) => typeof r[key] === 'number')) out[key] = median(rows.map((r) => r[key]))
  }
  return out
}

/**
 * Derives the verdict ONLY from the compare-phase rows passed in. Per trial,
 * the paired ratio DOMECS p95 / competitor p95; the headline is the median
 * ratio with a seeded bootstrap 95% CI, and a decisive win needs the CI's
 * upper bound ≤ 0.70 (PLAN WS-5). The per-trial range is kept for context.
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
  // Full precision through the decision; round only for display, so a true
  // 0.7004 can never round down into a win.
  const ratio = (a, b) => (a && b && b.p95Ms > 0 ? a.p95Ms / b.p95Ms : null)
  const round3 = (x) => Number(x.toFixed(3))

  const pairs = {
    soak_domecs_vs_koota_p95: ['soak', 'koota-soak'],
    soak_domecs_vs_signals_p95: ['soak', 'signals-soak'],
    windowed_domecs_vs_koota_p95: ['windowed', 'koota-windowed'],
    windowed_domecs_vs_signals_p95: ['windowed', 'signals-windowed'],
  }
  const verdict = {}
  const verdictRange = {}
  for (const [k, [a, b]] of Object.entries(pairs)) {
    const rs = trials
      .map((rows) => ratio(rows.find((r) => r.workload === a), rows.find((r) => r.workload === b)))
      .filter((r) => r != null)
    const ci = bootstrapMedianCI(rs)
    verdict[k] = ci ? { median: round3(ci.median), ci95: ci.ci95.map(round3), ciHigh: ci.ci95[1] } : null
    verdictRange[k] = rs.length > 0 ? [round3(Math.min(...rs)), round3(Math.max(...rs))] : null
  }

  // Work equivalence, checked in every trial: DOMECS and Koota must each
  // deliver entities × ticks changes to their soak readers, and the three
  // windowed harnesses must report the same DOM work. A failed check voids
  // any win, since the timings would compare different work.
  const soakWorkEqual = trials.every((rows) => {
    const d = rows.find((r) => r.workload === 'soak')
    const kt = rows.find((r) => r.workload === 'koota-soak')
    const expected = d ? d.entities * d.ticks : NaN
    return d != null && kt != null && d.changesDelivered === expected && kt.changesDelivered === expected
  })

  // Work-equivalence check: the three windowed harnesses must report the
  // same domUpdates for the same logical work, or the timing comparison is
  // comparing different work.
  const domUpdateCounts = [windowed.domecs, windowed.koota, windowed.signals]
    .filter(Boolean)
    .map((r) => r.domUpdates)
  const windowedWorkEqual = trials.every((rows) => {
    const splits = ['windowed', 'koota-windowed', 'signals-windowed']
      .map((w) => rows.find((r) => r.workload === w)?.domSplit)
      .map((s) => (s ? JSON.stringify(s) : null))
    return splits.every((s) => s !== null && s === splits[0])
  })

  // Success bar: ≥30% better p95 means ratio ≤ 0.70 vs competitor, with
  // the bootstrap CI's upper bound under the bar, not just the median.
  const wins = []
  for (const [k, v] of Object.entries(verdict)) {
    const comparable = k.startsWith('soak_') ? soakWorkEqual : windowedWorkEqual
    if (v && comparable && v.ciHigh <= 0.7) wins.push(`${k} (median ${v.median}×, CI ${v.ci95[0]}–${v.ci95[1]}×)`)
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
    soakWorkEqual,
    soakChangesDelivered: [soak.domecs?.changesDelivered, soak.koota?.changesDelivered],
    windowedWorkEqual,
    windowedDomUpdates: domUpdateCounts,
    decisiveRuntimeWins: wins,
    note:
      (soakWorkEqual ? '' : 'WARNING: soak changesDelivered differ between DOMECS and Koota — timings are not comparing equal work. ') +
      (windowedWorkEqual ? '' : 'WARNING: windowed domUpdates differ across engines — timings are not comparing equal work. ') +
      (wins.length > 0
        ? `Decisive runtime win(s): ${wins.join('; ')}`
        : `No runtime win with a bootstrap CI under 0.70× p95 over ${trials.length} trials on this host; check plumbing comparison in bench/COMPARISON.md`),
  }
}

// --- utils --------------------------------------------------------------------

/** Newest file mtime under `dir`, recursively. */
function newestMtime(dir) {
  let newest = 0
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const st = statSync(path)
    newest = Math.max(newest, st.isDirectory() ? newestMtime(path) : st.mtimeMs)
  }
  return newest
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
