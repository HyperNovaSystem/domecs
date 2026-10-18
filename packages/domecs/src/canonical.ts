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
