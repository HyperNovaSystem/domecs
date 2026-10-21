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

/**
 * Inputs that reach rare `__rem_pio2` / `__rem_pio2_large` branches the
 * seeded spreads miss (found by mutation testing; each output checked bit for
 * bit against musl compiled with -ffp-contract=off). Breaking the branch makes
 * the result wrong by up to 2^63 ulp (recomputation, q0 = 2 mask) or by 1 ulp
 * (3rd medium round, z >= 2^24 split), which the 100k spread never notices.
 * Keep in step with section 5 of scripts/dmath-golden.mjs.
 */
const RARE_BRANCH_INPUTS = [
  '41260b1c3fbf40c2', // medium reduction: 3rd round (ex - ey > 49)
  '7506ac5b262ca1ff', // __rem_pio2_large: z == 0 after 1 - q, recomputation
  '447c54308a31bb16', //   "
  '4d7c5c46c14b5e3d', //   "
  '4480f0cf064dd58a', // __rem_pio2_large: q0 == 2 mask after 1 - q
  '430971c7a14c731d', //   "
  '46051a06ed191c9d', //   "
  '413cc07e17154ca7', // __rem_pio2_large: final z >= 2^24 split
]

describe('dmath: rare argument-reduction branches', () => {
  it('stay within 1 ulp of Math.* (both signs)', () => {
    for (const h of RARE_BRANCH_INPUTS) {
      for (const x of [fromBits(BigInt(`0x${h}`)), -fromBits(BigInt(`0x${h}`))]) {
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

  it('pins the rare argument-reduction branches (both signs)', () => {
    const golden = JSON.parse(readFileSync(VECTORS, 'utf8')) as { vectors: string[][] }
    const inputs = new Set(golden.vectors.map((v) => v[0]))
    const missing: string[] = []
    for (const h of RARE_BRANCH_INPUTS) {
      for (const x of [fromBits(BigInt(`0x${h}`)), -fromBits(BigInt(`0x${h}`))]) {
        if (!inputs.has(hex(x))) missing.push(hex(x))
      }
    }
    expect(missing).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2.2 additions (spec §4.2, ED-18; plan E10.1): atan2 (musl, with its atan
// kernel), hypot (musl) and pow (fdlibm e_pow.c). Same method as sin/cos:
// <= 1 ulp from Math.* over 100k seeded inputs each, C99 Annex F specials
// (pow follows fdlibm / ECMAScript `**` where those differ from Annex F),
// and a golden that pins the port bit for bit.

/** Pairs of inputs spread over everyday ranges, wide exponents and the kernels' branch points. */
function seededPairs(name: 'atan2' | 'hypot' | 'pow', seed: number, count: number): Array<[number, number]> {
  const next = rng(seed)
  const unit = (): number => next() / 0x100000000
  const anyFinite = (minExp = 0, maxExp = 2046): number => {
    const exp = minExp + (next() % (maxExp - minExp + 1))
    return fromWords(((next() & 1) << 31) | (exp << 20) | (next() & 0xfffff), next())
  }
  const out: Array<[number, number]> = []
  for (let i = 0; i < count; i++) {
    const bucket = i % 10
    if (name === 'atan2') {
      if (bucket < 4) out.push([(unit() * 2 - 1) * 10, (unit() * 2 - 1) * 10])
      else if (bucket < 6) out.push([anyFinite(), anyFinite()])
      else if (bucket < 8) out.push([(unit() * 2 - 1) * 4, 1]) // x = 1: the bare atan path
      else if (bucket < 9) out.push([anyFinite(0x3c0, 0x440), anyFinite(0x3c0, 0x440)]) // |y/x| near 2^±64
      else out.push([(unit() * 2 - 1) * 1e6, (unit() * 2 - 1) * 1e-3])
    } else if (name === 'hypot') {
      if (bucket < 4) out.push([(unit() * 2 - 1) * 1000, (unit() * 2 - 1) * 1000])
      else if (bucket < 7) out.push([anyFinite(), anyFinite()])
      else if (bucket < 8) out.push([anyFinite(0x5f0, 0x7fe), anyFinite(0x5a0, 0x7fe)]) // scale down
      else if (bucket < 9) out.push([anyFinite(0, 0x200), anyFinite(0, 0x200)]) // scale up, subnormals
      else {
        const x = anyFinite(0x300, 0x500)
        out.push([x, x * 2 ** -(60 + (next() % 10)) * (1 + unit())]) // exponent gap near 64
      }
    } else {
      if (bucket < 3) out.push([unit() * 10, (unit() * 2 - 1) * 20])
      else if (bucket < 5) out.push([-(unit() * 10), (next() % 41) - 20]) // negative base, integer power
      else if (bucket < 7) {
        const x = 0.5 + unit() * 1.5
        const lim = (next() & 1 ? 1024 : -1074) / Math.log2(x) // results near overflow / subnormal
        out.push([x, lim * (1 + (unit() * 2 - 1) * 1e-3)])
      } else if (bucket < 9) out.push([Math.abs(anyFinite()), (unit() * 2 - 1) * 4])
      else out.push([anyFinite(0, 0x10), (unit() * 2 - 1) * 2]) // subnormal / tiny bases
    }
  }
  return out
}

describe('dmath 2.2: shape', () => {
  it('exports atan2, hypot and pow on the frozen namespace', () => {
    expect(Object.isFrozen(dmath)).toBe(true)
    expect(typeof dmath.atan2).toBe('function')
    expect(typeof dmath.hypot).toBe('function')
    expect(typeof dmath.pow).toBe('function')
  })
})

/**
 * Correctly rounded sqrt(x² + y²), computed exactly with BigInt: the
 * reference for hypot, because V8's `Math.hypot` is not always within
 * 1 ulp (e.g. hypot(0x09b6e074d9767ced, 0x08de49eedc149a22): Math.hypot is
 * off by 1.17 ulp; musl, and so dmath, by 0.83).
 */
/** floor(sqrt(n)) by Newton's method on BigInt. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2)) // >= sqrt(n)
  for (;;) {
    const y = (x + n / x) >> 1n
    if (y >= x) return x
    x = y
  }
}

function exactHypot(x: number, y: number): number {
  x = Math.abs(x)
  y = Math.abs(y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return Math.hypot(x, y)
  if (x === 0 || y === 0) return Math.max(x, y)
  const parts = (v: number): [bigint, number] => {
    const b = bitsOf(v)
    const e = Number(b >> 52n)
    const m = b & ((1n << 52n) - 1n)
    return e === 0 ? [m, -1074] : [m | (1n << 52n), e - 1075]
  }
  const [ma, ea] = parts(x)
  const [mb, eb] = parts(y)
  const e = Math.min(ea, eb)
  const sum = (ma * ma << BigInt(2 * (ea - e))) + (mb * mb << BigInt(2 * (eb - e)))
  // sqrt(sum) * 2^e, as r * 2^(e - k) with r = isqrt(sum << 2k) holding >= 64 bits.
  const k = 64
  const scaled = sum << BigInt(2 * k)
  const r = isqrt(scaled)
  const sticky = r * r !== scaled
  const exp = e - k // value = r * 2^exp (+ sticky)
  const bitLen = r.toString(2).length
  const top = bitLen - 1 + exp // unbiased exponent of the leading bit
  const lsb = Math.max(top - 52, -1074)
  const drop = BigInt(lsb - exp)
  let mant = r >> drop
  const rem = r - (mant << drop)
  const half = 1n << (drop - 1n)
  if (rem > half || (rem === half && (sticky || (mant & 1n) === 1n))) mant += 1n
  // mant * 2^lsb is representable, so each multiplication below is exact.
  if (lsb >= -1022) return Number(mant) * fromBits(BigInt(lsb + 1023) << 52n)
  return Number(mant) * 2 ** (lsb + 1074) * Number.MIN_VALUE
}

describe('dmath 2.2: accuracy (port fidelity, <= 1 ulp)', () => {
  const seeds = { atan2: 0xa7a2, hypot: 0x4790, pow: 0x90f } as const
  // atan2 and pow against Math.*; hypot against the exact result (see exactHypot).
  const reference = {
    atan2: Math.atan2,
    hypot: exactHypot,
    pow: Math.pow,
  } as const
  for (const name of ['atan2', 'hypot', 'pow'] as const) {
    it(`${name}: 100k seeded input pairs within 1 ulp`, () => {
      let worst = 0n
      let worstAt: [number, number] = [0, 0]
      let differing = 0
      for (const [a, b] of seededPairs(name, seeds[name], 100_000)) {
        const d = ulpDistance(dmath[name](a, b), reference[name](a, b))
        if (d > 0n) differing++
        if (d > worst) {
          worst = d
          worstAt = [a, b]
        }
      }
      expect(
        worst,
        `worst ${name}(0x${hex(worstAt[0])}, 0x${hex(worstAt[1])}) off by ${worst} ulp (${differing} differ)`,
      ).toBeLessThanOrEqual(1n)
    })
  }

  it('exactHypot is a correct reference (exact cases, subnormals, and Math.hypot within 2 ulp)', () => {
    expect(exactHypot(3, 4)).toBe(5)
    expect(exactHypot(3e-320, 4e-320)).toBe(5e-320)
    expect(exactHypot(Number.MIN_VALUE, Number.MIN_VALUE)).toBe(Number.MIN_VALUE)
    expect(exactHypot(1, 1)).toBe(Math.SQRT2)
    expect(exactHypot(Number.MAX_VALUE, Number.MAX_VALUE)).toBe(Infinity)
    for (const [a, b] of seededPairs('hypot', 0x4791, 2000)) {
      expect(ulpDistance(exactHypot(a, b), Math.hypot(a, b))).toBeLessThanOrEqual(2n)
    }
  })

  it('pow: |1 - x| <= 2^-20 with |y| > 2^31 keeps fdlibm\'s known error (relative <= 2^-40)', () => {
    // fdlibm e_pow.c approximates log(x) there by a short series whose first
    // product (ivln2_h * t) is not exact, so the result can be hundreds of
    // ulp off (pow(0x3fefffff8f1011a2, 0x41e84954f3000000): ~270 ulp, the
    // same bits as fdlibm's C). Java's StrictMath.pow has the same property.
    // dmath keeps the port faithful: bit reproducibility is the contract.
    const next = rng(0x90f1)
    const unit = (): number => next() / 0x100000000
    let worst = 0
    for (let i = 0; i < 20_000; i++) {
      // x with a full mantissa (t = x - 1 then has 33 significant bits)
      const x = fromWords(next() & 1 ? 0x3fefffff : 0x3ff00000, next())
      const y = i % 2 ? (unit() * 2 - 1) * 2 ** (31 + (next() % 30)) : ((unit() * 2 - 1) * 1080) / Math.log2(x)
      const got = dmath.pow(x, y)
      const ref = Math.pow(x, y)
      if (!Number.isFinite(ref) || !Number.isFinite(got)) {
        expect(got, `pow(${x}, ${y})`).toBe(ref)
        continue
      }
      // Relative error, measured against 2^-1022 at most in the subnormal range.
      worst = Math.max(worst, Math.abs(got - ref) / Math.max(ref, 2 ** -1022))
    }
    expect(worst).toBeLessThanOrEqual(2 ** -40)
  })

  it('atan2 is odd in y and hypot is symmetric, bit for bit', () => {
    for (const [a, b] of seededPairs('atan2', 0x0dd2, 20_000)) {
      expect(hex(dmath.atan2(-a, b))).toBe(hex(-dmath.atan2(a, b)))
      expect(hex(dmath.hypot(a, b))).toBe(hex(dmath.hypot(b, a)))
      expect(hex(dmath.hypot(-a, b))).toBe(hex(dmath.hypot(a, b)))
    }
  })
})

describe('dmath 2.2: special values', () => {
  const PI = Math.PI
  const same = (got: number, want: number): void => {
    expect(Number.isNaN(want) ? Number.isNaN(got) : Object.is(got, want), `${got} vs ${want}`).toBe(true)
  }

  it('atan2 follows C99 Annex F (= ECMAScript Math.atan2)', () => {
    const cases: Array<[number, number, number]> = [
      [0, 1, 0], [-0, 1, -0], [0, -1, PI], [-0, -1, -PI],
      [0, 0, 0], [-0, 0, -0], [0, -0, PI], [-0, -0, -PI],
      [1, 0, PI / 2], [-1, 0, -PI / 2], [1, -0, PI / 2],
      [Infinity, Infinity, PI / 4], [-Infinity, Infinity, -PI / 4],
      [Infinity, -Infinity, (3 * PI) / 4], [-Infinity, -Infinity, (-3 * PI) / 4],
      [1, Infinity, 0], [-1, Infinity, -0], [1, -Infinity, PI], [-1, -Infinity, -PI],
      [Infinity, 1, PI / 2], [-Infinity, -5, -PI / 2],
      [NaN, 1, NaN], [1, NaN, NaN], [NaN, NaN, NaN],
      [1, 1, PI / 4], [1e300, 1e-300, PI / 2], [1e-300, -1e300, PI], [-1e-300, -1e300, -PI],
    ]
    for (const [y, x, want] of cases) {
      same(dmath.atan2(y, x), want)
      same(dmath.atan2(y, x), Math.atan2(y, x))
    }
  })

  it('hypot follows C99 Annex F (= ECMAScript Math.hypot for two arguments)', () => {
    const cases: Array<[number, number, number]> = [
      [0, 0, 0], [-0, -0, 0], [-0, 0, 0], [3, 4, 5], [-3, 4, 5], [5, 0, 5], [-5, -0, 5],
      [Infinity, NaN, Infinity], [NaN, -Infinity, Infinity], [NaN, 1, NaN], [1, NaN, NaN],
      [Number.MAX_VALUE, Number.MAX_VALUE, Infinity], [Number.MIN_VALUE, 0, Number.MIN_VALUE],
      [Number.MAX_VALUE, 1, Number.MAX_VALUE], [1e300, 1e300, 1.4142135623730952e300],
      [3e-320, 4e-320, 5e-320],
    ]
    for (const [x, y, want] of cases) {
      same(dmath.hypot(x, y), want)
      same(dmath.hypot(x, y), Math.hypot(x, y))
    }
  })

  it('pow follows fdlibm, which matches ECMAScript ** on every special value', () => {
    const xs = [0, -0, 1, -1, 0.5, -0.5, 2, -2, 3, -3, Infinity, -Infinity, NaN, Number.MIN_VALUE, -Number.MAX_VALUE]
    const ys = [0, -0, 1, -1, 0.5, -0.5, 2, -2, 3, -3, 1.5, Infinity, -Infinity, NaN, 2 ** 53, 2 ** 53 + 2, 2 ** 31 + 1]
    const exactX = new Set([0, 1, Infinity])
    const exactY = new Set([0, 1, 2, Infinity])
    for (const x of xs) {
      for (const y of ys) {
        const want = x ** y
        // Special operands and special results are exact; anything else is
        // implementation-approximated in ECMAScript, so within 1 ulp.
        if (exactX.has(Math.abs(x)) || exactY.has(Math.abs(y)) || Number.isNaN(x) || Number.isNaN(y) || want === 0 || !Number.isFinite(want)) {
          same(dmath.pow(x, y), want)
        } else {
          expect(ulpDistance(dmath.pow(x, y), want), `pow(${x}, ${y})`).toBeLessThanOrEqual(1n)
        }
      }
    }
    // Where ECMAScript and C99 Annex F disagree, dmath agrees with **.
    same(dmath.pow(1, Infinity), NaN)
    same(dmath.pow(-1, -Infinity), NaN)
    same(dmath.pow(1, NaN), NaN)
    same(dmath.pow(NaN, 0), 1)
    // Exact cases.
    expect(dmath.pow(2, 10)).toBe(1024)
    expect(dmath.pow(2, -1074)).toBe(Number.MIN_VALUE)
    expect(dmath.pow(2, 1024)).toBe(Infinity)
    expect(dmath.pow(-2, 3)).toBe(-8)
    expect(dmath.pow(9, 0.5)).toBe(3)
  })
})

const VECTORS_2 = new URL('../../../test/golden/dmath2-vectors.json', import.meta.url)

describe('dmath 2.2: golden vectors (pin the port bit for bit)', () => {
  it('matches every committed vector', () => {
    expect(existsSync(VECTORS_2), 'run `node scripts/dmath-golden.mjs --write`').toBe(true)
    const golden = JSON.parse(readFileSync(VECTORS_2, 'utf8')) as {
      functions: string[]
      vectors: Record<'atan2' | 'hypot' | 'pow', [string, string, string][]>
    }
    expect(golden.functions).toEqual(['atan2', 'hypot', 'pow'])
    const enc = (v: number): string => (Number.isNaN(v) ? 'nan' : hex(v))
    const dec = (h: string): number => (h === 'nan' ? NaN : fromBits(BigInt(`0x${h}`)))
    const mismatches: string[] = []
    for (const name of ['atan2', 'hypot', 'pow'] as const) {
      expect(golden.vectors[name].length, name).toBeGreaterThanOrEqual(1000)
      for (const [a, b, out] of golden.vectors[name]) {
        if (enc(dmath[name](dec(a), dec(b))) !== out) mismatches.push(`${name}(0x${a}, 0x${b})`)
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([])
  })
})
