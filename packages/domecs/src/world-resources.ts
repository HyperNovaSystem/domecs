import { internalResource, type InternalResourceType } from './resource.js'
import { cloneSerializable } from './snapshot.js'
import type { ResourceDescriptor, ResourceType } from './types.js'

/**
 * World-singleton resource state (#16), extracted from world.ts (O-23).
 *
 * `values` holds materialized values by name; `registry` guards against two
 * ResourceType objects colliding on a name (mirrors typeRegistry).
 * Resource-change tracking mirrors the component change sets: in-tick marks
 * land in `tickChanged`, between-tick marks buffer in `pendingChanged` and
 * are promoted at step 0 of the next tick (symmetric with
 * tickChanged/pendingChanged on the component side).
 */
export type ResourceState = ReturnType<typeof createResourceState>

export function createResourceState(isInTick: () => boolean) {
  const values = new Map<string, unknown>()
  const registry = new Map<string, ResourceType<unknown>>()
  const tickChanged = new Set<string>()
  const pendingChanged = new Set<string>()

  function require(type: ResourceType<unknown>): InternalResourceType<unknown> {
    const existing = registry.get(type.name)
    if (existing && existing !== type) {
      throw new Error(
        `domecs: two distinct ResourceType objects share the name "${type.name}"`,
      )
    }
    if (!existing) registry.set(type.name, type)
    return internalResource(type)
  }

  function validate(
    meta: InternalResourceType<unknown>,
    value: unknown,
    name: string,
  ): void {
    if (!meta.__validate) return
    const verdict = meta.__validate(value)
    if (verdict !== true) {
      throw new Error(`domecs: invalid resource "${name}": ${verdict}`)
    }
  }

  function recordChange(name: string): void {
    ;(isInTick() ? tickChanged : pendingChanged).add(name)
  }

  /** Step 0 buffer-and-swap: promote between-tick marks into the live set. */
  function promoteChanges(): void {
    tickChanged.clear()
    for (const name of pendingChanged) tickChanged.add(name)
    pendingChanged.clear()
  }

  function changedThisTick(name: string): boolean {
    return tickChanged.has(name)
  }

  function get<T>(type: ResourceType<T>): T | undefined {
    const meta = require(type as ResourceType<unknown>)
    if (values.has(type.name)) return values.get(type.name) as T
    if (meta.__default) {
      const value = (meta.__default as () => T)()
      validate(meta, value, type.name)
      values.set(type.name, value)
      return value
    }
    return undefined
  }

  function set<T>(type: ResourceType<T>, value: T): void {
    const meta = require(type as ResourceType<unknown>)
    validate(meta, value, type.name)
    values.set(type.name, value)
    recordChange(type.name)
  }

  function markChanged<T>(type: ResourceType<T>): void {
    require(type as ResourceType<unknown>)
    recordChange(type.name)
  }

  function types(): ResourceType<unknown>[] {
    return Array.from(registry.values())
  }

  function describe<T>(type: ResourceType<T>): ResourceDescriptor {
    const meta = require(type as ResourceType<unknown>)
    return {
      name: type.name,
      hasValue: values.has(type.name),
      hasDefault: meta.__default !== undefined,
    }
  }

  // #16: serialize materialized resources by name (deep-cloned like component
  // values). Returns undefined when there are none so a resource-free world's
  // snapshot omits the field entirely (byte-identical to the pre-v2 shape
  // modulo `version`).
  function snapshotValues(): Record<string, unknown> | undefined {
    if (values.size === 0) return undefined
    const out: Record<string, unknown> = {}
    for (const [name, value] of values) {
      out[name] = cloneSerializable(value)
    }
    return out
  }

  // Validate incoming resource values for every *registered* resource type —
  // called BEFORE any state is wiped so an invalid snapshot throws cleanly
  // and leaves the world untouched. Mirrors the set() contract; names with no
  // registered type pass through (the name-keyed lazy contract).
  function validateSnapshot(snapResources: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(snapResources)) {
      const type = registry.get(name)
      if (type) validate(internalResource(type), value, name)
    }
  }

  // #16: resource values are part of the snapshot; clear then rehydrate.
  // `registry` (type identity) persists like typeRegistry.
  function clearForRestore(): void {
    values.clear()
    tickChanged.clear()
    pendingChanged.clear()
  }

  function restoreValues(snapResources: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(snapResources)) {
      values.set(name, cloneSerializable(value))
    }
  }

  return {
    get,
    set,
    markChanged,
    types,
    describe,
    promoteChanges,
    changedThisTick,
    snapshotValues,
    validateSnapshot,
    clearForRestore,
    restoreValues,
  }
}
