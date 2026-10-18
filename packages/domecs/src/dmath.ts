/**
 * Deterministic math (spec §4.2, ED-1, ED-18; ledger O-75).
 *
 * `Math.sin`/`Math.cos` are implementation-approximated under ECMA-262, and
 * real engines disagree by up to 1 ulp on thousands of inputs. `dmath` is a
 * straight-line port of **musl libm** (generic C, non-FMA paths):
 * `sin.c`, `cos.c`, `__sin.c`, `__cos.c`, `__rem_pio2.c`,
 * `__rem_pio2_large.c` (themselves from FreeBSD msun / Sun fdlibm).
 *
 * Why it is bit-exact everywhere: ECMA-262 numbers are IEEE-754 binary64
 * with round-to-nearest-even, no FMA contraction and no extended precision,
 * so evaluating the C expressions in the same order reproduces the same bits
 * on every engine. Bit access goes through one module-level `DataView` with
 * explicit little-endian offsets (no platform-endianness dependence). Every
 * constant is built from its hex words: the C sources spell them with 21
 * significant digits, and ECMA-262 lets an engine round literals past the
 * 20th digit either way. `FORCE_EVAL` / `fp_barrier` (exception-flag side
 * effects) have no JS meaning and are dropped.
 *
 * Do not "simplify" an expression here: reassociating changes rounding.
 *
 * musl: Copyright © 2005-2020 Rich Felker, et al. (MIT).
 * fdlibm: Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 * Developed at SunSoft, a Sun Microsystems, Inc. business. Permission to
 * use, copy, modify, and distribute this software is freely granted,
 * provided that this notice is preserved. `__rem_pio2` optimized by
 * Bruce D. Evans.
 */

// ---------------------------------------------------------------------------
// Bit access (little-endian words: lo at byte 0, hi at byte 4)

const scratch = new DataView(new ArrayBuffer(8))

function highWord(x: number): number {
  scratch.setFloat64(0, x, true)
  return scratch.getUint32(4, true)
}

function fromWords(hi: number, lo: number): number {
  scratch.setUint32(4, hi >>> 0, true)
  scratch.setUint32(0, lo >>> 0, true)
  return scratch.getFloat64(0, true)
}

/** Exact power of two 2^n for -1022 <= n <= 1023. */
function pow2(n: number): number {
  return fromWords(((0x3ff + n) << 20) >>> 0, 0)
}

// ---------------------------------------------------------------------------
// scalbn (musl src/math/scalbn.c)

const P2_1023 = pow2(1023)
const P2_M1022_TIMES_P2_53 = pow2(-1022) * pow2(53) // 0x1p-1022 * 0x1p53, exact

function scalbn(x: number, n: number): number {
  let y = x
  if (n > 1023) {
    y *= P2_1023
    n -= 1023
    if (n > 1023) {
      y *= P2_1023
      n -= 1023
      if (n > 1023) n = 1023
    }
  } else if (n < -1022) {
    // make sure final n < -53 to avoid double rounding in the subnormal range
    y *= P2_M1022_TIMES_P2_53
    n += 1022 - 53
    if (n < -1022) {
      y *= P2_M1022_TIMES_P2_53
      n += 1022 - 53
      if (n < -1022) n = -1022
    }
  }
  return y * pow2(n)
}

const TWO24 = 16777216 // 0x1p24
const TWOM24 = 5.9604644775390625e-8 // 0x1p-24

// ---------------------------------------------------------------------------
// __rem_pio2_large (musl src/math/__rem_pio2_large.c), double precision only

const INIT_JK = [3, 4, 4, 6] as const

/** (24*i)-th to (24*i+23)-th bits of 2/pi; enough for binary64 (LDBL_MAX_EXP = 1024). */
const IPIO2: readonly number[] = [
  0xa2f983, 0x6e4e44, 0x1529fc, 0x2757d1, 0xf534dd, 0xc0db62,
  0x95993c, 0x439041, 0xfe5163, 0xabdebb, 0xc561b7, 0x246e3a,
  0x424dd2, 0xe00649, 0x2eea09, 0xd1921c, 0xfe1deb, 0x1cb129,
  0xa73ee8, 0x8235f5, 0x2ebb44, 0x84e99c, 0x7026b4, 0x5f7e41,
  0x3991d6, 0x398353, 0x39f49c, 0x845f8b, 0xbdf928, 0x3b1ff8,
  0x97ffde, 0x05980f, 0xef2f11, 0x8b5a0a, 0x6d1f6d, 0x367ecf,
  0x27cb09, 0xb74f46, 0x3f669e, 0x5fea2d, 0x7527ba, 0xc7ebe5,
  0xf17b3d, 0x0739f7, 0x8a5292, 0xea6bfb, 0x5fb11f, 0x8d5d08,
  0x560330, 0x46fc7b, 0x6babf0, 0xcfbc20, 0x9af436, 0x1da9e3,
  0x91615e, 0xe61b08, 0x659985, 0x5f14a0, 0x68408d, 0xffd880,
  0x4d7327, 0x310606, 0x1556ca, 0x73a8c9, 0x60e27b, 0xc08c6b,
]

const PIO2: readonly number[] = [
  fromWords(0x3ff921fb, 0x40000000), // 1.57079625129699707031e+00
  fromWords(0x3e74442d, 0x00000000), // 7.54978941586159635335e-08
  fromWords(0x3cf84698, 0x80000000), // 5.39030252995776476554e-15
  fromWords(0x3b78cc51, 0x60000000), // 3.28200341580791294123e-22
  fromWords(0x39f01b83, 0x80000000), // 1.27065575308067607349e-29
  fromWords(0x387a2520, 0x40000000), // 1.22933308981111328932e-36
  fromWords(0x36e38222, 0x80000000), // 2.73370053816464559624e-44
  fromWords(0x3569f31d, 0x00000000), // 2.16741683877804819444e-51
]

/**
 * Returns the last three bits of N with y = x - N*pi/2, |y| < pi/2. `x` holds
 * `nx` 24-bit chunks of the input scaled by 2^-e0. Only `prec = 1` (two-word
 * result) is needed for binary64.
 */
function remPio2Large(x: number[], y: number[], e0: number, nx: number, prec: number): number {
  const iq: number[] = new Array(20).fill(0)
  const f: number[] = new Array(20).fill(0)
  const fq: number[] = new Array(20).fill(0)
  const q: number[] = new Array(20).fill(0)
  let z: number
  let fw: number
  let i: number
  let j: number
  let k: number
  let n: number
  let ih: number
  let carry: number

  // initialize jk
  const jk = INIT_JK[prec as 0 | 1 | 2 | 3]
  const jp = jk

  // determine jx, jv, q0; note that 3 > q0
  const jx = nx - 1
  let jv = ((e0 - 3) / 24) | 0 // C integer division truncates toward zero
  if (jv < 0) jv = 0
  let q0 = e0 - 24 * (jv + 1)

  // set up f[0] to f[jx+jk] where f[jx+jk] = ipio2[jv+jk]
  j = jv - jx
  const m = jx + jk
  for (i = 0; i <= m; i++, j++) f[i] = j < 0 ? 0.0 : IPIO2[j]!

  // compute q[0], q[1], ... q[jk]
  for (i = 0; i <= jk; i++) {
    for (j = 0, fw = 0.0; j <= jx; j++) fw += x[j]! * f[jx + i - j]!
    q[i] = fw
  }

  let jz = jk
  for (;;) {
    // recompute: distill q[] into iq[] reversingly
    for (i = 0, j = jz, z = q[jz]!; j > 0; i++, j--) {
      fw = Math.trunc(TWOM24 * z)
      iq[i] = (z - TWO24 * fw) | 0
      z = q[j - 1]! + fw
    }

    // compute n
    z = scalbn(z, q0) // actual value of z
    z -= 8.0 * Math.floor(z * 0.125) // trim off integer >= 8
    n = z | 0
    z -= n
    ih = 0
    if (q0 > 0) {
      // need iq[jz-1] to determine n
      i = iq[jz - 1]! >> (24 - q0)
      n += i
      iq[jz - 1] = iq[jz - 1]! - (i << (24 - q0))
      ih = iq[jz - 1]! >> (23 - q0)
    } else if (q0 === 0) ih = iq[jz - 1]! >> 23
    else if (z >= 0.5) ih = 2

    if (ih > 0) {
      // q > 0.5
      n += 1
      carry = 0
      for (i = 0; i < jz; i++) {
        // compute 1-q
        j = iq[i]!
        if (carry === 0) {
          if (j !== 0) {
            carry = 1
            iq[i] = 0x1000000 - j
          }
        } else iq[i] = 0xffffff - j
      }
      if (q0 > 0) {
        // rare case: chance is 1 in 12
        switch (q0) {
          case 1:
            iq[jz - 1] = iq[jz - 1]! & 0x7fffff
            break
          case 2:
            iq[jz - 1] = iq[jz - 1]! & 0x3fffff
            break
        }
      }
      if (ih === 2) {
        z = 1.0 - z
        if (carry !== 0) z -= scalbn(1.0, q0)
      }
    }

    // check if recomputation is needed
    if (z === 0.0) {
      j = 0
      for (i = jz - 1; i >= jk; i--) j |= iq[i]!
      if (j === 0) {
        // need recomputation
        for (k = 1; iq[jk - k] === 0; k++); // k = no. of terms needed
        for (i = jz + 1; i <= jz + k; i++) {
          // add q[jz+1] to q[jz+k]
          f[jx + i] = IPIO2[jv + i]!
          for (j = 0, fw = 0.0; j <= jx; j++) fw += x[j]! * f[jx + i - j]!
          q[i] = fw
        }
        jz += k
        continue
      }
    }
    break
  }

  // chop off zero terms
  if (z === 0.0) {
    jz -= 1
    q0 -= 24
    while (iq[jz] === 0) {
      jz--
      q0 -= 24
    }
  } else {
    // break z into 24-bit if necessary
    z = scalbn(z, -q0)
    if (z >= TWO24) {
      fw = Math.trunc(TWOM24 * z)
      iq[jz] = (z - TWO24 * fw) | 0
      jz += 1
      q0 += 24
      iq[jz] = fw | 0
    } else iq[jz] = z | 0
  }

  // convert integer "bit" chunk to floating-point value
  fw = scalbn(1.0, q0)
  for (i = jz; i >= 0; i--) {
    q[i] = fw * iq[i]!
    fw *= TWOM24
  }

  // compute PIo2[0,...,jp]*q[jz,...,0]
  for (i = jz; i >= 0; i--) {
    for (fw = 0.0, k = 0; k <= jp && k <= jz - i; k++) fw += PIO2[k]! * q[i + k]!
    fq[jz - i] = fw
  }

  // compress fq[] into y[] (prec 1 / 2)
  fw = 0.0
  for (i = jz; i >= 0; i--) fw += fq[i]!
  y[0] = ih === 0 ? fw : -fw
  fw = fq[0]! - fw
  for (i = 1; i <= jz; i++) fw += fq[i]!
  y[1] = ih === 0 ? fw : -fw
  return n & 7
}

// ---------------------------------------------------------------------------
// __rem_pio2 (musl src/math/__rem_pio2.c)

const TOINT = 6755399441055744 // 1.5/DBL_EPSILON = 1.5 * 2^52
const PIO4 = fromWords(0x3fe921fb, 0x54442d18) // 0x1.921fb54442d18p-1
const INVPIO2 = fromWords(0x3fe45f30, 0x6dc9c883) // 6.36619772367581382433e-01
const PIO2_1 = fromWords(0x3ff921fb, 0x54400000) // 1.57079632673412561417e+00
const PIO2_1T = fromWords(0x3dd0b461, 0x1a626331) // 6.07710050650619224932e-11
const PIO2_2 = fromWords(0x3dd0b461, 0x1a600000) // 6.07710050630396597660e-11
const PIO2_2T = fromWords(0x3ba3198a, 0x2e037073) // 2.02226624879595063154e-21
const PIO2_3 = fromWords(0x3ba3198a, 0x2e000000) // 2.02226624871116645580e-21
const PIO2_3T = fromWords(0x397b839a, 0x252049c1) // 8.47842766036889956997e-32

const tx: number[] = [0, 0, 0]
const ty: number[] = [0, 0]

/**
 * Returns n with x - n*pi/2 = y[0] + y[1], |y[0] + y[1]| ~<= pi/4.
 * Caller handles |x| ~<= pi/4 (no reduction needed).
 */
function remPio2(x: number, y: number[]): number {
  scratch.setFloat64(0, x, true)
  const hi = scratch.getUint32(4, true)
  const sign = hi >>> 31
  const ix = hi & 0x7fffffff
  let z: number
  let w: number
  let t: number
  let r: number
  let fn: number
  let n: number
  let ey: number

  medium: {
    if (ix <= 0x400f6a7a) {
      // |x| ~<= 5pi/4
      if ((ix & 0xfffff) === 0x921fb) break medium // |x| ~= pi/2 or 2pi/2: cancellation
      if (ix <= 0x4002d97c) {
        // |x| ~<= 3pi/4
        if (!sign) {
          z = x - PIO2_1 // one round good to 85 bits
          y[0] = z - PIO2_1T
          y[1] = z - y[0] - PIO2_1T
          return 1
        } else {
          z = x + PIO2_1
          y[0] = z + PIO2_1T
          y[1] = z - y[0] + PIO2_1T
          return -1
        }
      } else {
        if (!sign) {
          z = x - 2 * PIO2_1
          y[0] = z - 2 * PIO2_1T
          y[1] = z - y[0] - 2 * PIO2_1T
          return 2
        } else {
          z = x + 2 * PIO2_1
          y[0] = z + 2 * PIO2_1T
          y[1] = z - y[0] + 2 * PIO2_1T
          return -2
        }
      }
    }
    if (ix <= 0x401c463b) {
      // |x| ~<= 9pi/4
      if (ix <= 0x4015fdbc) {
        // |x| ~<= 7pi/4
        if (ix === 0x4012d97c) break medium // |x| ~= 3pi/2
        if (!sign) {
          z = x - 3 * PIO2_1
          y[0] = z - 3 * PIO2_1T
          y[1] = z - y[0] - 3 * PIO2_1T
          return 3
        } else {
          z = x + 3 * PIO2_1
          y[0] = z + 3 * PIO2_1T
          y[1] = z - y[0] + 3 * PIO2_1T
          return -3
        }
      } else {
        if (ix === 0x401921fb) break medium // |x| ~= 4pi/2
        if (!sign) {
          z = x - 4 * PIO2_1
          y[0] = z - 4 * PIO2_1T
          y[1] = z - y[0] - 4 * PIO2_1T
          return 4
        } else {
          z = x + 4 * PIO2_1
          y[0] = z + 4 * PIO2_1T
          y[1] = z - y[0] + 4 * PIO2_1T
          return -4
        }
      }
    }
    if (ix >= 0x413921fb) {
      // all other (large) arguments: |x| ~>= 2^20*(pi/2)
      if (ix >= 0x7ff00000) {
        // x is inf or NaN
        y[0] = y[1] = x - x
        return 0
      }
      // set z = scalbn(|x|, -ilogb(x) + 23)
      scratch.setFloat64(0, x, true)
      scratch.setUint32(4, (scratch.getUint32(4, true) & 0x000fffff) | ((0x3ff + 23) << 20), true)
      z = scratch.getFloat64(0, true)
      let i: number
      for (i = 0; i < 2; i++) {
        tx[i] = z | 0 // (double)(int32_t)z, z in [2^23, 2^24)
        z = (z - tx[i]!) * TWO24
      }
      tx[i] = z
      // skip zero terms, first term is non-zero
      while (tx[i] === 0.0) i--
      n = remPio2Large(tx, ty, (ix >>> 20) - (0x3ff + 23), i + 1, 1)
      if (sign) {
        y[0] = -ty[0]!
        y[1] = -ty[1]!
        return -n
      }
      y[0] = ty[0]!
      y[1] = ty[1]!
      return n
    }
  }

  // medium: |x| ~< 2^20*(pi/2)
  // rint(x/(pi/2))
  fn = x * INVPIO2 + TOINT - TOINT
  n = fn | 0
  r = x - fn * PIO2_1
  w = fn * PIO2_1T // 1st round, good to 85 bits
  // Matters with directed rounding.
  if (r - w < -PIO4) {
    n--
    fn--
    r = x - fn * PIO2_1
    w = fn * PIO2_1T
  } else if (r - w > PIO4) {
    n++
    fn++
    r = x - fn * PIO2_1
    w = fn * PIO2_1T
  }
  y[0] = r - w
  ey = (highWord(y[0]) >>> 20) & 0x7ff
  const ex = ix >>> 20
  if (ex - ey > 16) {
    // 2nd round, good to 118 bits
    t = r
    w = fn * PIO2_2
    r = t - w
    w = fn * PIO2_2T - (t - r - w)
    y[0] = r - w
    ey = (highWord(y[0]) >>> 20) & 0x7ff
    if (ex - ey > 49) {
      // 3rd round, good to 151 bits, covers all cases
      t = r
      w = fn * PIO2_3
      r = t - w
      w = fn * PIO2_3T - (t - r - w)
      y[0] = r - w
    }
  }
  y[1] = r - y[0] - w
  return n
}

// ---------------------------------------------------------------------------
// __sin / __cos kernels on ~[-pi/4, pi/4] (musl src/math/__sin.c, __cos.c)

const S1 = fromWords(0xbfc55555, 0x55555549) // -1.66666666666666324348e-01
const S2 = fromWords(0x3f811111, 0x1110f8a6) //  8.33333333332248946124e-03
const S3 = fromWords(0xbf2a01a0, 0x19c161d5) // -1.98412698298579493134e-04
const S4 = fromWords(0x3ec71de3, 0x57b1fe7d) //  2.75573137070700676789e-06
const S5 = fromWords(0xbe5ae5e6, 0x8a2b9ceb) // -2.50507602534068634195e-08
const S6 = fromWords(0x3de5d93a, 0x5acfd57c) //  1.58969099521155010221e-10

function kernelSin(x: number, y: number, iy: number): number {
  const z = x * x
  const w = z * z
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6)
  const v = z * x
  if (iy === 0) return x + v * (S1 + z * r)
  return x - (z * (0.5 * y - v * r) - y - v * S1)
}

const C1 = fromWords(0x3fa55555, 0x5555554c) //  4.16666666666666019037e-02
const C2 = fromWords(0xbf56c16c, 0x16c15177) // -1.38888888888741095749e-03
const C3 = fromWords(0x3efa01a0, 0x19cb1590) //  2.48015872894767294178e-05
const C4 = fromWords(0xbe927e4f, 0x809c52ad) // -2.75573143513906633035e-07
const C5 = fromWords(0x3e21ee9e, 0xbdb4b1c4) //  2.08757232129817482790e-09
const C6 = fromWords(0xbda8fae9, 0xbe8838d4) // -1.13596475577881948265e-11

function kernelCos(x: number, y: number): number {
  const z = x * x
  let w = z * z
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6))
  const hz = 0.5 * z
  w = 1.0 - hz
  return w + (1.0 - w - hz + (z * r - x * y))
}

// ---------------------------------------------------------------------------
// sin / cos (musl src/math/sin.c, cos.c)

const yy: number[] = [0, 0]

function sin(x: number): number {
  const ix = highWord(x) & 0x7fffffff

  // |x| ~< pi/4
  if (ix <= 0x3fe921fb) {
    if (ix < 0x3e500000) return x // |x| < 2**-26 (keeps -0)
    return kernelSin(x, 0.0, 0)
  }

  // sin(Inf or NaN) is NaN
  if (ix >= 0x7ff00000) return x - x

  // argument reduction needed
  const n = remPio2(x, yy)
  switch (n & 3) {
    case 0:
      return kernelSin(yy[0]!, yy[1]!, 1)
    case 1:
      return kernelCos(yy[0]!, yy[1]!)
    case 2:
      return -kernelSin(yy[0]!, yy[1]!, 1)
    default:
      return -kernelCos(yy[0]!, yy[1]!)
  }
}

function cos(x: number): number {
  const ix = highWord(x) & 0x7fffffff

  // |x| ~< pi/4
  if (ix <= 0x3fe921fb) {
    if (ix < 0x3e46a09e) return 1.0 // |x| < 2**-27 * sqrt(2)
    return kernelCos(x, 0)
  }

  // cos(Inf or NaN) is NaN
  if (ix >= 0x7ff00000) return x - x

  // argument reduction
  const n = remPio2(x, yy)
  switch (n & 3) {
    case 0:
      return kernelCos(yy[0]!, yy[1]!)
    case 1:
      return -kernelSin(yy[0]!, yy[1]!, 1)
    case 2:
      return -kernelCos(yy[0]!, yy[1]!)
    default:
      return kernelSin(yy[0]!, yy[1]!, 1)
  }
}

/**
 * Bit-reproducible math: identical results on every ECMA-262 engine.
 *
 * - `sin`, `cos`: musl libm ports, < 1 ulp from the true result; ±0, ±∞,
 *   NaN and subnormals follow C99 Annex F; huge arguments reduce exactly
 *   (Payne–Hanek).
 * - `sqrt`: `Math.sqrt`, which IEEE-754 already makes correctly rounded;
 *   re-exported so authors need one namespace.
 *
 * Authoritative (deterministic) systems use these instead of `Math.sin` /
 * `Math.cos` (SPEC §8). `@domecs/rules` evaluates `sin()` / `cos()` with them.
 */
export const dmath: Readonly<{
  sin(x: number): number
  cos(x: number): number
  /** = Math.sqrt (correctly rounded by IEEE-754; re-exported so authors need one namespace). */
  sqrt(x: number): number
}> = Object.freeze({
  sin,
  cos,
  sqrt: Math.sqrt,
})
