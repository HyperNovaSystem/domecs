import type { DomecsError, Result, WorldSnapshot } from '@domecs/core'
import { err, normalizeCause, ok } from '@domecs/core'

export type MigrationFailedError = Extract<DomecsError, { kind: 'migration_failed' }>

/**
 * A single-step migration: takes a snapshot at version `from` and returns
 * one at `from + 1`. Returning `err` halts the chain — the framework
 * propagates a `migration_failed` Result to the caller without touching
 * the original slot bytes.
 */
export type Migration = (snap: WorldSnapshot) => Result<WorldSnapshot, MigrationFailedError>

/** Keyed by the source version. `migrations.get(N)` returns the N → N+1 step. */
export type MigrationMap = ReadonlyMap<number, Migration>

/**
 * Applies the chain starting at `snap.version` until reaching
 * `targetVersion`. Hard-fail by default; partial loads are an explicit
 * userland recovery flow built on top of this primitive.
 *
 * Failure semantics: when a step fails, the returned `Result.err` carries
 * the `from`/`to` versions of the failing step. The caller (typically
 * {@link load}) must not write the partially-migrated snapshot back to
 * storage — the source bytes stay intact for inspection or recovery.
 *
 * Defensive guard: a migration that returns a snapshot whose version is
 * not strictly greater than the input would loop forever; this is caught
 * and reported as a non-recoverable `migration_failed`.
 */
export function migrate(
  snap: WorldSnapshot,
  targetVersion: number,
  migrations: MigrationMap,
): Result<WorldSnapshot, MigrationFailedError> {
  if (snap.version > targetVersion) {
    return err({
      kind: 'migration_failed',
      from: snap.version,
      to: targetVersion,
      reason: `snapshot version ${snap.version} is newer than supported target ${targetVersion}`,
      recoverable: false,
    })
  }
  let cur = snap
  while (cur.version < targetVersion) {
    const step = migrations.get(cur.version)
    if (!step) {
      return err({
        kind: 'migration_failed',
        from: cur.version,
        to: cur.version + 1,
        reason: `no migration registered for version ${cur.version} → ${cur.version + 1}`,
        recoverable: false,
      })
    }
    let r: Result<WorldSnapshot, MigrationFailedError>
    try {
      r = step(cur)
    } catch (cause) {
      const norm = normalizeCause(cause)
      return err({
        kind: 'migration_failed',
        from: cur.version,
        to: cur.version + 1,
        reason: norm.message,
        recoverable: false,
      })
    }
    if (!r.ok) return r
    const next = r.value
    if (next.version <= cur.version) {
      return err({
        kind: 'migration_failed',
        from: cur.version,
        to: cur.version + 1,
        reason: `migration did not advance snapshot version (still ${next.version})`,
        recoverable: false,
      })
    }
    cur = next
  }
  return ok(cur)
}
