/**
 * Deterministic math (spec §4.2, ED-1, ED-18; ledger O-75).
 *
 * `Math.sin`/`Math.cos` are implementation-approximated under ECMA-262, and
 * real engines disagree by up to 1 ulp on thousands of inputs. `dmath` is a
 * straight-line port of **musl libm** (generic C, non-FMA paths):
 * `sin.c`, `cos.c`, `__sin.c`, `__cos.c`, `__rem_pio2.c`,
 * `__rem_pio2_large.c` (themselves from FreeBSD msun / Sun fdlibm); from
 * 2.2 also `atan.c`, `atan2.c`, `hypot.c`, plus Sun fdlibm 5.3 `e_pow.c`.
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

// ---------------------------------------------------------------------------
// 2.2 additions (spec §4.2, ED-18): atan (kernel for atan2), atan2, hypot
// from musl (src/math/atan.c, atan2.c, hypot.c), pow from fdlibm 5.3
// e_pow.c (no tables, no FMA paths). Same porting rules as above.

function lowWord(x: number): number {
  scratch.setFloat64(0, x, true)
  return scratch.getUint32(0, true)
}

/** `x` with its low word cleared (fdlibm `__LO(x) = 0`). */
function clearLow(x: number): number {
  scratch.setFloat64(0, x, true)
  scratch.setUint32(0, 0, true)
  return scratch.getFloat64(0, true)
}

const ATANHI: readonly number[] = [
  fromWords(0x3fddac67, 0x0561bb4f), // atan(0.5)hi 4.63647609000806093515e-01
  fromWords(0x3fe921fb, 0x54442d18), // atan(1.0)hi 7.85398163397448278999e-01
  fromWords(0x3fef730b, 0xd281f69b), // atan(1.5)hi 9.82793723247329054082e-01
  fromWords(0x3ff921fb, 0x54442d18), // atan(inf)hi 1.57079632679489655800e+00
]
const ATANLO: readonly number[] = [
  fromWords(0x3c7a2b7f, 0x222f65e2), // atan(0.5)lo 2.26987774529616870924e-17
  fromWords(0x3c81a626, 0x33145c07), // atan(1.0)lo 3.06161699786838301793e-17
  fromWords(0x3c700788, 0x7af0cbbd), // atan(1.5)lo 1.39033110312309984516e-17
  fromWords(0x3c91a626, 0x33145c07), // atan(inf)lo 6.12323399573676603587e-17
]
const AT0 = fromWords(0x3fd55555, 0x5555550d) //  3.33333333333329318027e-01
const AT1 = fromWords(0xbfc99999, 0x9998ebc4) // -1.99999999998764832476e-01
const AT2 = fromWords(0x3fc24924, 0x920083ff) //  1.42857142725034663711e-01
const AT3 = fromWords(0xbfbc71c6, 0xfe231671) // -1.11111104054623557880e-01
const AT4 = fromWords(0x3fb745cd, 0xc54c206e) //  9.09088713343650656196e-02
const AT5 = fromWords(0xbfb3b0f2, 0xaf749a6d) // -7.69187620504482999495e-02
const AT6 = fromWords(0x3fb10d66, 0xa0d03d51) //  6.66107313738753120669e-02
const AT7 = fromWords(0xbfadde2d, 0x52defd9a) // -5.83357013379057348645e-02
const AT8 = fromWords(0x3fa97b4b, 0x24760deb) //  4.97687799461593236017e-02
const AT9 = fromWords(0xbfa2b444, 0x2c6a6c2f) // -3.65315727442169155270e-02
const AT10 = fromWords(0x3f90ad3a, 0xe322da11) // 1.62858201153657823623e-02

/** musl atan (the kernel atan2 uses). */
function atan(x: number): number {
  let w: number
  let s1: number
  let s2: number
  let z: number
  let id: number
  let ix = highWord(x)
  const sign = ix >>> 31
  ix &= 0x7fffffff
  if (ix >= 0x44100000) {
    // |x| >= 2^66
    if (x !== x) return x
    z = ATANHI[3]! // atanhi[3] + 0x1p-120f rounds to atanhi[3]
    return sign ? -z : z
  }
  if (ix < 0x3fdc0000) {
    // |x| < 0.4375
    if (ix < 0x3e400000) return x // |x| < 2^-27 (keeps -0)
    id = -1
  } else {
    x = Math.abs(x)
    if (ix < 0x3ff30000) {
      // |x| < 1.1875
      if (ix < 0x3fe60000) {
        // 7/16 <= |x| < 11/16
        id = 0
        x = (2.0 * x - 1.0) / (2.0 + x)
      } else {
        // 11/16 <= |x| < 19/16
        id = 1
        x = (x - 1.0) / (x + 1.0)
      }
    } else if (ix < 0x40038000) {
      // |x| < 2.4375
      id = 2
      x = (x - 1.5) / (1.0 + 1.5 * x)
    } else {
      // 2.4375 <= |x| < 2^66
      id = 3
      x = -1.0 / x
    }
  }
  // end of argument reduction
  z = x * x
  w = z * z
  // break sum from i=0 to 10 aT[i]z**(i+1) into odd and even poly
  s1 = z * (AT0 + w * (AT2 + w * (AT4 + w * (AT6 + w * (AT8 + w * AT10)))))
  s2 = w * (AT1 + w * (AT3 + w * (AT5 + w * (AT7 + w * AT9))))
  if (id < 0) return x - x * (s1 + s2)
  z = ATANHI[id]! - (x * (s1 + s2) - ATANLO[id]! - x)
  return sign ? -z : z
}

const PI = fromWords(0x400921fb, 0x54442d18) // 3.1415926535897931160E+00
const PI_LO = fromWords(0x3ca1a626, 0x33145c07) // 1.2246467991473531772E-16

/** musl atan2. */
function atan2(y: number, x: number): number {
  let z: number
  if (x !== x || y !== y) return x + y
  scratch.setFloat64(0, x, true)
  let ix = scratch.getUint32(4, true)
  const lx = scratch.getUint32(0, true)
  scratch.setFloat64(0, y, true)
  let iy = scratch.getUint32(4, true)
  const ly = scratch.getUint32(0, true)
  if (ix === 0x3ff00000 && lx === 0) return atan(y) // x = 1.0
  const m = ((iy >>> 31) & 1) | ((ix >>> 30) & 2) // 2*sign(x)+sign(y)
  ix &= 0x7fffffff
  iy &= 0x7fffffff

  // when y = 0
  if ((iy | ly) === 0) {
    switch (m) {
      case 0:
      case 1:
        return y // atan(+-0,+anything)=+-0
      case 2:
        return PI // atan(+0,-anything) = pi
      default:
        return -PI // atan(-0,-anything) =-pi
    }
  }
  // when x = 0
  if ((ix | lx) === 0) return m & 1 ? -PI / 2 : PI / 2
  // when x is INF
  if (ix === 0x7ff00000) {
    if (iy === 0x7ff00000) {
      switch (m) {
        case 0:
          return PI / 4 // atan(+INF,+INF)
        case 1:
          return -PI / 4 // atan(-INF,+INF)
        case 2:
          return (3 * PI) / 4 // atan(+INF,-INF)
        default:
          return (-3 * PI) / 4 // atan(-INF,-INF)
      }
    } else {
      switch (m) {
        case 0:
          return 0.0 // atan(+...,+INF)
        case 1:
          return -0.0 // atan(-...,+INF)
        case 2:
          return PI // atan(+...,-INF)
        default:
          return -PI // atan(-...,-INF)
      }
    }
  }
  // |y/x| > 0x1p64
  if (ix + (64 << 20) < iy || iy === 0x7ff00000) return m & 1 ? -PI / 2 : PI / 2

  // z = atan(|y/x|) without spurious underflow
  if (m & 2 && iy + (64 << 20) < ix) z = 0 // |y/x| < 0x1p-64, x<0
  else z = atan(Math.abs(y / x))
  switch (m) {
    case 0:
      return z // atan(+,+)
    case 1:
      return -z // atan(-,+)
    case 2:
      return PI - (z - PI_LO) // atan(+,-)
    default:
      return z - PI_LO - PI // atan(-,-)
  }
}

const SPLIT = 134217729 // 0x1p27 + 1 (FLT_EVAL_METHOD == 0)
const P2_700 = pow2(700)
const P2_M700 = 1 / P2_700 // 0x1p-700, exact

let sqHi = 0
let sqLo = 0

/** musl hypot's `sq`: x*x as the exact sum sqHi + sqLo (Dekker split). */
function sq(x: number): void {
  const xc = x * SPLIT
  const xh = x - xc + xc
  const xl = x - xh
  sqHi = x * x
  sqLo = xh * xh - sqHi + 2 * xh * xl + xl * xl
}

/** musl hypot. */
function hypot(x: number, y: number): number {
  x = Math.abs(x)
  y = Math.abs(y)
  // arrange |x| >= |y| (by bit pattern, as musl compares the uint64 images)
  scratch.setFloat64(0, x, true)
  const xhi = scratch.getUint32(4, true)
  const xlo = scratch.getUint32(0, true)
  scratch.setFloat64(0, y, true)
  const yhi = scratch.getUint32(4, true)
  const ylo = scratch.getUint32(0, true)
  let ex: number
  let ey: number
  let yIsZero: boolean
  if (xhi < yhi || (xhi === yhi && xlo < ylo)) {
    const t = x
    x = y
    y = t
    ex = yhi >>> 20
    ey = xhi >>> 20
    yIsZero = (xhi | xlo) === 0
  } else {
    ex = xhi >>> 20
    ey = yhi >>> 20
    yIsZero = (yhi | ylo) === 0
  }

  // special cases; note: hypot(inf,nan) == inf
  if (ey === 0x7ff) return y
  if (ex === 0x7ff || yIsZero) return x
  // hypot(x,y) ~= x + y*y/x/2 with inexact for small y/x
  if (ex - ey > 64) return x + y

  // precise sqrt argument in nearest rounding mode without overflow:
  // xh*xh must not overflow and xl*xl must not underflow in sq
  let z = 1
  if (ex > 0x3ff + 510) {
    z = P2_700
    x *= P2_M700
    y *= P2_M700
  } else if (ey < 0x3ff - 450) {
    z = P2_M700
    x *= P2_700
    y *= P2_700
  }
  sq(x)
  const hx = sqHi
  const lx = sqLo
  sq(y)
  return z * Math.sqrt(sqLo + lx + sqHi + hx)
}

const BP: readonly number[] = [1.0, 1.5]
const DP_H: readonly number[] = [0.0, fromWords(0x3fe2b803, 0x40000000)] // 5.84962487220764160156e-01
const DP_L: readonly number[] = [0.0, fromWords(0x3e4cfdeb, 0x43cfd006)] // 1.35003920212974897128e-08
const TWO53 = 9007199254740992.0 // 0x1p53
const HUGE = 1.0e300
const TINY = 1.0e-300
// poly coefs for (3/2)*(log(x)-2s-2/3*s**3
const L1 = fromWords(0x3fe33333, 0x33333303) // 5.99999999999994648725e-01
const L2 = fromWords(0x3fdb6db6, 0xdb6fabff) // 4.28571428578550184252e-01
const L3 = fromWords(0x3fd55555, 0x518f264d) // 3.33333329818377432918e-01
const L4 = fromWords(0x3fd17460, 0xa91d4101) // 2.72728123808534006489e-01
const L5 = fromWords(0x3fcd864a, 0x93c9db65) // 2.30660745775561754067e-01
const L6 = fromWords(0x3fca7e28, 0x4a454eef) // 2.06975017800338417784e-01
const P1 = fromWords(0x3fc55555, 0x5555553e) //  1.66666666666666019037e-01
const P2 = fromWords(0xbf66c16c, 0x16bebd93) // -2.77777777770155933842e-03
const P3 = fromWords(0x3f11566a, 0xaf25de2c) //  6.61375632143793436117e-05
const P4 = fromWords(0xbebbbd41, 0xc5d26bf1) // -1.65339022054652515390e-06
const P5 = fromWords(0x3e663769, 0x72bea4d0) //  4.13813679705723846039e-08
const LG2 = fromWords(0x3fe62e42, 0xfefa39ef) // 6.93147180559945286227e-01
const LG2_H = fromWords(0x3fe62e43, 0x00000000) // 6.93147182464599609375e-01
const LG2_L = fromWords(0xbe205c61, 0x0ca86c39) // -1.90465429995776804525e-09
const OVT = fromWords(0x3c971547, 0x652b82fe) // 8.0085662595372944372e-17, -(1024-log2(ovfl+.5ulp))
const CP = fromWords(0x3feec709, 0xdc3a03fd) // 9.61796693925975554329e-01 = 2/(3ln2)
const CP_H = fromWords(0x3feec709, 0xe0000000) // 9.61796700954437255859e-01 = (float)cp
const CP_L = fromWords(0xbe3e2fe0, 0x145b01f5) // -7.02846165095275826516e-09 = tail of cp_h
const IVLN2 = fromWords(0x3ff71547, 0x652b82fe) // 1.44269504088896338700e+00 = 1/ln2
const IVLN2_H = fromWords(0x3ff71547, 0x60000000) // 1.44269502162933349609e+00 = 24b 1/ln2
const IVLN2_L = fromWords(0x3e54ae0b, 0xf85ddf44) // 1.92596299112661746887e-08 = 1/ln2 tail
const THIRD = fromWords(0x3fd55555, 0x55555555) // 0.3333333333333333333333

/**
 * fdlibm 5.3 `__ieee754_pow`. Its special values are ECMAScript's `**`
 * (which was specified after fdlibm): `(±1) ** ±Infinity` and `1 ** NaN`
 * are NaN, where C99 Annex F says 1.
 */
function pow(x: number, y: number): number {
  let z: number
  let ax: number
  let zH: number
  let zL: number
  let pH: number
  let pL: number
  let y1: number
  let t1: number
  let t2: number
  let r: number
  let s: number
  let t: number
  let u: number
  let v: number
  let w: number
  let i: number
  let j: number
  let k: number
  let n: number

  scratch.setFloat64(0, x, true)
  const hx = scratch.getInt32(4, true)
  const lx = scratch.getUint32(0, true)
  scratch.setFloat64(0, y, true)
  const hy = scratch.getInt32(4, true)
  const ly = scratch.getUint32(0, true)
  let ix = hx & 0x7fffffff
  const iy = hy & 0x7fffffff

  // y==zero: x**0 = 1
  if ((iy | ly) === 0) return 1.0

  // +-NaN return x+y
  if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lx !== 0) || iy > 0x7ff00000 || (iy === 0x7ff00000 && ly !== 0)) {
    return x + y
  }

  // determine if y is an odd int when x < 0
  // yisint = 0 ... y is not an integer; 1 ... odd int; 2 ... even int
  let yisint = 0
  if (hx < 0) {
    if (iy >= 0x43400000) yisint = 2 // even integer y
    else if (iy >= 0x3ff00000) {
      k = (iy >> 20) - 0x3ff // exponent
      if (k > 20) {
        j = ly >>> (52 - k)
        if (j << (52 - k) >>> 0 === ly) yisint = 2 - (j & 1)
      } else if (ly === 0) {
        j = iy >> (20 - k)
        if (j << (20 - k) === iy) yisint = 2 - (j & 1)
      }
    }
  }

  // special value of y
  if (ly === 0) {
    if (iy === 0x7ff00000) {
      // y is +-inf
      if (((ix - 0x3ff00000) | lx) === 0) return y - y // (+-1)**+-inf is NaN
      else if (ix >= 0x3ff00000) return hy >= 0 ? y : 0.0 // (|x|>1)**+-inf = inf,0
      else return hy < 0 ? -y : 0.0 // (|x|<1)**-,+inf = inf,0
    }
    if (iy === 0x3ff00000) {
      // y is +-1
      if (hy < 0) return 1.0 / x
      else return x
    }
    if (hy === 0x40000000) return x * x // y is 2
    if (hy === 0x3fe00000) {
      // y is 0.5
      if (hx >= 0) return Math.sqrt(x) // x >= +0
    }
  }

  ax = Math.abs(x)
  // special value of x
  if (lx === 0) {
    if (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000) {
      z = ax // x is +-0,+-inf,+-1
      if (hy < 0) z = 1.0 / z // z = (1/|x|)
      if (hx < 0) {
        if (((ix - 0x3ff00000) | yisint) === 0) {
          z = (z - z) / (z - z) // (-1)**non-int is NaN
        } else if (yisint === 1) z = -z // (x<0)**odd = -(|x|**odd)
      }
      return z
    }
  }

  n = (hx >> 31) + 1

  // (x<0)**(non-int) is NaN
  if ((n | yisint) === 0) return (x - x) / (x - x)

  s = 1.0 // s (sign of result -ve**odd) = -1 else = 1
  if ((n | (yisint - 1)) === 0) s = -1.0 // (-ve)**(odd int)

  // |y| is huge
  if (iy > 0x41e00000) {
    // if |y| > 2**31
    if (iy > 0x43f00000) {
      // if |y| > 2**64, must o/uflow
      if (ix <= 0x3fefffff) return hy < 0 ? HUGE * HUGE : TINY * TINY
      if (ix >= 0x3ff00000) return hy > 0 ? HUGE * HUGE : TINY * TINY
    }
    // over/underflow if x is not close to one
    if (ix < 0x3fefffff) return hy < 0 ? s * HUGE * HUGE : s * TINY * TINY
    if (ix > 0x3ff00000) return hy > 0 ? s * HUGE * HUGE : s * TINY * TINY
    // now |1-x| is tiny <= 2**-20, suffice to compute
    // log(x) by x-x^2/2+x^3/3-x^4/4
    t = ax - 1.0 // t has 20 trailing zeros
    w = t * t * (0.5 - t * (THIRD - t * 0.25))
    u = IVLN2_H * t // ivln2_h has 21 sig. bits
    v = t * IVLN2_L - w * IVLN2
    t1 = clearLow(u + v)
    t2 = v - (t1 - u)
  } else {
    n = 0
    // take care subnormal number
    if (ix < 0x00100000) {
      ax *= TWO53
      n -= 53
      ix = highWord(ax)
    }
    n += (ix >> 20) - 0x3ff
    j = ix & 0x000fffff
    // determine interval
    ix = j | 0x3ff00000 // normalize ix
    if (j <= 0x3988e) k = 0 // |x|<sqrt(3/2)
    else if (j < 0xbb67a) k = 1 // |x|<sqrt(3)
    else {
      k = 0
      n += 1
      ix -= 0x00100000
    }
    ax = fromWords(ix, lowWord(ax))

    // compute ss = s_h+s_l = (x-1)/(x+1) or (x-1.5)/(x+1.5)
    u = ax - BP[k]! // bp[0]=1.0, bp[1]=1.5
    v = 1.0 / (ax + BP[k]!)
    const ss = u * v
    const sH = clearLow(ss)
    // t_h=ax+bp[k] High
    let tH = fromWords(((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18), 0)
    let tL = ax - (tH - BP[k]!)
    const sL = v * (u - sH * tH - sH * tL)
    // compute log(ax)
    let s2 = ss * ss
    r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))))
    r += sL * (sH + ss)
    s2 = sH * sH
    tH = clearLow(3.0 + s2 + r)
    tL = r - (tH - 3.0 - s2)
    // u+v = ss*(1+...)
    u = sH * tH
    v = sL * tH + tL * ss
    // 2/(3log2)*(ss+...)
    pH = clearLow(u + v)
    pL = v - (pH - u)
    zH = CP_H * pH // cp_h+cp_l = 2/(3*log2)
    zL = CP_L * pH + pL * CP + DP_L[k]!
    // log2(ax) = (ss+..)*2/(3*log2) = n + dp_h + z_h + z_l
    t = n
    t1 = clearLow(zH + zL + DP_H[k]! + t)
    t2 = zL - (t1 - t - DP_H[k]! - zH)
  }

  // split up y into y1+y2 and compute (y1+y2)*(t1+t2)
  y1 = clearLow(y)
  pL = (y - y1) * t1 + y * t2
  pH = y1 * t1
  z = pL + pH
  scratch.setFloat64(0, z, true)
  j = scratch.getInt32(4, true)
  i = scratch.getInt32(0, true)
  if (j >= 0x40900000) {
    // z >= 1024
    if (((j - 0x40900000) | i) !== 0) return s * HUGE * HUGE // if z > 1024: overflow
    else if (pL + OVT > z - pH) return s * HUGE * HUGE // overflow
  } else if ((j & 0x7fffffff) >= 0x4090cc00) {
    // z <= -1075
    if (j !== (0xc090cc00 | 0) || i !== 0) return s * TINY * TINY // z < -1075: underflow
    else if (pL <= z - pH) return s * TINY * TINY // underflow
  }
  // compute 2**(p_h+p_l)
  i = j & 0x7fffffff
  k = (i >> 20) - 0x3ff
  n = 0
  if (i > 0x3fe00000) {
    // if |z| > 0.5, set n = [z+0.5]
    n = j + (0x00100000 >> (k + 1))
    k = ((n & 0x7fffffff) >> 20) - 0x3ff // new k for n
    t = fromWords(n & ~(0x000fffff >> k), 0)
    n = ((n & 0x000fffff) | 0x00100000) >> (20 - k)
    if (j < 0) n = -n
    pH -= t
  }
  t = clearLow(pL + pH)
  u = t * LG2_H
  v = (pL - (t - pH)) * LG2 + t * LG2_L
  z = u + v
  w = v - (z - u)
  t = z * z
  t1 = z - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))))
  r = (z * t1) / (t1 - 2.0) - (w + z * w)
  z = 1.0 - (r - z)
  j = (highWord(z) | 0) + (n << 20)
  if (j >> 20 <= 0) z = scalbn(z, n) // subnormal output
  else z = fromWords(j, lowWord(z))
  return s * z
}

/**
 * Bit-reproducible math: identical results on every ECMA-262 engine.
 *
 * - `sin`, `cos`: musl libm ports, < 1 ulp from the true result; ±0, ±∞,
 *   NaN and subnormals follow C99 Annex F; huge arguments reduce exactly
 *   (Payne–Hanek).
 * - `sqrt`: `Math.sqrt`, which IEEE-754 already makes correctly rounded;
 *   re-exported so authors need one namespace.
 * - `atan2`, `hypot` (2.2): musl libm ports, < 1 ulp; specials follow C99
 *   Annex F (the same as `Math.atan2` / two-argument `Math.hypot`).
 * - `pow` (2.2): a port of fdlibm `e_pow.c`, < 1 ulp; specials follow
 *   ECMAScript `**` (`(±1) ** ±Infinity` and `1 ** NaN` are NaN, where C99
 *   Annex F says 1).
 *
 * Authoritative (deterministic) systems use these instead of `Math.sin` /
 * `Math.cos` (SPEC §8). `@domecs/rules` evaluates `sin()` / `cos()` with them.
 */
export const dmath: Readonly<{
  sin(x: number): number
  cos(x: number): number
  /** = Math.sqrt (correctly rounded by IEEE-754; re-exported so authors need one namespace). */
  sqrt(x: number): number
  /** Angle of (x, y) from the +x axis in (-π, π] (musl `atan2`; 2.2). */
  atan2(y: number, x: number): number
  /** sqrt(x² + y²) without undue overflow or underflow (musl `hypot`; 2.2). */
  hypot(x: number, y: number): number
  /** x raised to y (fdlibm `e_pow.c`; specials as ECMAScript `**`; 2.2). */
  pow(x: number, y: number): number
}> = Object.freeze({
  sin,
  cos,
  sqrt: Math.sqrt,
  atan2,
  hypot,
  pow,
})
