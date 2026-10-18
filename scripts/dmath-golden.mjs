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
if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, body)
  console.log(`wrote ${path.relative(root, outFile)}: ${summary}`)
} else {
  const current = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''
  if (current !== body) {
    console.error(`${path.relative(root, outFile)} is stale or missing; rerun with --write (${summary})`)
    process.exit(1)
  }
  console.log(`${path.relative(root, outFile)} up to date: ${summary}`)
}
