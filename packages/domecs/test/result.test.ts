import { describe, expect, it } from 'vitest'
import { err, ok, tap, tapErr } from '../src/result.js'

describe('tap / tapErr — side-effect combinators (review #5)', () => {
  it('tap runs the fn on Ok and returns the same Result reference', () => {
    const seen: number[] = []
    const r = ok(42)
    const out = tap(r, (v) => seen.push(v))
    expect(seen).toEqual([42])
    expect(out).toBe(r)
  })

  it('tap does not run the fn on Err', () => {
    let ran = false
    const r = err('boom')
    const out = tap(r, () => {
      ran = true
    })
    expect(ran).toBe(false)
    expect(out).toBe(r)
  })

  it('tapErr runs the fn on Err and returns the same Result reference', () => {
    const seen: string[] = []
    const r = err('boom')
    const out = tapErr(r, (e) => seen.push(e))
    expect(seen).toEqual(['boom'])
    expect(out).toBe(r)
  })

  it('tapErr does not run the fn on Ok', () => {
    let ran = false
    const r = ok(1)
    const out = tapErr(r, () => {
      ran = true
    })
    expect(ran).toBe(false)
    expect(out).toBe(r)
  })

  it('both are chainable and preserve the value/error type', () => {
    const log: string[] = []
    const r = tapErr(
      tap(ok(7), (v) => log.push(`ok:${v}`)),
      () => log.push('err'),
    )
    expect(log).toEqual(['ok:7'])
    expect(r.ok && r.value).toBe(7)
  })
})
