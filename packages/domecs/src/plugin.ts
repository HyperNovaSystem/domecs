import type { World } from './world.js'

export interface Plugin {
  readonly name: string
  readonly depends?: readonly string[]
  readonly provides?: readonly string[]
  install(world: World, options?: unknown): PluginHandle | void
}

export interface PluginHandle {
  teardown?(): void
  onTickStart?(world: World): void
  onTickEnd?(world: World): void
  onRender?(world: World): void
  onSnapshot?(snap: unknown): unknown
  onRestore?(snap: unknown): unknown
}

export interface Capability<K extends string> {
  readonly name: K
}

export interface InstalledPlugin {
  plugin: Plugin
  handle: PluginHandle | null
  options: unknown
}

export interface PluginRegistry {
  use(plugin: Plugin, options?: unknown): () => void
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

  function use(plugin: Plugin, options?: unknown): () => void {
    if (byName.has(plugin.name)) {
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
    const handle = plugin.install(world, options) ?? null
    const entry: InstalledPlugin = { plugin, handle, options }
    byName.set(plugin.name, entry)
    order.push(entry)

    let torn = false
    return () => {
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
