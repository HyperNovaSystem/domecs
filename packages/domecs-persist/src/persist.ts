import type { DomecsError, Plugin, Result, World, WorldSnapshot } from '@domecs/core'
import { SNAPSHOT_VERSION, canonicalJson, definePlugin, err, normalizeCause, ok } from '@domecs/core'
import { columnarCodec, jsonCodec, type SnapshotCodec } from './codecs.js'
import { migrate, withBuiltinMigrations, type MigrationMap } from './migrate.js'
import type { Storage } from './storage.js'

/**
 * What a slot says about itself, readable without decoding the save (H-12):
 * by {@link peek} for a save menu ("Day 3 · 14:20 · $182,400"), and by
 * `LoadOptions.accept` before anything is decoded.
 */
export interface SaveHeader {
  /** The codec that wrote the body; load decodes with it. */
  readonly codec: string
  /** The snapshot's `version` (`SNAPSHOT_VERSION` of the engine that saved). */
  readonly snapshotVersion: number
  /** `meta.savedAt`: ms since the epoch, the saver's wall clock. */
  readonly savedAt: number
  /** `SaveOptions.appVersion`, when the app gave one. */
  readonly appVersion?: number | string
  /** The rest of the envelope's `meta` (plugin and caller keys); absent when empty. */
  readonly meta?: Readonly<Record<string, unknown>>
  /** Characters of the whole stored text. */
  readonly length: number
}

/** What {@link save} wrote. */
export interface SaveReport {
  readonly codec: string
  /**
   * Characters written: UTF-16 code units, what Web Storage counts against
   * its quota; for ASCII text, also the UTF-8 byte count (O-29).
   */
  readonly length: number
}

/** Options for {@link decodeSave}, and so for {@link load}. */
export interface DecodeOptions {
  /** Target version to migrate the snapshot to. Defaults to {@link SNAPSHOT_VERSION}. */
  targetVersion?: number
  /**
   * Migration chain keyed by source version, overlaid on the framework's
   * {@link BUILTIN_MIGRATIONS} (caller keys win). Defaults to just the
   * built-ins, so e.g. a legacy v1 save upgrades to the current version
   * transparently.
   */
  migrations?: MigrationMap
  /**
   * Decoders for codecs other than the built-in `json` and `columnar`,
   * found by the name in the slot's header (H-11).
   */
  codecs?: readonly SnapshotCodec[]
  /**
   * Checked against the slot's header before the body is decoded (H-12):
   * `true` loads; `false`, or a string saying why, refuses with a
   * `persist_io` error and leaves the world untouched. For a save written
   * by another format of the app (`header.appVersion`), say. A 2.x save
   * (`JSON.stringify`, `meta` last) is parsed first to read its `meta`.
   */
  accept?: (header: SaveHeader) => boolean | string
}

export type LoadOptions = DecodeOptions

export interface SaveOptions {
  /**
   * Extra metadata merged into the snapshot envelope's `meta`. Sits on top
   * of any plugin-provided `meta` (from `onSnapshot`) and below the
   * auto-stamped `savedAt`, so a caller key wins over a plugin key. It is
   * also the header's `meta` ({@link peek}): keep it small — a summary for
   * a save menu.
   */
  meta?: Record<string, unknown>
  /**
   * Override the `savedAt` timestamp (ms epoch) written into `meta`.
   * Defaults to `Date.now()`. Provided primarily for deterministic tests.
   */
  savedAt?: number
  /**
   * The app's save format, stamped into `meta.appVersion` and the header
   * (H-12), for `LoadOptions.accept` to refuse saves this build cannot
   * read. The engine never interprets it.
   */
  appVersion?: number | string
  /** The wire format (H-11). Default {@link jsonCodec}; {@link columnarCodec} for large worlds. */
  codec?: SnapshotCodec
}

const MAGIC = 'domecs-save 1'

/**
 * The envelope {@link save} writes: `world.snapshot()` with `meta`
 * stamped — `{ savedAt, appVersion?, ...snapshot.meta, ...opts.meta }`, so a
 * caller key overrides a plugin-provided one while `savedAt` is the floor.
 * For a host that encodes in a worker: take this on the main thread and
 * post it.
 */
export function prepareSave(world: World, opts: SaveOptions = {}): WorldSnapshot {
  const base = world.snapshot()
  return {
    ...base,
    meta: {
      savedAt: opts.savedAt ?? Date.now(),
      ...(opts.appVersion !== undefined ? { appVersion: opts.appVersion } : {}),
      ...base.meta,
      ...opts.meta,
    },
  }
}

/**
 * The text {@link save} writes for `snap`, without writing it (H-11). For the
 * `json` codec it is the codec's JSON (a plain snapshot, `meta` first); for
 * any other codec, a header line naming the codec, versions, `savedAt` and
 * `meta`, then the codec's body. Pure: safe in a worker. A value the codec
 * cannot carry (`NaN`, a cycle) is a `persist_io` error.
 */
export function encodeSave(
  snap: WorldSnapshot,
  opts: Pick<SaveOptions, 'codec'> = {},
): Result<{ readonly text: string; readonly header: SaveHeader }, DomecsError> {
  const codec = opts.codec ?? jsonCodec
  if (typeof codec.name !== 'string' || codec.name.length === 0 || /[\r\n]/.test(codec.name)) {
    return saveErr(new Error(`codec name must be a non-empty string without line breaks, got ${JSON.stringify(codec.name)}`))
  }
  // A snapshot that will not encode fails the same way every time (O-62).
  let body: string
  let headerText: string
  const head = headerOf(snap, codec.name)
  try {
    body = codec.encode(snap)
    if (typeof body !== 'string') throw new Error(`codec "${codec.name}" encode returned ${typeof body}, not a string`)
    headerText = canonicalJson(head)
  } catch (cause) {
    return saveErr(cause)
  }
  // A json body is a snapshot already, readable by any JSON reader and
  // peeked from its first keys; any other body needs the codec's name.
  const text = codec.name === jsonCodec.name ? body : `${MAGIC}\n${headerText}\n${body}`
  return ok({ text, header: { ...head, length: text.length } })
}

/**
 * Captures {@link prepareSave}, encodes it with `opts.codec` (default
 * {@link jsonCodec}; see {@link encodeSave}), and writes it to `slot`. Returns what
 * it wrote (O-29). Failures (a value the codec cannot carry, I/O) come back
 * as `persist_io` with the cause normalized via `normalizeCause`. The slot is
 * only touched when encoding succeeded — a failure leaves any prior
 * contents intact.
 */
export function save(
  world: World,
  storage: Storage,
  slot: string,
  opts: SaveOptions = {},
): Result<SaveReport, DomecsError> {
  const encoded = encodeSave(prepareSave(world, opts), opts)
  if (!encoded.ok) return encoded
  const written = storage.write(slot, encoded.value.text)
  if (!written.ok) return written
  return ok({ codec: encoded.value.header.codec, length: encoded.value.text.length })
}

/**
 * The header of the save in `slot`, without decoding the body (H-12): `ok(null)`
 * for an empty slot. A json save is read from its prefix; a 2.x save is
 * parsed whole.
 */
export function peek(storage: Storage, slot: string): Result<SaveHeader | null, DomecsError> {
  const read = storage.read(slot)
  if (!read.ok) return read
  if (read.value === null) return ok(null)
  const parsed = readSave(read.value, slot)
  if (!parsed.ok) return parsed
  return ok(parsed.value.header)
}

/**
 * Decode save text: read the header, check `opts.accept`, decode the body
 * with the codec the header names, check it is a snapshot and migrate it to
 * `opts.targetVersion`. Pure, the inverse of {@link encodeSave}: a host that
 * reads storage itself (or in a worker) passes the text, then
 * `world.restore(snapshot)`. Errors as {@link load}'s.
 */
export function decodeSave(
  text: string,
  opts: DecodeOptions = {},
  slot = '(text)',
): Result<{ readonly snapshot: WorldSnapshot; readonly header: SaveHeader }, DomecsError> {
  const parsed = readSave(text, slot)
  if (!parsed.ok) return parsed
  const { header } = parsed.value
  // H-12: refuse by the header, before decoding the body.
  if (opts.accept !== undefined) {
    let verdict: boolean | string
    try {
      verdict = opts.accept(header)
    } catch (cause) {
      return loadErr(cause)
    }
    if (verdict !== true) {
      const why = typeof verdict === 'string' && verdict.length > 0 ? verdict : 'LoadOptions.accept returned false'
      return loadErr(new Error(`the save in slot "${slot}" was refused: ${why}`))
    }
  }
  let value: unknown = parsed.value.decoded
  if (parsed.value.body !== undefined) {
    const codec = findCodec(header.codec, opts.codecs)
    if (codec === undefined) {
      return loadErr(new Error(`the save in slot "${slot}" was written with unknown codec "${header.codec}"; pass it in LoadOptions.codecs`))
    }
    try {
      value = codec.decode(parsed.value.body)
    } catch (cause) {
      return loadErr(cause)
    }
  }
  if (!isWorldSnapshot(value)) {
    return loadErr(new Error(`slot "${slot}" does not contain a WorldSnapshot`))
  }
  const target = opts.targetVersion ?? SNAPSHOT_VERSION
  // Built-in framework migrations (e.g. the v1->v2 resources bump) form the
  // floor; caller-supplied steps overlay and win on collision (#16).
  const migrations: MigrationMap = withBuiltinMigrations(opts.migrations)
  const migrated = migrate(value, target, migrations)
  if (!migrated.ok) return migrated
  return ok({ snapshot: migrated.value, header })
}

/**
 * Reads `slot`, decodes it ({@link decodeSave}: header, `accept`, codec,
 * migration to `targetVersion`, default {@link SNAPSHOT_VERSION}), then calls
 * `world.restore`. The slot bytes are read-only here — even when migration
 * fails, the original save remains intact for inspection or userland
 * recovery flows.
 *
 * Errors:
 * - `persist_io`: missing slot, malformed text, an unknown codec, a refusal
 *   by `accept`, a non-snapshot payload, or a `world.restore` throw. Empty
 *   slots use `retryable: false` (first-run is deterministic until something
 *   is saved). Prefer {@link loadIfPresent} for boot paths where "no save
 *   yet" is normal.
 * - `migration_failed`: any step in the chain to `targetVersion` fails.
 */
export function load(
  world: World,
  storage: Storage,
  slot: string,
  opts: LoadOptions = {},
): Result<void, DomecsError> {
  const read = storage.read(slot)
  if (!read.ok) return read
  if (read.value === null) {
    return err({
      kind: 'persist_io',
      op: 'load',
      cause: normalizeCause(new Error(`slot "${slot}" is empty`)),
      // Missing slot is deterministic until the app writes one — not a
      // transient I/O blip (O-28). First-run boot should use loadIfPresent.
      retryable: false,
    })
  }
  return applyLoadedText(world, slot, read.value, opts)
}

/**
 * Boot-friendly load (O-28): missing slot is success with `false`, not an
 * error. Real I/O / parse / migration / restore failures remain `err(...)`.
 *
 * - `ok(true)` — snapshot was loaded and restored
 * - `ok(false)` — slot was empty (first run); world is untouched
 * - `err(...)` — storage/read/parse/migrate/restore failure
 */
export function loadIfPresent(
  world: World,
  storage: Storage,
  slot: string,
  opts: LoadOptions = {},
): Result<boolean, DomecsError> {
  const read = storage.read(slot)
  if (!read.ok) return read
  if (read.value === null) return ok(false)
  const applied = applyLoadedText(world, slot, read.value, opts)
  if (!applied.ok) return applied
  return ok(true)
}

function applyLoadedText(world: World, slot: string, text: string, opts: LoadOptions): Result<void, DomecsError> {
  // The text was read; every failure from here on is in the payload and
  // repeats on retry (O-62), so none is reported as retryable.
  const decoded = decodeSave(text, opts, slot)
  if (!decoded.ok) return decoded
  try {
    world.restore(decoded.value.snapshot)
  } catch (cause) {
    return loadErr(cause)
  }
  return ok(undefined)
}

/** The header and body of save text, or a pre-header save parsed whole. */
function readSave(
  text: string,
  slot: string,
): Result<{ readonly header: SaveHeader; readonly body?: string; readonly decoded?: unknown }, DomecsError> {
  if (text.startsWith(`${MAGIC}\n`)) {
    const end = text.indexOf('\n', MAGIC.length + 1)
    if (end < 0) return loadErr(new Error(`slot "${slot}" has a save header but no body`))
    let raw: unknown
    try {
      raw = JSON.parse(text.slice(MAGIC.length + 1, end))
    } catch (cause) {
      return loadErr(cause)
    }
    const header = checkHeader(raw, text.length)
    if (typeof header === 'string') return loadErr(new Error(`slot "${slot}" has a malformed save header: ${header}`))
    return ok({ header, body: text.slice(end + 1) })
  }
  // A json save: its first keys are meta and version, read without the rest.
  const head = readJsonHead(text)
  if (head !== null) {
    const header = headerOf({ meta: head.meta, version: head.version } as unknown as WorldSnapshot, 'json')
    return ok({ header: { ...header, length: text.length }, body: text })
  }
  // Older saves (JSON.stringify, meta last) and snapshots written without
  // meta are parsed whole.
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch (cause) {
    return loadErr(cause)
  }
  if (!isWorldSnapshot(decoded)) return loadErr(new Error(`slot "${slot}" does not contain a WorldSnapshot`))
  const legacy = headerOf(decoded, 'json')
  return ok({ header: { ...legacy, length: text.length }, decoded })
}

const META_KEY = '{"meta":'
const VERSION_KEY = '"version":'

/**
 * `meta` and `version` from the start of a json save written by this
 * package (`{"meta":{…},"version":4,…`), or null when the text does not
 * start that way. Reads only that prefix.
 */
function readJsonHead(text: string): { meta: Record<string, unknown>; version: number } | null {
  if (!text.startsWith(META_KEY)) return null
  const end = endOfJsonObject(text, META_KEY.length)
  if (end < 0 || text[end] !== ',' || !text.startsWith(VERSION_KEY, end + 1)) return null
  const digits = /^\d+/.exec(text.slice(end + 1 + VERSION_KEY.length, end + 1 + VERSION_KEY.length + 16))
  if (digits === null) return null
  let meta: unknown
  try {
    meta = JSON.parse(text.slice(META_KEY.length, end))
  } catch {
    return null
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return null
  return { meta: meta as Record<string, unknown>, version: Number(digits[0]) }
}

/** The index just past the JSON object that starts at `start`, or -1. */
function endOfJsonObject(text: string, start: number): number {
  if (text[start] !== '{') return -1
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/** The header fields of `snap`'s envelope: the codec, its version, and `meta` split out. */
function headerOf(snap: WorldSnapshot, codec: string): Omit<SaveHeader, 'length'> {
  const { savedAt, appVersion, ...rest } = (snap.meta ?? {}) as Record<string, unknown>
  return {
    codec,
    snapshotVersion: snap.version,
    savedAt: typeof savedAt === 'number' && Number.isFinite(savedAt) ? savedAt : 0,
    ...(typeof appVersion === 'number' || typeof appVersion === 'string' ? { appVersion } : {}),
    ...(Object.keys(rest).length > 0 ? { meta: rest } : {}),
  }
}

/** A header read from storage, or what is wrong with it. */
function checkHeader(raw: unknown, length: number): SaveHeader | string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'not an object'
  const h = raw as Record<string, unknown>
  if (typeof h.codec !== 'string' || h.codec.length === 0) return 'codec is not a non-empty string'
  if (!Number.isInteger(h.snapshotVersion)) return 'snapshotVersion is not an integer'
  if (typeof h.savedAt !== 'number' || !Number.isFinite(h.savedAt)) return 'savedAt is not a finite number'
  if (h.appVersion !== undefined && typeof h.appVersion !== 'number' && typeof h.appVersion !== 'string') {
    return 'appVersion is not a number or a string'
  }
  if (h.meta !== undefined && (h.meta === null || typeof h.meta !== 'object' || Array.isArray(h.meta))) return 'meta is not an object'
  return {
    codec: h.codec,
    snapshotVersion: h.snapshotVersion as number,
    savedAt: h.savedAt,
    ...(h.appVersion !== undefined ? { appVersion: h.appVersion as number | string } : {}),
    ...(h.meta !== undefined ? { meta: h.meta as Record<string, unknown> } : {}),
    length,
  }
}

function findCodec(name: string, extra: readonly SnapshotCodec[] | undefined): SnapshotCodec | undefined {
  for (const c of extra ?? []) if (c.name === name) return c
  return name === jsonCodec.name ? jsonCodec : name === columnarCodec.name ? columnarCodec : undefined
}

function saveErr(cause: unknown): Result<never, DomecsError> {
  return err({ kind: 'persist_io', op: 'save', cause: normalizeCause(cause), retryable: false })
}

function loadErr(cause: unknown): Result<never, DomecsError> {
  return err({ kind: 'persist_io', op: 'load', cause: normalizeCause(cause), retryable: false })
}

/**
 * Plugin that strips entities with an empty serializable component bag from
 * every `world.snapshot()` envelope via `onSnapshot`. Because `save()` calls
 * the no-arg `world.snapshot()`, this is the declarative way to get the core
 * `snapshot({ pruneEmptyEntities: true })` behavior on the persisted path:
 * transient-only entities (their components are excluded at snapshot time) and
 * bare `spawn()` entities never reach disk. Install once per world. Entities
 * that still carry any persistent component are untouched.
 *
 * The hook runs on every `world.snapshot()`, not just `save()`: a
 * `createSnapshotHistory` undo restores a snapshot without the pruned
 * entities, so they are despawned. An entity that others refer to by id —
 * an `@domecs/scene` `Parent` group, say — needs a persistent component of
 * its own, or its references dangle (O-61).
 */
export function pruneTransientOnlyEntities(): Plugin {
  return definePlugin({
    name: 'persist:prune-transient-only-entities',
    install: () => ({
      onSnapshot: (snap) => ({
        ...snap,
        entities: snap.entities.filter((e) => Object.keys(e.components).length > 0),
      }),
    }),
  })
}

function isWorldSnapshot(v: unknown): v is WorldSnapshot {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return (
    typeof o.version === 'number' &&
    Array.isArray(o.seed) &&
    typeof o.tick === 'number' &&
    Array.isArray(o.entities)
  )
}
