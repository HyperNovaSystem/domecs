import type { ChangesSnapshot } from './change-log.js'
import type { JsonValue } from './result.js'
import type { Entity } from './types.js'

// v2 added the optional `resources` field. The persist layer's
// built-in 1->2 migration upgrades older saves (a v1 snapshot simply has no
// resources).
export const SNAPSHOT_VERSION = 2

/** Options for `world.snapshot()`. */
export interface SnapshotOptions {
  /**
   * Drop entities whose serializable component bag is empty after transient
   * components are excluded — transient-only entities and bare `spawn()`
   * entities. Default `false` (every alive entity is recorded). Persisting
   * with this on keeps save files lean; the persist plugin
   * `pruneTransientOnlyEntities()` applies it to the no-arg `save()` path.
   */
  readonly pruneEmptyEntities?: boolean
  /**
   * Record the undelivered events in the snapshot's `pendingEvents` field
   * (§4.7, ED-16). Default `false`: the field is absent and restore abandons
   * the restoring world's queue, as in 2.0. Every fork, keyframe or
   * checkpoint whose future must match the live world's should pass `true`.
   * Throws `TypeError` naming the event when a pending payload is not plain
   * data.
   */
  readonly pendingEvents?: boolean
}

/**
 * One undelivered event in {@link WorldSnapshot.pendingEvents}: the event
 * type's name and a plain-data copy of its payload. `payload` is absent when
 * the payload was `undefined` (a `defineEvent<void>` event).
 */
export interface SnapshotPendingEvent {
  readonly event: string
  readonly payload?: JsonValue
}

export interface WorldSnapshot {
  readonly version: number
  readonly seed: readonly [number, number, number, number]
  readonly tick: number
  /**
   * Cumulative unquantized scaled time in seconds — the drift-free total
   * that drives the fixed-step scheduler (SPEC §2.7). Restore resumes it and
   * re-derives `time.elapsed`, the fixed-step count, and the accumulator from
   * it, so a restored world's `fixed` systems keep the live world's cadence
   * (O-40). Optional: snapshots from older builds lack it, and restore starts
   * the clock at zero.
   */
  readonly scaledTime?: number
  /**
   * Fixed steps due under `scaledTime` that had not run yet (O-40). Omitted
   * when 0 — the normal case after a completed tick. Positive when a
   * `tickStart` hook paused the world after time advanced (the live world
   * runs them on resume), or when the snapshot was taken inside the
   * fixed-step loop. Restore keeps them owed.
   */
  readonly fixedBacklog?: number
  /**
   * The `fixedStep` that `fixedBacklog` is counted in; present with it. A
   * world restored with another `fixedStep` re-counts the owed time in its
   * own steps instead of owing the same number of differently sized ones.
   */
  readonly fixedStep?: number
  readonly entities: ReadonlyArray<{
    readonly id: Entity
    readonly components: Record<string, unknown>
  }>
  /**
   * Entity-id cursor at snapshot time (O-38). Restoring honors it, so ids
   * assigned after a restore match ids assigned on the live world even when
   * the highest-id entity was despawned before the snapshot (previously the
   * cursor was re-derived as maxAliveId+1, recycling despawned ids and
   * making episodes incomparable). Optional: snapshots from older builds
   * lack it, and restore falls back to the maxAliveId+1 derivation.
   */
  readonly nextId?: number
  /**
   * World-singleton resources, keyed by resource name (v2).
   * Omitted entirely when the world has no materialized resources. Values are
   * deep-cloned at snapshot time, like component values.
   */
  readonly resources?: Record<string, unknown>
  /**
   * Change marks some system had not seen yet, with each such system's
   * position (O-42, SPEC §2.9). Restore re-issues them, so a restored
   * world's change-detection filters report what the live world's would.
   * Omitted when every system has seen every mark.
   */
  readonly changes?: ChangesSnapshot
  /**
   * Undelivered events, in bus order (by first emit of each type, then
   * payload order within a type). Present only when snapshotted with
   * `{ pendingEvents: true }` and at least one event was in flight (§4.7).
   * Restore resolves each name with `world.lookupEvent` before touching any
   * state — an unknown or ambiguous name throws — then replaces the
   * restoring world's queue with these events. Absent, restore abandons the
   * queue (2.0 behaviour).
   */
  readonly pendingEvents?: ReadonlyArray<SnapshotPendingEvent>
  readonly meta?: Record<string, unknown>
}

export function cloneSerializable<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => cloneSerializable(v)) as unknown as T
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(value as object)) {
    out[k] = cloneSerializable((value as Record<string, unknown>)[k])
  }
  return out as T
}
