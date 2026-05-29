import type { Entity } from './types.js'

// v2 (review #16) added the optional `resources` field. The persist layer's
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
}

export interface WorldSnapshot {
  readonly version: number
  readonly seed: readonly [number, number, number, number]
  readonly tick: number
  readonly entities: ReadonlyArray<{
    readonly id: Entity
    readonly components: Record<string, unknown>
  }>
  /**
   * World-singleton resources, keyed by resource name (review #16, v2).
   * Omitted entirely when the world has no materialized resources. Values are
   * deep-cloned at snapshot time, like component values.
   */
  readonly resources?: Record<string, unknown>
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
