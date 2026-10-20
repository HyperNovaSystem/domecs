/**
 * Shared measurement for bench/run.mjs and the baselines (PLAN WS-5 A0).
 *
 * Every engine's measured loop goes through measureTicks(), so timing,
 * allocation and GC numbers are collected the same way for all of them.
 */
import { performance } from 'node:perf_hooks'
import v8 from 'node:v8'

/** p50/p95 by nearest rank over the sorted samples. */
export function percentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (p) => {
    if (sorted.length === 0) return 0
    return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]
  }
  return { p50: at(0.5), p95: at(0.95) }
}

/**
 * Runs `tickFn` `ticks` times, timing each call. With v8.GCProfiler
 * available it also reports allocation per tick (heap growth plus what each
 * GC reclaimed, so collections inside the window are counted) and the GC
 * count and pause time inside the window.
 */
export function measureTicks(tickFn, ticks) {
  const Profiler = v8.GCProfiler
  const profiler = Profiler ? new Profiler() : null
  const startUsed = v8.getHeapStatistics().used_heap_size
  profiler?.start()
  const samples = []
  for (let t = 0; t < ticks; t++) {
    const t0 = performance.now()
    tickFn()
    samples.push(performance.now() - t0)
  }
  // Read the endpoint before stop(): building the GC report allocates, and
  // those bytes are not the workload's.
  const endUsed = v8.getHeapStatistics().used_heap_size
  const gcData = profiler?.stop()
  const { p50, p95 } = percentiles(samples)
  const row = { p50Ms: p50, p95Ms: p95 }
  if (gcData) {
    let allocated = 0
    let previous = startUsed
    let gcMicros = 0
    for (const gc of gcData.statistics) {
      allocated += gc.beforeGC.heapStatistics.usedHeapSize - previous
      previous = gc.afterGC.heapStatistics.usedHeapSize
      gcMicros += gc.cost
    }
    allocated += endUsed - previous
    row.allocBytesPerTick = Math.round(allocated / ticks)
    row.gcCount = gcData.statistics.length
    row.gcMs = Number((gcMicros / 1000).toFixed(3))
  }
  return row
}

/** Median of a numeric array (lower middle for even lengths). */
export function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]
}

/** Seeded PRNG (mulberry32), so a bootstrap is reproducible run to run. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Median of `ratios` with a percentile-bootstrap 95% confidence interval
 * (resampling the trials with replacement). Seeded, so the same ratios
 * always give the same interval.
 */
export function bootstrapMedianCI(ratios, { resamples = 5000, seed = 0x5eed } = {}) {
  if (ratios.length === 0) return null
  const rand = mulberry32(seed)
  const medians = []
  for (let i = 0; i < resamples; i++) {
    const draw = []
    for (let j = 0; j < ratios.length; j++) draw.push(ratios[Math.floor(rand() * ratios.length)])
    medians.push(median(draw))
  }
  medians.sort((a, b) => a - b)
  const at = (p) => medians[Math.min(medians.length - 1, Math.floor(p * medians.length))]
  return { median: median(ratios), ci95: [at(0.025), at(0.975)] }
}
