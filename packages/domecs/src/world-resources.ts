import { internalResource, type InternalResourceType } from './resource.js'
import { cloneSerializable } from './snapshot.js'
import type { ResourceDescriptor, ResourceType } from './types.js'

/**
 * World-singleton resource state (#16), extracted from world.ts (O-23).
 *
 * `values` holds materialized values by name; `registry` guards against two
 * ResourceType objects colliding on a name (mirrors typeRegistry).
 * Resource changes are stamped into the world's change log through
 * `recordChange`, like component marks (O-42, SPEC §2.9).
 */
export type ResourceState = ReturnType<typeof createResourceState>

export function createResourceState(recordChange: (name: string) => void) {
  const values = new Map<string, unknown>()
  const registry = new Map<string, ResourceType<unknown>>()

  function require(type: ResourceType<unknown>): InternalResourceType<unknown> {
    const existing = registry.get(type.name)
    if (existing && existing !== type) {
      throw new Error(
        `domecs: two distinct ResourceType objects share the name "${type.name}"`,
      )
    }
    const meta = internalResource(type)
    if (!existing) {
      registry.set(type.name, type)
      // O-36: a value already here for a name that was never registered
      // came from `restore()` (get/set register first). For a transient
      // resource that is a stale value from a save written before it was
      // declared transient: drop it, so the first use sees the default, as
      // `restoreValues` would have done had the type been registered.
      if (meta.__transient) values.delete(type.name)
    }
    return meta
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

  /** Register `type` (as first use would) — caller has checked conflicts. */
  function register(type: ResourceType<unknown>): void {
    require(type)
  }

  /** The registered resource type named `name`, if any. */
  function lookup(name: string): ResourceType<unknown> | undefined {
    return registry.get(name)
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
      transient: meta.__transient,
    }
  }

  /** Whether `name` is a registered transient resource (O-36). */
  function isTransient(name: string): boolean {
    const type = registry.get(name)
    return type !== undefined && internalResource(type).__transient
  }

  // #16: serialize materialized resources by name (deep-cloned like component
  // values). Returns undefined when there are none so a resource-free world's
  // snapshot omits the field entirely (byte-identical to the pre-v2 shape
  // modulo `version`). Transient resources are left out (O-36).
  function snapshotValues(): Record<string, unknown> | undefined {
    let out: Record<string, unknown> | undefined
    for (const [name, value] of values) {
      if (isTransient(name)) continue
      out ??= {}
      out[name] = cloneSerializable(value)
    }
    return out
  }

  // Validate incoming resource values for every *registered* resource type —
  // called BEFORE any state is wiped so an invalid snapshot throws cleanly
  // and leaves the world untouched. Mirrors the set() contract; names with no
  // registered type pass through (the name-keyed lazy contract). A value for
  // a registered transient resource is not applied, so it is not validated
  // either (O-36).
  function validateSnapshot(snapResources: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(snapResources)) {
      const type = registry.get(name)
      if (!type) continue
      const meta = internalResource(type)
      if (!meta.__transient) validate(meta, value, name)
    }
  }

  // #16: resource values are part of the snapshot; clear then rehydrate.
  // `registry` (type identity) persists like typeRegistry. A transient
  // resource keeps its live value (O-36).
  function clearForRestore(): void {
    for (const name of Array.from(values.keys())) {
      if (!isTransient(name)) values.delete(name)
    }
  }

  function restoreValues(snapResources: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(snapResources)) {
      if (isTransient(name)) continue
      values.set(name, cloneSerializable(value))
    }
  }

  return {
    get,
    set,
    markChanged,
    types,
    describe,
    register,
    lookup,
    isTransient,
    snapshotValues,
    validateSnapshot,
    clearForRestore,
    restoreValues,
  }
}
