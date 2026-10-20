/**
 * bench/measure.mjs: the verdict statistics the frozen bench protocol
 * relies on (PLAN WS-5 A0).
 */
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { bootstrapMedianCI, measureTicks, median, percentiles } from '../bench/measure.mjs'

describe('bench/measure.mjs', () => {
  it('median takes the lower middle for even lengths', () => {
    assert.equal(median([3, 1, 2]), 2)
    assert.equal(median([4, 1, 3, 2]), 2)
  })

  it('percentiles use nearest rank on the sorted samples', () => {
    const xs = Array.from({ length: 101 }, (_, i) => 100 - i)
    assert.deepEqual(percentiles(xs), { p50: 50, p95: 95 })
  })

  it('bootstrapMedianCI is reproducible and brackets the median', () => {
    const ratios = [0.9, 1.1, 1.0, 1.2, 0.95, 1.05, 1.3]
    const a = bootstrapMedianCI(ratios)
    const b = bootstrapMedianCI(ratios)
    assert.deepEqual(a, b)
    assert.equal(a.median, 1.05)
    assert.ok(a.ci95[0] <= a.median && a.median <= a.ci95[1])
    assert.ok(a.ci95[0] >= 0.9 && a.ci95[1] <= 1.3)
  })

  it('bootstrapMedianCI collapses to the value when every trial agrees', () => {
    assert.deepEqual(bootstrapMedianCI([0.6, 0.6, 0.6]), { median: 0.6, ci95: [0.6, 0.6] })
    assert.equal(bootstrapMedianCI([]), null)
  })

  it('measureTicks reports timing and, when available, allocation and GC', () => {
    let sink = []
    const row = measureTicks(() => {
      sink = Array.from({ length: 1000 }, (_, i) => ({ i }))
    }, 20)
    assert.ok(row.p95Ms >= row.p50Ms && row.p50Ms >= 0)
    if ('allocBytesPerTick' in row) {
      assert.ok(row.allocBytesPerTick > 0)
      assert.ok(row.gcCount >= 0 && row.gcMs >= 0)
    }
    assert.equal(sink.length, 1000)
  })
})
