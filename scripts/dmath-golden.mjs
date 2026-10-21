#!/usr/bin/env node
/**
 * Golden vectors for `dmath` (spec §4.2 test 1; plan E2.1; ledger O-75).
 *
 *   pnpm --filter @domecs/core build
 *   node scripts/dmath-golden.mjs          # check test/golden/dmath-vectors.json
 *   node scripts/dmath-golden.mjs --write  # regenerate it
 *
 * Builds ~3000 inputs (specials and branch thresholds, multiples and
 * near-multiples of pi/2 up to 2^1023, subnormals, a seeded random spread,
 * then a few inputs that reach rare argument-reduction branches),
 * evaluates the built `dmath.sin` / `dmath.cos`, and reviews every output
 * against `Math.*`: more than 1 ulp anywhere is a port bug and aborts.
 * Vectors are 16-digit hex bit patterns `[x, sin(x), cos(x)]`; a NaN output
 * is written as `"nan"` (engines may differ in NaN sign/payload, which no
 * caller can observe without bit-casting).
 *
 * From 2.2 (plan E10.1) it also writes `test/golden/dmath2-vectors.json`:
 * `[a, b, f(a, b)]` rows for `atan2(y, x)`, `hypot(x, y)` and `pow(x, y)`
 * (specials crossed with specials, every branch threshold of the musl /
 * fdlibm sources, then a seeded spread). Review: atan2 and pow within 1 ulp
 * of `Math.*`, hypot within 1 ulp of the exact (BigInt) result — V8's
 * `Math.hypot` is itself sometimes more than 1 ulp off — and pow in fdlibm's
 * known weak region (|1 - x| <= 2^-20 with |y| > 2^31) within 2^-40
 * relative.
 *
 * Once committed, the golden pins the port: `packages/domecs/test/dmath.test.ts`
 * asserts bit equality, so a transcription slip or an "optimization" that
 * reassociates an expression fails loudly. Regenerate only for a deliberate
 * algorithm change, and say so in the CHANGELOG.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distEntry = path.join(root, 'packages/domecs/dist/dmath.js')
const outFile = path.join(root, 'test/golden/dmath-vectors.json')
const outFile2 = path.join(root, 'test/golden/dmath2-vectors.json')

if (!fs.existsSync(distEntry)) {
  console.error(`missing ${path.relative(root, distEntry)}; run: pnpm --filter @domecs/core build`)
  process.exit(2)
}
const { dmath } = await import(pathToFileURL(distEntry).href)

const dv = new DataView(new ArrayBuffer(8))
const bitsOf = (x) => {
  dv.setFloat64(0, x, true)
  return dv.getBigUint64(0, true)
}
const fromBits = (b) => {
  dv.setBigUint64(0, BigInt.asUintN(64, b), true)
  return dv.getFloat64(0, true)
}
const fromWords = (hi, lo) => fromBits((BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0))
const hex = (x) => (Number.isNaN(x) ? 'nan' : bitsOf(x).toString(16).padStart(16, '0'))

/** Ordinal distance in doubles (NaN only matches NaN). */
function ulps(a, b) {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b) ? 0n : 1n << 62n
  const ord = (x) => {
    const v = bitsOf(x)
    return v >> 63n ? -(v & ((1n << 63n) - 1n)) : v
  }
  const d = ord(a) - ord(b)
  return d < 0n ? -d : d
}

/** mulberry32, fixed seed: the inputs are part of the golden. */
let state = 0xd3a7 >>> 0
function next() {
  state = (state + 0x6d2b79f5) >>> 0
  let t = state
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return (t ^ (t >>> 14)) >>> 0
}

const inputs = []
const seen = new Set()
function add(x) {
  const key = Number.isNaN(x) ? 'nan' : bitsOf(x).toString(16)
  if (seen.has(key)) return
  seen.add(key)
  inputs.push(x)
}
function addAround(x, spread = 1) {
  for (let d = -spread; d <= spread; d++) {
    const y = fromBits(bitsOf(x) + BigInt(d))
    if (!Number.isNaN(y)) add(y)
  }
}

// 1. Specials (C99 Annex F) and every branch threshold in sin/cos/__rem_pio2.
for (const x of [0, -0, Infinity, -Infinity, NaN, Number.MAX_VALUE, -Number.MAX_VALUE]) add(x)
const thresholds = [
  0x3e46a09e, // cos: |x| < 2^-27 * sqrt(2)
  0x3e500000, // sin: |x| < 2^-26
  0x3fe921fb, // |x| ~<= pi/4
  0x4002d97c, // ~3pi/4
  0x400f6a7a, // ~5pi/4
  0x4012d97c, // ~3pi/2
  0x4015fdbc, // ~7pi/4
  0x401921fb, // ~4pi/2
  0x401c463b, // ~9pi/4
  0x413921fb, // 2^20 * pi/2: medium/large boundary
  0x7fefffff,
]
for (const hi of thresholds) {
  for (const lo of [0, 0x54442d18, 0xffffffff]) {
    for (const s of [1, -1]) addAround(s * fromWords(hi, lo), 2)
  }
}

// 2. Multiples and near-multiples of pi/2 (cancellation), small k and 2^e scaled.
const HALF_PI = fromWords(0x3ff921fb, 0x54442d18)
for (let k = 1; k <= 160; k++) {
  for (const s of [1, -1]) addAround(s * k * HALF_PI, 1)
}
for (let e = 0; e <= 1023; e += 4) {
  const p = fromWords((0x3ff + e) << 20, 0)
  addAround(p, 0)
  if (Number.isFinite(p * HALF_PI)) addAround(p * HALF_PI, 1)
}

// 3. Subnormals and tiny normals.
add(Number.MIN_VALUE)
add(-Number.MIN_VALUE)
add(fromWords(0x000fffff, 0xffffffff))
add(fromWords(0x00100000, 0))
for (let i = 0; i < 120; i++) {
  const sign = (next() & 1) << 31
  add(fromWords(sign | (next() & 0xfffff), next())) // subnormal
}
for (let i = 0; i < 60; i++) {
  const exp = 1 + (next() % 0x3e5) // tiny normals below 2^-26
  add(fromWords(((next() & 1) << 31) | (exp << 20) | (next() & 0xfffff), next()))
}

// 4. Seeded random spread until ~3000 inputs: everyday range, medium range,
//    and random exponents up to 2^1023 (Payne-Hanek).
let i = 0
while (inputs.length < 3000) {
  const u = next() / 0x100000000
  const bucket = i++ % 4
  if (bucket === 0) add((u * 2 - 1) * 4 * Math.PI)
  else if (bucket === 1) add((u * 2 - 1) * 1000)
  else if (bucket === 2) add((u * 2 - 1) * (1 << 20) * HALF_PI)
  else {
    const exp = 0x3e5 + (next() % (0x7ff - 0x3e5))
    add(fromWords(((next() & 1) << 31) | (exp << 20) | (next() & 0xfffff), next()))
  }
}

// 5. Rare reduction branches the spreads above never reach (found by mutation
//    testing; outputs checked bit for bit against musl built with
//    -ffp-contract=off). Appended after the fill so sections 1-4 are stable.
//    Keep in step with RARE_BRANCH_INPUTS in packages/domecs/test/dmath.test.ts.
for (const h of [
  '41260b1c3fbf40c2', // medium reduction: 3rd round (ex - ey > 49)
  '7506ac5b262ca1ff', // __rem_pio2_large: z == 0 after 1 - q, recomputation
  '447c54308a31bb16',
  '4d7c5c46c14b5e3d',
  '4480f0cf064dd58a', // __rem_pio2_large: q0 == 2 mask after 1 - q
  '430971c7a14c731d',
  '46051a06ed191c9d',
  '413cc07e17154ca7', // __rem_pio2_large: final z >= 2^24 split
]) {
  const x = fromBits(BigInt(`0x${h}`))
  add(x)
  add(-x)
}

// Evaluate and review against Math.*.
const vectors = []
let differing = 0
let worst = 0n
const failures = []
for (const x of inputs) {
  const s = dmath.sin(x)
  const c = dmath.cos(x)
  for (const [name, got, ref] of [
    ['sin', s, Math.sin(x)],
    ['cos', c, Math.cos(x)],
  ]) {
    const d = ulps(got, ref)
    if (d > 0n) differing++
    if (d > worst) worst = d
    if (d > 1n) failures.push(`${name}(0x${hex(x)}) = 0x${hex(got)}, Math: 0x${hex(ref)} (${d} ulp)`)
  }
  vectors.push([hex(x), hex(s), hex(c)])
}
if (failures.length > 0) {
  console.error(`dmath port disagrees with Math.* by more than 1 ulp:\n  ${failures.slice(0, 20).join('\n  ')}`)
  process.exit(1)
}

const doc = {
  algorithm: 'musl libm sin/cos (generic C, non-FMA) via @domecs/core dmath',
  generator: 'scripts/dmath-golden.mjs',
  functions: ['sin', 'cos'],
  format: '[x, sin(x), cos(x)] as 16-digit hex IEEE-754 bit patterns; "nan" = any NaN',
  vectors,
}
const body =
  JSON.stringify({ ...doc, vectors: [] }, null, 2).replace(
    '"vectors": []',
    `"vectors": [\n${vectors.map((v) => `    ${JSON.stringify(v)}`).join(',\n')}\n  ]`,
  ) + '\n'

const summary = `${vectors.length} vectors; ${differing} outputs differ from this runtime's Math.* by 1 ulp (max ${worst})`

// ---------------------------------------------------------------------------
// 2.2: atan2, hypot, pow. Built after the sin/cos section so its inputs (and
// the shared generator state they consume) are unchanged.

/** floor(sqrt(n)) by Newton's method. */
function isqrt(n) {
  if (n < 2n) return n
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2))
  for (;;) {
    const y = (x + n / x) >> 1n
    if (y >= x) return x
    x = y
  }
}

/** Correctly rounded sqrt(x^2 + y^2) (exact BigInt arithmetic). */
function exactHypot(x, y) {
  x = Math.abs(x)
  y = Math.abs(y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return Math.hypot(x, y)
  if (x === 0 || y === 0) return Math.max(x, y)
  const parts = (v) => {
    const b = bitsOf(v)
    const e = Number(b >> 52n)
    const m = b & ((1n << 52n) - 1n)
    return e === 0 ? [m, -1074] : [m | (1n << 52n), e - 1075]
  }
  const [ma, ea] = parts(x)
  const [mb, eb] = parts(y)
  const e = Math.min(ea, eb)
  const sum = ((ma * ma) << BigInt(2 * (ea - e))) + ((mb * mb) << BigInt(2 * (eb - e)))
  const k = 64
  const scaled = sum << BigInt(2 * k)
  const r = isqrt(scaled)
  const sticky = r * r !== scaled
  const exp = e - k
  const top = r.toString(2).length - 1 + exp
  const lsb = Math.max(top - 52, -1074)
  const drop = BigInt(lsb - exp)
  let mant = r >> drop
  const rem = r - (mant << drop)
  const half = 1n << (drop - 1n)
  if (rem > half || (rem === half && (sticky || (mant & 1n) === 1n))) mant += 1n
  if (lsb >= -1022) return Number(mant) * fromBits(BigInt(lsb + 1023) << 52n)
  return Number(mant) * 2 ** (lsb + 1074) * Number.MIN_VALUE
}

const pairSets = { atan2: [], hypot: [], pow: [] }
const pairSeen = { atan2: new Set(), hypot: new Set(), pow: new Set() }
function addPair(fn, a, b) {
  const key = `${hex(a)}:${hex(b)}`
  if (pairSeen[fn].has(key)) return
  pairSeen[fn].add(key)
  pairSets[fn].push([a, b])
}
const around = (x, spread) => {
  const out = []
  for (let d = -spread; d <= spread; d++) {
    const y = fromBits(bitsOf(x) + BigInt(d))
    if (!Number.isNaN(y)) out.push(y)
  }
  return out
}
const randomFinite = (minExp = 0, maxExp = 2046) => {
  const exp = minExp + (next() % (maxExp - minExp + 1))
  return fromWords(((next() & 1) << 31) | (exp << 20) | (next() & 0xfffff), next())
}

// 1. Specials crossed with specials.
const SPECIALS = [
  0, -0, 1, -1, 0.5, -0.5, 2, -2, 3, -3, 1.5, Infinity, -Infinity, NaN,
  Number.MIN_VALUE, -Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, 1e-300, 1e300,
  2 ** 31 + 1, 2 ** 53, 2 ** 64 + 2 ** 12,
]
for (const fn of ['atan2', 'hypot', 'pow']) {
  for (const a of SPECIALS) for (const b of SPECIALS) addPair(fn, a, b)
}

// 2. Branch thresholds.
// atan kernel (atan2(y, 1) is atan(y)): 2^-27, 7/16, 11/16, 19/16, 39/16, 2^66.
for (const hi of [0x3e400000, 0x3fdc0000, 0x3fe60000, 0x3ff30000, 0x40038000, 0x44100000]) {
  for (const s of [1, -1]) for (const y of around(s * fromWords(hi, 0), 2)) addPair('atan2', y, 1)
}
for (let i = 0; i < 60; i++) {
  // |y/x| straddling 2^64 and 2^-64 (high-word difference 64 << 20 +- 1)
  const x = randomFinite(0x300, 0x500)
  const d = (64 << 20) + ((next() % 3) - 1)
  const hx = highWordOf(x) & 0x7fffffff
  const big = fromWords(((next() & 1) << 31) | (hx + d), next())
  addPair('atan2', big, x)
  addPair('atan2', x, big)
  addPair('atan2', x, -Math.abs(big))
}
// hypot scaling (ex > 0x3ff + 510, ey < 0x3ff - 450) and the exponent gap of 64.
for (const e of [0x3ff + 510, 0x3ff + 511, 0x3ff - 450, 0x3ff - 451]) {
  for (let i = 0; i < 6; i++) {
    const x = fromWords((e << 20) | (next() & 0xfffff), next())
    addPair('hypot', x, x * (0.25 + (next() / 0x100000000) * 0.75))
    addPair('hypot', x, fromWords(((e - 3) << 20) | (next() & 0xfffff), next()))
  }
}
for (const gap of [63, 64, 65]) {
  for (let i = 0; i < 6; i++) {
    const e = 0x200 + (next() % 0x300)
    addPair('hypot', fromWords((e << 20) | (next() & 0xfffff), next()), fromWords(((e - gap) << 20) | (next() & 0xfffff), next()))
  }
}
// pow: yisint (k > 20 and k <= 20), |y| > 2^31 and > 2^64, x near 1, subnormal
// x, the interval cuts j = 0x3988e / 0xbb67a, results at the overflow and
// underflow edges (z = 1024, z = -1075) and subnormal results.
for (const y of [3, 4, 2 ** 20 + 1, 2 ** 20 + 2, 2 ** 21 + 1, 2 ** 21 + 2, 2 ** 52 + 1, 2 ** 52 + 2, 2 ** 31 + 1.5, 7.5]) {
  addPair('pow', -1.0000001, y)
  addPair('pow', -0.9999999, -y)
  addPair('pow', -2.5, y % 64)
}
for (const hx of [0x3fefffff, 0x3ff00000]) {
  for (const hy of [0x41e00001, 0x42000000, 0x43f00000, 0x43f00001]) {
    for (let i = 0; i < 4; i++) {
      const x = fromWords(hx, next())
      const y = fromWords(hy | (next() & 0xfffff), next())
      addPair('pow', x, y)
      addPair('pow', x, -y)
    }
  }
}
for (let i = 0; i < 10; i++) addPair('pow', fromWords(next() & 0xfffff, next()), 0.5 + (next() % 8) / 8)
for (const j of [0x3988e, 0x3988f, 0xbb679, 0xbb67a]) {
  for (const lo of [0, 0xffffffff]) addPair('pow', fromWords(0x3ff00000 | j, lo), 1.7)
}
for (const z of [1024, -1075, -1074, -1022, 1023.5]) {
  for (const x of [2, 0.5, 3, 10]) {
    const y = z / Math.log2(x)
    for (const yy of around(y, 2)) addPair('pow', x, yy)
  }
}

// 3. Seeded spread to 1000+ rows per function.
for (const fn of ['atan2', 'hypot', 'pow']) {
  let b = 0
  while (pairSets[fn].length < 1200) {
    const u = () => next() / 0x100000000
    const bucket = b++ % 4
    if (fn === 'atan2') {
      if (bucket === 0) addPair(fn, (u() * 2 - 1) * 10, (u() * 2 - 1) * 10)
      else if (bucket === 1) addPair(fn, randomFinite(), randomFinite())
      else if (bucket === 2) addPair(fn, (u() * 2 - 1) * 4, 1)
      else addPair(fn, (u() * 2 - 1) * 1e6, (u() * 2 - 1) * 1e-3)
    } else if (fn === 'hypot') {
      if (bucket === 0) addPair(fn, (u() * 2 - 1) * 1000, (u() * 2 - 1) * 1000)
      else if (bucket === 1) addPair(fn, randomFinite(), randomFinite())
      else if (bucket === 2) addPair(fn, randomFinite(0x5f0, 0x7fe), randomFinite(0x5a0, 0x7fe))
      else addPair(fn, randomFinite(0, 0x200), randomFinite(0, 0x200))
    } else {
      if (bucket === 0) addPair(fn, u() * 10, (u() * 2 - 1) * 20)
      else if (bucket === 1) addPair(fn, -(u() * 10), (next() % 41) - 20)
      else if (bucket === 2) addPair(fn, Math.abs(randomFinite()), (u() * 2 - 1) * 4)
      else {
        const x = 0.5 + u() * 1.5
        addPair(fn, x, ((next() & 1 ? 1024 : -1074) / Math.log2(x)) * (1 + (u() * 2 - 1) * 1e-3))
      }
    }
  }
}

function highWordOf(x) {
  dv.setFloat64(0, x, true)
  return dv.getUint32(4, true)
}

/** fdlibm's known weak region: |1 - x| <= 2^-20 with |y| > 2^31 (see dmath.test.ts). */
const powWeak = (x, y) => Math.abs(y) > 2 ** 31 && Math.abs(Math.abs(x) - 1) <= 2 ** -20

const reference = { atan2: Math.atan2, hypot: exactHypot, pow: Math.pow }
const vectors2 = { atan2: [], hypot: [], pow: [] }
let differing2 = 0
const failures2 = []
for (const fn of ['atan2', 'hypot', 'pow']) {
  for (const [a, b] of pairSets[fn]) {
    const got = dmath[fn](a, b)
    const ref = reference[fn](a, b)
    const d = ulps(got, ref)
    if (d > 0n) differing2++
    if (d > 1n) {
      const finite = Number.isFinite(got) && Number.isFinite(ref)
      const rel = finite ? Math.abs(got - ref) / Math.max(Math.abs(ref), 2 ** -1022) : Infinity
      if (!(fn === 'pow' && powWeak(a, b) && rel <= 2 ** -40)) {
        failures2.push(`${fn}(0x${hex(a)}, 0x${hex(b)}) = 0x${hex(got)}, reference 0x${hex(ref)} (${d} ulp)`)
      }
    }
    vectors2[fn].push([hex(a), hex(b), hex(got)])
  }
}
if (failures2.length > 0) {
  console.error(`dmath port disagrees with its reference beyond the documented bound:\n  ${failures2.slice(0, 20).join('\n  ')}`)
  process.exit(1)
}

const doc2 = {
  algorithm: 'musl libm atan2 (+ atan kernel) and hypot, fdlibm 5.3 e_pow.c (generic C, non-FMA) via @domecs/core dmath',
  generator: 'scripts/dmath-golden.mjs',
  functions: ['atan2', 'hypot', 'pow'],
  format: '{ fn: [a, b, fn(a, b)] } as 16-digit hex IEEE-754 bit patterns; "nan" = any NaN; atan2(y, x), hypot(x, y), pow(x, y)',
}
const body2 =
  JSON.stringify({ ...doc2, vectors: {} }, null, 2).replace(
    '"vectors": {}',
    `"vectors": {\n${['atan2', 'hypot', 'pow']
      .map((fn) => `    "${fn}": [\n${vectors2[fn].map((v) => `      ${JSON.stringify(v)}`).join(',\n')}\n    ]`)
      .join(',\n')}\n  }`,
  ) + '\n'
const summary2 = `${vectors2.atan2.length + vectors2.hypot.length + vectors2.pow.length} vectors; ${differing2} outputs differ from their reference`

const outputs = [
  [outFile, body, summary],
  [outFile2, body2, summary2],
]
if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  for (const [file, text, sum] of outputs) {
    fs.writeFileSync(file, text)
    console.log(`wrote ${path.relative(root, file)}: ${sum}`)
  }
} else {
  let stale = false
  for (const [file, text, sum] of outputs) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    if (current !== text) {
      console.error(`${path.relative(root, file)} is stale or missing; rerun with --write (${sum})`)
      stale = true
    } else console.log(`${path.relative(root, file)} up to date: ${sum}`)
  }
  if (stale) process.exit(1)
}
