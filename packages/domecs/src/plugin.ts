import type { DomecsError } from './errors.js'
import { err, normalizeCause, ok, type Result } from './result.js'
import type { WorldSnapshot } from './snapshot.js'
import type { World } from './world.js'

/**
 * Lifecycle contract for a plugin (SPEC §9.1, doc/BETTER_ERRORS.md Phase 1).
 *
 * `install` returns a `Result`: success carries an optional `PluginHandle`
 * (lifecycle hooks + teardown); failure carries a `DomecsError` and is
 * quarantined — provided capabilities are unwound, but the world keeps
 * running. Throws from `install` are treated as failures and normalized
 * into `{ kind: 'plugin_install_failed', plugin, cause }`.
 */
export interface Plugin<O = void> {
  readonly name: string
  readonly version?: string
  readonly depends?: readonly string[]
  readonly provides?: readonly string[]
  install(world: World, options: O): Result<PluginHandle | void, DomecsError>
}

export interface PluginHandle {
  teardown?(): void
  onTickStart?(world: World): void
  onTickEnd?(world: World): void
  onRender?(world: World): void
  /** Typed snapshot hook (TYPE_EVAL §3.2b — subsumed by BETTER_ERRORS Phase 1). */
  onSnapshot?(snap: WorldSnapshot): WorldSnapshot
  onRestore?(snap: WorldSnapshot): WorldSnapshot
}

export interface Capability<K extends string> {
  readonly name: K
}

export interface InstalledPlugin {
  plugin: Plugin<unknown>
  handle: PluginHandle | null
  options: unknown
}

export interface PluginRegistry {
  use<O>(plugin: Plugin<O>, options?: O): Result<() => void, DomecsError>
  capability<K extends string>(name: K): Capability<K>
  list(): ReadonlyArray<InstalledPlugin>
  callTickStart(world: World): void
  callTickEnd(world: World): void
  callRender(world: World): void
  teardownAll(): void
}

export function createPluginRegistry(world: World): PluginRegistry {
  const byName = new Map<string, InstalledPlugin>()
  const order: InstalledPlugin[] = []
  const capabilities = new Map<string, Record<string, unknown>>()
  const capabilityOwner = new Map<string, string>()

  function getOrCreateCapability(name: string): Record<string, unknown> {
    let cap = capabilities.get(name)
    if (!cap) {
      cap = { name }
      capabilities.set(name, cap)
    }
    return cap
  }

  function use<O>(plugin: Plugin<O>, options?: O): Result<() => void, DomecsError> {
    if (byName.has(plugin.name)) {
      // Re-installation is a programmer error (the contract is "unique name
      // per world"), not a recoverable seam — keep the throw.
      throw new Error(`domecs: plugin "${plugin.name}" is already installed`)
    }
    const depends = plugin.depends ?? []
    for (const dep of depends) {
      if (!byName.has(dep)) {
        throw new Error(
          `domecs: plugin "${plugin.name}" requires "${dep}" which is not installed (SPEC §9.2 topological order)`,
        )
      }
    }
    const provides = plugin.provides ?? []
    for (const cap of provides) {
      if (capabilityOwner.has(cap)) {
        throw new Error(
          `domecs: capability "${cap}" already provided by "${capabilityOwner.get(cap)}"; "${plugin.name}" cannot also provide it (SPEC §9.3)`,
        )
      }
    }
    for (const cap of provides) {
      capabilityOwner.set(cap, plugin.name)
      getOrCreateCapability(cap)
    }

    // Quarantine install failures: thrown or returned err() both unwind
    // provided capabilities and surface as plugin_install_failed.
    let installResult: Result<PluginHandle | void, DomecsError>
    try {
      installResult = plugin.install(world, options as O)
    } catch (e) {
      for (const cap of provides) {
        capabilityOwner.delete(cap)
        capabilities.delete(cap)
      }
      return err({
        kind: 'plugin_install_failed',
        plugin: plugin.name,
        cause: normalizeCause(e),
      })
    }

    if (!installResult.ok) {
      for (const cap of provides) {
        capabilityOwner.delete(cap)
        capabilities.delete(cap)
      }
      return installResult
    }

    const handle: PluginHandle | null = installResult.value ?? null
    const entry: InstalledPlugin = {
      plugin: plugin as Plugin<unknown>,
      handle,
      options,
    }
    byName.set(plugin.name, entry)
    order.push(entry)

    let torn = false
    const dispose = (): void => {
      if (torn) return
      torn = true
      const idx = order.indexOf(entry)
      if (idx >= 0) order.splice(idx, 1)
      byName.delete(plugin.name)
      for (const cap of provides) {
        capabilityOwner.delete(cap)
        capabilities.delete(cap)
      }
      if (handle?.teardown) handle.teardown()
    }
    return ok(dispose)
  }

  function capability<K extends string>(name: K): Capability<K> {
    return getOrCreateCapability(name) as unknown as Capability<K>
  }

  function callTickStart(w: World): void {
    for (const e of order) if (e.handle?.onTickStart) e.handle.onTickStart(w)
  }

  function callTickEnd(w: World): void {
    for (const e of order) if (e.handle?.onTickEnd) e.handle.onTickEnd(w)
  }

  function callRender(w: World): void {
    for (const e of order) if (e.handle?.onRender) e.handle.onRender(w)
  }

  function teardownAll(): void {
    for (let i = order.length - 1; i >= 0; i--) {
      const e = order[i]!
      if (e.handle?.teardown) e.handle.teardown()
    }
    order.length = 0
    byName.clear()
    capabilities.clear()
    capabilityOwner.clear()
  }

  return { use, capability, list: () => order, callTickStart, callTickEnd, callRender, teardownAll }
}
