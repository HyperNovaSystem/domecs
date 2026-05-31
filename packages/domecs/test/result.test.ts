import { describe, expect, it } from 'vitest'
import { type Result, err, isErr, isOk, ok, tap, tapErr } from '../src/result.js'

describe('isOk / isErr narrow both branches (L4)', () => {
  // These functions only compile if the type guards narrow the *negative*
  // branch too: after `if (isErr(r)) return`, `r` must be the Ok arm (so
  // `r.value` is reachable), and vice-versa. The guards returned bare inline
  // predicate types before, which left `r` as the full union on the false
  // branch — a Result whose guards don't narrow is not legible.
  function takeValue(r: Result<number, string>): number {
    if (isErr(r)) return -1
    return r.value
  }
  function takeError(r: Result<number, string>): string {
    if (!isOk(r)) return r.error
    return String(r.value)
  }
  it('isErr false-branch narrows to Ok', () => {
    expect(takeValue(ok(7))).toBe(7)
    expect(takeValue(err('x'))).toBe(-1)
  })
  it('isOk false-branch narrows to Err', () => {
    expect(takeError(err('boom'))).toBe('boom')
    expect(takeError(ok(3))).toBe('3')
  })
})

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
