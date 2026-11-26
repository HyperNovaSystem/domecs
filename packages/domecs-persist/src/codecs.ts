import type { WorldSnapshot } from '@domecs/core'
import { canonicalJson } from '@domecs/core'

/**
 * A save's wire format: a snapshot to text and back (H-11). `save()` records
 * the codec's `name` in the slot's header and `load()` picks the decoder by
 * it, so a slot always reads back with the codec that wrote it. `encode`
 * may throw (a value it cannot carry); `decode` returns what it read, which
 * `load()` then checks is a snapshot, migrates and restores.
 */
export interface SnapshotCodec {
  /** Recorded in the header: a non-empty name without line breaks. */
  readonly name: string
  encode(snap: WorldSnapshot): string
  decode(text: string): unknown
}

/**
 * The default codec: `canonicalJson` (keys sorted, `-0` kept, a non-finite
 * number or a cycle refused) and `JSON.parse`. Lossless, so a loaded world
 * hashes like the saved one; `JSON.stringify`, which `save()` used before,
 * wrote `-0` as `0` and `NaN` as `null`.
 */
export const jsonCodec: SnapshotCodec = Object.freeze({
  name: 'json',
  encode: (snap: WorldSnapshot): string => canonicalJson(snap),
  decode: (text: string): unknown => JSON.parse(text),
})

type Primitive = string | number | boolean | null

/** Entities that hold exactly one component of flat fields, as one table. */
interface ColumnTable {
  /** Component name. */
  readonly c: string
  /** Field names, in each row's order. */
  readonly k: string[]
  readonly ids: number[]
  /** Row-major values: `ids.length × k.length`. */
  readonly v: Primitive[]
}

interface ColumnarSave {
  readonly columnar: 1
  /** The snapshot without the entities that went into `tables`. */
  readonly snapshot: WorldSnapshot
  readonly tables: ColumnTable[]
}

const isPrimitive = (v: unknown): v is Primitive =>
  v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))

/**
 * P-2: most of a large world is entities that hold one component of flat
 * fields (containers, workers, tiles). This codec writes each such group —
 * same component, same field names in the same order — as a table of rows
 * under one header, and every other entity as it is: a 21,000-entity port is
 * 0.95 MB instead of 3.07 MB, no slower to write. Lossless:
 * `canonicalJson(decode(encode(s))) === canonicalJson(s)`. Ported from
 * Harbor Authority's save packer.
 */
export const columnarCodec: SnapshotCodec = Object.freeze({
  name: 'columnar',
  encode: (snap: WorldSnapshot): string => canonicalJson(pack(snap)),
  decode: (text: string): unknown => unpack(JSON.parse(text)),
})

function pack(snap: WorldSnapshot): ColumnarSave {
  const tables = new Map<string, { c: string; k: string[]; ids: number[]; v: Primitive[] }>()
  const rest: Array<WorldSnapshot['entities'][number]> = []
  for (const entity of snap.entities) {
    const names = Object.keys(entity.components)
    const value = names.length === 1 ? entity.components[names[0]!] : undefined
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      rest.push(entity)
      continue
    }
    const record = value as Record<string, unknown>
    const fields = Object.keys(record)
    if (fields.length === 0 || !fields.every((f) => isPrimitive(record[f]))) {
      rest.push(entity)
      continue
    }
    // One table per component and field order: canonical text sorts the keys of each row anyway.
    const key = JSON.stringify([names[0], fields])
    let table = tables.get(key)
    if (table === undefined) {
      table = { c: names[0]!, k: fields, ids: [], v: [] }
      tables.set(key, table)
    }
    table.ids.push(entity.id)
    for (const f of fields) table.v.push(record[f] as Primitive)
  }
  return { columnar: 1, snapshot: { ...snap, entities: rest }, tables: [...tables.values()] }
}

function unpack(raw: unknown): WorldSnapshot {
  const packed = raw as Partial<ColumnarSave> | null
  if (packed === null || typeof packed !== 'object' || packed.columnar !== 1) {
    throw new Error('not a columnar save (no "columnar": 1)')
  }
  const snap = packed.snapshot as WorldSnapshot | undefined
  if (snap === undefined || snap === null || typeof snap !== 'object' || !Array.isArray(snap.entities)) {
    throw new Error('columnar save has no snapshot with an entities array')
  }
  if (!Array.isArray(packed.tables)) throw new Error('columnar save has no tables array')
  const entities = [...snap.entities]
  for (const [i, table] of packed.tables.entries()) {
    const ok =
      table !== null &&
      typeof table === 'object' &&
      typeof table.c === 'string' &&
      Array.isArray(table.k) &&
      table.k.every((k) => typeof k === 'string') &&
      Array.isArray(table.ids) &&
      Array.isArray(table.v) &&
      table.v.length === table.ids.length * table.k.length
    if (!ok) throw new Error(`columnar save tables[${i}] is malformed`)
    const width = table.k.length
    for (let row = 0; row < table.ids.length; row++) {
      const value: Record<string, Primitive> = {}
      for (let col = 0; col < width; col++) {
        // An own data property: a field named "__proto__" must not set the prototype.
        Object.defineProperty(value, table.k[col]!, {
          value: table.v[row * width + col]!,
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
      entities.push({ id: table.ids[row]!, components: { [table.c]: value } })
    }
  }
  // restore() takes records in any order; ascending id keeps the snapshot canonical.
  entities.sort((a, b) => a.id - b.id)
  return { ...snap, entities }
}
