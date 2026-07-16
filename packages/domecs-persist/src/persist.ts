import type { DomecsError, Plugin, Result, World, WorldSnapshot } from '@domecs/core'
import { SNAPSHOT_VERSION, definePlugin, err, normalizeCause, ok } from '@domecs/core'
import { migrate, withBuiltinMigrations, type MigrationMap } from './migrate.js'
import type { Storage } from './storage.js'

export interface LoadOptions {
  /** Target version to migrate the snapshot to. Defaults to {@link SNAPSHOT_VERSION}. */
  targetVersion?: number
  /**
   * Migration chain keyed by source version, overlaid on the framework's
   * {@link BUILTIN_MIGRATIONS} (caller keys win). Defaults to just the
   * built-ins, so e.g. a legacy v1 save upgrades to the current version
   * transparently.
   */
  migrations?: MigrationMap
}

export interface SaveOptions {
  /**
   * Extra metadata merged into the snapshot envelope's `meta`. Sits on top
   * of any plugin-provided `meta` (from `onSnapshot`) and below the
   * auto-stamped `savedAt`, so a caller key wins over a plugin key.
   */
  meta?: Record<string, unknown>
  /**
   * Override the `savedAt` timestamp (ms epoch) written into `meta`.
   * Defaults to `Date.now()`. Provided primarily for deterministic tests.
   */
  savedAt?: number
}

/**
 * Captures `world.snapshot()`, serializes to JSON, and writes to `slot`.
 * Failures (non-serializable components, I/O) come back as `persist_io`
 * with the cause normalized via `normalizeCause`. The slot is only
 * touched when serialization succeeded — a serialization failure leaves
 * any prior contents intact.
 *
 * The optional `opts` populate the snapshot envelope's `meta`: a numeric
 * `savedAt` is always stamped (override via `opts.savedAt`) and `opts.meta`
 * keys are merged in. Three-argument callers are unaffected. The envelope is
 * `{ savedAt, ...snapshot.meta, ...opts.meta }` so a caller key overrides a
 * plugin-provided one, while `savedAt` is the default floor.
 */
export function save(
  world: World,
  storage: Storage,
  slot: string,
  opts: SaveOptions = {},
): Result<void, DomecsError> {
  const base = world.snapshot()
  const snap: WorldSnapshot = {
    ...base,
    meta: {
      savedAt: opts.savedAt ?? Date.now(),
      ...base.meta,
      ...opts.meta,
    },
  }
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(snap)
  } catch (cause) {
    return err({ kind: 'persist_io', op: 'save', cause: normalizeCause(cause), retryable: true })
  }
  if (serialized === undefined) {
    return err({
      kind: 'persist_io',
      op: 'save',
      cause: normalizeCause(
        new Error('JSON.stringify returned undefined (snapshot root was a function or symbol)'),
      ),
      retryable: true,
    })
  }
  return storage.write(slot, serialized)
}

/**
 * Reads `slot`, parses it as a `WorldSnapshot`, migrates to
 * `targetVersion` (default {@link SNAPSHOT_VERSION}), then calls
 * `world.restore`. The slot bytes are read-only here — even when
 * migration fails, the original snapshot remains intact for inspection
 * or userland recovery flows.
 *
 * Errors:
 * - `persist_io`: missing slot, malformed JSON, non-snapshot payload, or
 *   a `world.restore` throw. Empty slots use `retryable: false` (first-run
 *   is deterministic until something is saved). Prefer
 *   {@link loadIfPresent} for boot paths where "no save yet" is normal.
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
  return applyLoadedBytes(world, slot, read.value, opts)
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
  const applied = applyLoadedBytes(world, slot, read.value, opts)
  if (!applied.ok) return applied
  return ok(true)
}

function applyLoadedBytes(
  world: World,
  slot: string,
  bytes: string,
  opts: LoadOptions,
): Result<void, DomecsError> {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes)
  } catch (cause) {
    return err({ kind: 'persist_io', op: 'load', cause: normalizeCause(cause), retryable: true })
  }
  if (!isWorldSnapshot(parsed)) {
    return err({
      kind: 'persist_io',
      op: 'load',
      cause: normalizeCause(new Error(`slot "${slot}" does not contain a WorldSnapshot`)),
      retryable: true,
    })
  }
  const target = opts.targetVersion ?? SNAPSHOT_VERSION
  // Built-in framework migrations (e.g. the v1->v2 resources bump) form the
  // floor; caller-supplied steps overlay and win on collision (#16).
  const migrations: MigrationMap = withBuiltinMigrations(opts.migrations)
  const migrated = migrate(parsed, target, migrations)
  if (!migrated.ok) return migrated
  try {
    world.restore(migrated.value)
  } catch (cause) {
    return err({ kind: 'persist_io', op: 'load', cause: normalizeCause(cause), retryable: true })
  }
  return ok(undefined)
}

/**
 * Plugin that strips entities with an empty serializable component bag from
 * every `world.snapshot()` envelope via `onSnapshot`. Because `save()` calls
 * the no-arg `world.snapshot()`, this is the declarative way to get the core
 * `snapshot({ pruneEmptyEntities: true })` behavior on the persisted path:
 * transient-only entities (their components are excluded at snapshot time) and
 * bare `spawn()` entities never reach disk. Install once per world. Entities
 * that still carry any persistent component are untouched.
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
