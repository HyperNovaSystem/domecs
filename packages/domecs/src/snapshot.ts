import type { Entity } from './types.js'

export const SNAPSHOT_VERSION = 1

export interface WorldSnapshot {
  readonly version: number
  readonly seed: readonly [number, number, number, number]
  readonly tick: number
  readonly entities: ReadonlyArray<{
    readonly id: Entity
    readonly components: Record<string, unknown>
  }>
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
