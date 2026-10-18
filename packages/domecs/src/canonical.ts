/**
 * Canonical JSON and the snapshot hash (O-11, SPEC §7.1 "Canonical form").
 *
 * `canonicalJson` is `JSON.stringify` value semantics with object keys
 * sorted by UTF-16 code unit, so two values that are equal as data
 * serialize to the same text regardless of key insertion order. It is
 * lossless where `JSON.stringify` is not: `-0` is written as the literal
 * `-0` (valid JSON; `JSON.parse('-0')` is `-0`). A non-finite number, a
 * BigInt or a cycle throws a `TypeError` naming the path, since snapshots
 * are plain data by contract.
 *
 * Everything here is a pure function of its input: no clock, no
 * randomness, identical across runs and JS engines.
 */

import type { WorldSnapshot } from './snapshot.js'
import type { Entity } from './types.js'

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function keySegment(key: string): string {
  return IDENT.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`
}

/** Render a path built from segments as `a.b[2]` (no leading dot). */
function renderPath(path: readonly string[]): string {
  const s = path.join('')
  if (s === '') return '(root)'
  return s.startsWith('.') ? s.slice(1) : s
}

function fail(what: string, path: readonly string[]): never {
  throw new TypeError(`canonicalJson: ${what} at "${renderPath(path)}" (snapshots are plain JSON data)`)
}

/**
 * Canonical JSON of any plain-data value: sorted keys, JSON value
 * semantics, lossless `-0`.
 *
 * - `undefined`, function and symbol values are omitted in objects and
 *   become `null` in arrays; at the top level they throw (no JSON text).
 * - Numbers use ECMAScript `Number::toString`, except `-0` → `-0`.
 * - `NaN`/`±Infinity`, BigInt and cycles throw `TypeError` with the path
 *   (`"entities[3].components.Body.vx"`).
 * - `toJSON` is honoured, as `JSON.stringify` does.
 */
export function canonicalJson(value: unknown): string {
  const stack = new Set<object>()
  const path: string[] = []

  // Returns undefined when the value has no JSON text (omitted in objects).
  function write(key: string, v: unknown): string | undefined {
    if (v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
      v = (v as { toJSON: (k: string) => unknown }).toJSON(key)
    }
    if (v instanceof Number) v = Number(v)
    else if (v instanceof String) v = String(v)
    else if (v instanceof Boolean) v = v.valueOf()

    switch (typeof v) {
      case 'string':
        return JSON.stringify(v)
      case 'number':
        if (!Number.isFinite(v)) fail(`non-finite number ${String(v)}`, path)
        return Object.is(v, -0) ? '-0' : String(v)
      case 'boolean':
        return v ? 'true' : 'false'
      case 'bigint':
        return fail('BigInt value', path)
      case 'undefined':
      case 'function':
      case 'symbol':
        return undefined
    }
    if (v === null) return 'null'
    const obj = v as object
    if (stack.has(obj)) fail('cycle', path)
    stack.add(obj)
    let out: string
    if (Array.isArray(obj)) {
      const parts: string[] = []
      for (let i = 0; i < obj.length; i++) {
        path.push(`[${i}]`)
        parts.push(write(String(i), obj[i]) ?? 'null')
        path.pop()
      }
      out = `[${parts.join(',')}]`
    } else {
      const rec = obj as Record<string, unknown>
      const keys = Object.keys(rec).sort()
      const parts: string[] = []
      for (const k of keys) {
        path.push(keySegment(k))
        const text = write(k, rec[k])
        path.pop()
        if (text !== undefined) parts.push(`${JSON.stringify(k)}:${text}`)
      }
      out = `{${parts.join(',')}}`
    }
    stack.delete(obj)
    return out
  }

  const text = write('', value)
  if (text === undefined) fail(`${typeof value} value has no JSON text`, path)
  return text
}

// ── Hash ────────────────────────────────────────────────────────────────

/** The algorithm behind `hashSnapshot`, `hashEntities` and `hashValue`. */
export const HASH_ALGORITHM = 'fnv1a64' as const

const HEX = '0123456789abcdef'

function hex16(n: number): string {
  return HEX[(n >>> 12) & 15]! + HEX[(n >>> 8) & 15]! + HEX[(n >>> 4) & 15]! + HEX[n & 15]!
}

/**
 * FNV-1a-64 over the UTF-8 bytes of `text`, as 16 lowercase hex chars.
 *
 * The 64-bit state is four 16-bit limbs (h0 lowest), so every intermediate
 * stays a small integer: no BigInt, synchronous, identical on every engine.
 * The prime is 2^40 + 0x1b3, so `h * prime = h * 0x1b3 + (h << 40)`; the
 * shift moves limbs up by two and bits up by eight.
 */
function fnv1a64(text: string): string {
  // Offset basis 0xcbf29ce484222325.
  let h0 = 0x2325
  let h1 = 0x8422
  let h2 = 0x9ce4
  let h3 = 0xcbf2
  const n = text.length
  for (let i = 0; i < n; i++) {
    let c = text.charCodeAt(i)
    // UTF-8 encode the code point; a lone surrogate encodes as U+FFFD,
    // matching TextEncoder.
    let bytes: number
    let b0: number
    let b1 = 0
    let b2 = 0
    let b3 = 0
    if (c < 0x80) {
      bytes = 1
      b0 = c
    } else if (c < 0x800) {
      bytes = 2
      b0 = 0xc0 | (c >> 6)
      b1 = 0x80 | (c & 63)
    } else {
      if (c >= 0xd800 && c <= 0xdfff) {
        const next = i + 1 < n ? text.charCodeAt(i + 1) : 0
        if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00)
          i++
        } else {
          c = 0xfffd
        }
      }
      if (c < 0x10000) {
        bytes = 3
        b0 = 0xe0 | (c >> 12)
        b1 = 0x80 | ((c >> 6) & 63)
        b2 = 0x80 | (c & 63)
      } else {
        bytes = 4
        b0 = 0xf0 | (c >> 18)
        b1 = 0x80 | ((c >> 12) & 63)
        b2 = 0x80 | ((c >> 6) & 63)
        b3 = 0x80 | (c & 63)
      }
    }
    for (let k = 0; k < bytes; k++) {
      h0 ^= k === 0 ? b0 : k === 1 ? b1 : k === 2 ? b2 : b3
      const t0 = Math.imul(h0, 0x1b3)
      const t1 = Math.imul(h1, 0x1b3) + (t0 >>> 16)
      const t2 = Math.imul(h2, 0x1b3) + (h0 << 8) + (t1 >>> 16)
      const t3 = Math.imul(h3, 0x1b3) + (h1 << 8) + (t2 >>> 16)
      h0 = t0 & 0xffff
      h1 = t1 & 0xffff
      h2 = t2 & 0xffff
      h3 = t3 & 0xffff
    }
  }
  return hex16(h3) + hex16(h2) + hex16(h1) + hex16(h0)
}

/** FNV-1a-64 of `canonicalJson(value)`. For metric results, act logs, doc versions. */
export function hashValue(value: unknown): string {
  return fnv1a64(canonicalJson(value))
}

// ── Snapshot scope ──────────────────────────────────────────────────────

/** Options for {@link canonicalSnapshot} and {@link hashSnapshot}. */
export interface CanonicalOptions {
  /**
   * Include `changes` (unseen marks + system cursors, O-42). Default false.
   * Pass `true` for every restore-equivalence check (fork vs live,
   * checkpoints, keyframes): `changes` decides what change-gated systems do
   * next, so two worlds with equal default hashes can still diverge.
   */
  readonly includeChanges?: boolean
  /** Include `meta`. Default false. */
  readonly includeMeta?: boolean
}

/**
 * Canonical JSON of a snapshot's simulation state. `version` (format, not
 * state), `meta` and `changes` are left out unless the options ask for
 * them; every other top-level field — `seed`, `tick`, `scaledTime`,
 * `fixedBacklog`, `fixedStep`, `nextId`, `entities`, `resources`, and the
 * fields later snapshot versions add — is state and is included.
 */
export function canonicalSnapshot(snap: WorldSnapshot, options?: CanonicalOptions): string {
  const state: Record<string, unknown> = {}
  for (const key of Object.keys(snap)) {
    if (key === 'version') continue
    if (key === 'meta' && options?.includeMeta !== true) continue
    if (key === 'changes' && options?.includeChanges !== true) continue
    state[key] = (snap as unknown as Record<string, unknown>)[key]
  }
  return canonicalJson(state)
}

/** 16 lowercase hex chars: FNV-1a-64 over the UTF-8 bytes of {@link canonicalSnapshot}. */
export function hashSnapshot(snap: WorldSnapshot, options?: CanonicalOptions): string {
  return fnv1a64(canonicalSnapshot(snap, options))
}

/**
 * Per-entity hash of each record's canonical `components`, in ascending
 * entity id. Comparing two maps localizes a divergence to the entities
 * whose hashes differ.
 */
export function hashEntities(snap: WorldSnapshot): Map<Entity, string> {
  const records = snap.entities.slice().sort((a, b) => a.id - b.id)
  const out = new Map<Entity, string>()
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!
    try {
      out.set(r.id, fnv1a64(canonicalJson(r.components)))
    } catch (e) {
      if (e instanceof TypeError) {
        throw new TypeError(`${e.message} (entity ${r.id})`)
      }
      throw e
    }
  }
  return out
}
