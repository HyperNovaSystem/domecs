import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { dmath } from '../src/index.js'

// O-75 / spec §4.2: `dmath` is a straight-line port of musl libm's
// sin/cos (generic C, no FMA). It must stay within 1 ulp of the platform's
// `Math.*` (the port-fidelity check; spec §11 risk 1), follow C99 Annex F
// on special values, and match the committed golden vectors bit for bit.

const buf = new DataView(new ArrayBuffer(8))

function bitsOf(x: number): bigint {
  buf.setFloat64(0, x, true)
  return buf.getBigUint64(0, true)
}

function fromBits(b: bigint): number {
  buf.setBigUint64(0, b, true)
  return buf.getFloat64(0, true)
}

function hex(x: number): string {
  return bitsOf(x).toString(16).padStart(16, '0')
}

function fromWords(hi: number, lo: number): number {
  buf.setUint32(4, hi >>> 0, true)
  buf.setUint32(0, lo >>> 0, true)
  return buf.getFloat64(0, true)
}

const SIGN = 1n << 63n

/** Distance in representable doubles (±0 count as one point). */
function ulpDistance(a: number, b: number): bigint {
  if (Number.isNaN(a) && Number.isNaN(b)) return 0n
  if (Number.isNaN(a) || Number.isNaN(b)) return 1n << 62n
  const ord = (x: number): bigint => {
    const bits = bitsOf(x)
    return bits & SIGN ? -(bits & ~SIGN) : bits
  }
  const d = ord(a) - ord(b)
  return d < 0n ? -d : d
}

/** mulberry32: a tiny seeded generator for test inputs only. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }
}

const HALF_PI = fromWords(0x3ff921fb, 0x54442d18)

/** 100k inputs spread over the ranges sims use and the ones argument reduction must survive. */
function seededInputs(seed: number, count: number): number[] {
  const next = rng(seed)
  const unit = (): number => next() / 0x100000000
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const bucket = i % 10
    let x: number
    if (bucket < 4) {
      x = (unit() * 2 - 1) * 4 * Math.PI // the everyday range
    } else if (bucket < 6) {
      x = (unit() * 2 - 1) * 1000
    } else if (bucket < 8) {
      // random finite bit pattern: every exponent from tiny to 2^1023
      const sign = next() & 1
      const exp = next() % 2047 // 0 (subnormal) .. 2046
      x = fromWords((sign << 31) | (exp << 20) | (next() & 0xfffff), next())
    } else if (bucket < 9) {
      // near multiples of pi/2 (cancellation in the reduction)
      const k = next() % (1 << 22)
      const base = k * HALF_PI
      const nudge = (next() % 9) - 4
      x = fromBits(bitsOf(base) + BigInt(nudge))
      if (next() & 1) x = -x
    } else {
      x = (unit() * 2 - 1) * (1 << 20) * HALF_PI // the medium reduction path
    }
    out.push(x)
  }
  return out
}

describe('dmath: shape', () => {
  it('is a frozen namespace exported from core', () => {
    expect(Object.isFrozen(dmath)).toBe(true)
    expect(typeof dmath.sin).toBe('function')
    expect(typeof dmath.cos).toBe('function')
    expect(typeof dmath.sqrt).toBe('function')
  })
})

describe('dmath: accuracy against Math.* (port fidelity, <= 1 ulp)', () => {
  for (const name of ['sin', 'cos'] as const) {
    it(`${name}: 100k seeded inputs within 1 ulp`, () => {
      const inputs = seededInputs(name === 'sin' ? 0x5eed51 : 0x5eedc0, 100_000)
      let worst = 0n
      let worstInput = 0
      let differing = 0
      for (const x of inputs) {
        const d = ulpDistance(dmath[name](x), Math[name](x))
        if (d > 0n) differing++
        if (d > worst) {
          worst = d
          worstInput = x
        }
      }
      expect(
        worst,
        `worst ${name}(${worstInput}) [0x${hex(worstInput)}] off by ${worst} ulp (${differing} inputs differ)`,
      ).toBeLessThanOrEqual(1n)
    })
  }

  it('sqrt is Math.sqrt bit for bit', () => {
    for (const x of seededInputs(0x5eed59, 10_000)) {
      expect(Object.is(dmath.sqrt(x), Math.sqrt(x))).toBe(true)
    }
    expect(Object.is(dmath.sqrt(-0), -0)).toBe(true)
    expect(Number.isNaN(dmath.sqrt(-1))).toBe(true)
  })

  it('sin is odd and cos is even, bit for bit', () => {
    for (const x of seededInputs(0x0dd, 20_000)) {
      expect(hex(dmath.sin(-x))).toBe(hex(-dmath.sin(x)))
      expect(hex(dmath.cos(-x))).toBe(hex(dmath.cos(x)))
    }
  })
})

describe('dmath: special values (C99 Annex F)', () => {
  it('signed zeros', () => {
    expect(Object.is(dmath.sin(0), 0)).toBe(true)
    expect(Object.is(dmath.sin(-0), -0)).toBe(true)
    expect(dmath.cos(0)).toBe(1)
    expect(dmath.cos(-0)).toBe(1)
  })

  it('infinities and NaN give NaN', () => {
    for (const x of [Infinity, -Infinity, NaN]) {
      expect(Number.isNaN(dmath.sin(x))).toBe(true)
      expect(Number.isNaN(dmath.cos(x))).toBe(true)
    }
  })

  it('subnormals and tiny normals: sin(x) = x, cos(x) = 1 below 2^-27', () => {
    const tiny = [
      Number.MIN_VALUE,
      fromWords(0x000fffff, 0xffffffff), // largest subnormal
      fromWords(0x00080000, 0x00000000),
      fromWords(0x00100000, 0x00000000), // smallest normal
      fromWords(0x3e400000, 0x00000000), // 2^-27
      fromWords(0x3e4fffff, 0xffffffff), // just under 2^-26
    ]
    for (const t of tiny) {
      for (const x of [t, -t]) {
        expect(hex(dmath.sin(x))).toBe(hex(x))
        // cos(x) rounds to 1 only below 2^-27 * sqrt(2); cos(2^-26) is 1 - 2^-53
        if (Math.abs(x) <= 2 ** -27) expect(dmath.cos(x)).toBe(1)
      }
    }
  })

  it('reference values from correctly rounded libm results', () => {
    expect(dmath.sin(HALF_PI)).toBe(1)
    expect(dmath.cos(Math.PI)).toBe(-1)
    expect(dmath.sin(Math.PI)).toBe(1.2246467991473532e-16)
    expect(dmath.cos(HALF_PI)).toBe(6.123233995736766e-17)
    expect(dmath.sin(1)).toBe(0.8414709848078965)
    expect(dmath.cos(1)).toBe(0.5403023058681398)
    // Payne-Hanek path: sin(1e22) is a classic reduction test value.
    expect(dmath.sin(1e22)).toBe(-0.8522008497671888)
  })

  it('multiples and near-multiples of pi/2 up to 2^1023 stay within 1 ulp', () => {
    const xs: number[] = []
    for (let k = 1; k <= 2000; k++) xs.push(k * HALF_PI)
    for (let e = 0; e <= 1023; e++) {
      const p = fromWords((0x3ff + e) << 20, 0)
      xs.push(p)
      if (Number.isFinite(p * HALF_PI)) xs.push(p * HALF_PI)
    }
    xs.push(Number.MAX_VALUE, fromWords(0x7fe00000, 0)) // 2^1023
    for (const base of xs) {
      for (const nudge of [-1n, 0n, 1n]) {
        const x = fromBits(bitsOf(base) + nudge)
        if (!Number.isFinite(x)) continue
        expect(ulpDistance(dmath.sin(x), Math.sin(x)), `sin(0x${hex(x)})`).toBeLessThanOrEqual(1n)
        expect(ulpDistance(dmath.cos(x), Math.cos(x)), `cos(0x${hex(x)})`).toBeLessThanOrEqual(1n)
      }
    }
  })
})

const VECTORS = new URL('../../../test/golden/dmath-vectors.json', import.meta.url)

describe('dmath: golden vectors (pin the port bit for bit)', () => {
  it('matches every committed vector', () => {
    expect(existsSync(VECTORS), 'run `node scripts/dmath-golden.mjs --write`').toBe(true)
    const golden = JSON.parse(readFileSync(VECTORS, 'utf8')) as {
      functions: string[]
      vectors: string[][]
    }
    expect(golden.functions).toEqual(['sin', 'cos'])
    expect(golden.vectors.length).toBeGreaterThanOrEqual(3000)
    // "nan" stands for any NaN: engines may differ in NaN sign/payload.
    const enc = (v: number): string => (Number.isNaN(v) ? 'nan' : hex(v))
    const mismatches: string[] = []
    for (const [xHex, sinHex, cosHex] of golden.vectors as [string, string, string][]) {
      const x = xHex === 'nan' ? NaN : fromBits(BigInt(`0x${xHex}`))
      if (enc(dmath.sin(x)) !== sinHex) mismatches.push(`sin(0x${xHex})`)
      if (enc(dmath.cos(x)) !== cosHex) mismatches.push(`cos(0x${xHex})`)
    }
    expect(mismatches.slice(0, 10)).toEqual([])
  })
})
