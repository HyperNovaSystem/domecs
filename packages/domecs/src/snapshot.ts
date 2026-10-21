import type { ChangesSnapshot } from './change-log.js'
import type { JsonValue } from './result.js'
import type { RngState } from './rng.js'
import type { Entity } from './types.js'

// v2 added the optional `resources` field; v3 (2.1) the optional `rngRoot`,
// `rngStreams` (§4.4) and `pendingEvents` (§4.7) fields. Every snapshot a 2.1
// world writes is v3. The persist layer's built-in 1->2 and 2->3 migrations
// upgrade older saves (each is a pure version bump: an older snapshot simply
// lacks the newer optional fields). `restore()` accepts any version <= 3.
export const SNAPSHOT_VERSION = 3

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
   * data, or when another known event type shares a pending event's name
   * (the record is by name, so it could not restore as the same type).
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
  /** State of the shared stream (`world.rand`) at snapshot time. */
  readonly seed: readonly [number, number, number, number]
  /**
   * The world's root seed state — the `createWorld` seed — from which every
   * `rng: 'own'` stream derives (§4.4, v3). It never advances. Written by
   * every 2.1 snapshot. Restore adopts it, so systems registered after the
   * restore derive the streams the source world would; absent (a v2
   * snapshot), the restoring world uses its own `createWorld` root, not one
   * adopted from an earlier restore.
   */
  readonly rngRoot?: RngState
  /**
   * Current state of every own stream this world has created, by stream key
   * (the owning system's cursor key: its name, or `name#k` on a clash), v3.
   * Entries outlive their systems (a removed system's entry is kept, so a
   * re-registered system resumes it). Omitted while the world has never
   * created an own stream. Restore replaces the world's map with it and
   * re-derives, from the restored root, the stream of every registered own
   * system whose key is missing. An explicit `undefined` counts as absent,
   * so the reseed recipe `{ ...snap, seed: s, rngRoot: s, rngStreams:
   * undefined }` type-checks under `exactOptionalPropertyTypes`.
   */
  readonly rngStreams?: Readonly<Record<string, RngState>> | undefined
  /**
   * §4.4: which stream each live own-stream system holds, by cursor key,
   * for the systems whose stream key is not their cursor key (a survivor of
   * same-named systems whose first was removed holds `name#1` while its
   * cursor key is `name`). Omitted when every system holds its cursor key.
   * Restore gives each live own system the stream this names (else its
   * cursor key's), so a world built with only the current systems draws as
   * the source does.
   */
  readonly rngOwners?: Readonly<Record<string, string>> | undefined
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
    setOwn(out, k, cloneSerializable((value as Record<string, unknown>)[k]))
  }
  return out as T
}

/**
 * `out[k] = v` as an own data property. Plain assignment of `"__proto__"`
 * (an own key `JSON.parse` creates) would set `out`'s prototype instead and
 * drop the data from the copy and from its canonical hash.
 */
export function setOwn(out: Record<string, unknown>, k: string, v: unknown): void {
  if (k === '__proto__') {
    Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true })
  } else {
    out[k] = v
  }
}
