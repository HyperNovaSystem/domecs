import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../src/canonical.js'

// O-11 / spec §4.1: canonical JSON is JSON.stringify value semantics with
// object keys sorted by UTF-16 code unit, a lossless `-0`, and TypeErrors
// that name the offending path.

describe('canonicalJson', () => {
  it('sorts object keys by UTF-16 code unit at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
    // Code-unit order, not locale or numeric order: "10" < "2", "Z" < "a",
    // and an astral character (surrogate pair, 0xD83D…) sorts before U+FF5E.
    expect(canonicalJson({ 2: 'x', 10: 'y', a: 0, Z: 0 })).toBe('{"10":"y","2":"x","Z":0,"a":0}')
    expect(canonicalJson({ '～': 1, '\u{1F600}': 2 })).toBe('{"\u{1F600}":2,"～":1}')
  })

  it('matches JSON.stringify value semantics for undefined, functions and symbols', () => {
    const value = { a: undefined, f: () => 1, s: Symbol('s'), arr: [undefined, () => 1, Symbol('t'), 1] }
    expect(canonicalJson(value)).toBe('{"arr":[null,null,null,1]}')
    expect(canonicalJson([])).toBe('[]')
    expect(canonicalJson({})).toBe('{}')
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(true)).toBe('true')
    expect(canonicalJson('he said "hi"\n')).toBe(JSON.stringify('he said "hi"\n'))
    // Well-formed escaping of a lone surrogate.
    expect(canonicalJson('\ud800')).toBe('"\\ud800"')
  })

  it('writes numbers with Number::toString, except -0 which stays -0', () => {
    for (const n of [0, 1, -1, 0.1, 1e21, 1e-7, 123456789.125, Number.MAX_SAFE_INTEGER, 5e-324]) {
      expect(canonicalJson(n)).toBe(JSON.stringify(n))
    }
    expect(canonicalJson(-0)).toBe('-0')
    expect(canonicalJson({ a: -0 })).toBe('{"a":-0}')
    expect(canonicalJson([0, -0])).toBe('[0,-0]')
  })

  it('round-trips losslessly through JSON.parse, -0 included', () => {
    const values: unknown[] = [
      { a: -0, b: [1, -0, [0, -0, { c: -0 }]], d: undefined, e: 'x' },
      [[-0], { z: [{ y: -0, x: null }] }],
      -0,
    ]
    for (const x of values) {
      const once = canonicalJson(x)
      expect(canonicalJson(JSON.parse(once))).toBe(once)
    }
    expect(Object.is((JSON.parse(canonicalJson({ a: -0 })) as { a: number }).a, -0)).toBe(true)
    // JSON.stringify is not lossless: it drops the sign.
    expect(canonicalJson(JSON.parse(JSON.stringify({ a: -0 })))).not.toBe(canonicalJson({ a: -0 }))
  })

  it('throws a TypeError naming the path of a non-finite number', () => {
    expect(() => canonicalJson({ a: { b: [0, 1, NaN] } })).toThrow(TypeError)
    expect(() => canonicalJson({ a: { b: [0, 1, NaN] } })).toThrow('"a.b[2]"')
    expect(() => canonicalJson({ a: Infinity })).toThrow('"a"')
    expect(() => canonicalJson([{ x: -Infinity }])).toThrow('"[0].x"')
    expect(() => canonicalJson({ 'not ident': [NaN] })).toThrow('["not ident"][0]')
    expect(() => canonicalJson(NaN)).toThrow(TypeError)
  })

  it('throws a TypeError for BigInt and for cycles, but accepts shared references', () => {
    expect(() => canonicalJson({ n: 1n })).toThrow(TypeError)
    expect(() => canonicalJson({ n: 1n })).toThrow('"n"')
    const cyc: Record<string, unknown> = { a: 1 }
    cyc.self = cyc
    expect(() => canonicalJson(cyc)).toThrow(TypeError)
    const arr: unknown[] = []
    arr.push({ back: arr })
    expect(() => canonicalJson(arr)).toThrow(TypeError)
    const shared = { k: 1 }
    expect(canonicalJson({ a: shared, b: [shared] })).toBe('{"a":{"k":1},"b":[{"k":1}]}')
  })

  it('throws a TypeError for a top-level value with no JSON text', () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError)
    expect(() => canonicalJson(() => 1)).toThrow(TypeError)
  })
})
