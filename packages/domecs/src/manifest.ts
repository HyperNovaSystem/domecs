import type { SystemSchedule } from './scheduler.js'
import type { ComponentDescriptor, ResourceDescriptor } from './types.js'

/**
 * Serializable projection of an installed plugin for {@link WorldManifest}.
 * Deliberately NOT the internal `InstalledPlugin` (which carries live
 * `install`/`teardown` functions and arbitrary `options`) — a manifest exists
 * to be read and polled, so it stays JSON-shaped.
 */
export interface PluginManifestEntry {
  readonly name: string
  readonly version?: string
  readonly provides: readonly string[]
}

/**
 * The single machine-readable description of a live world (§6). Schema fields
 * answer "what *can* exist"; debug fields answer "what *does* exist right
 * now". All debug counts are O(1)/O(archetype) reads, never full scans, so
 * `world.describe()` is cheap enough to poll.
 */
export interface WorldManifest {
  // schema surface — composed from the describe* family
  readonly components: ComponentDescriptor[]
  readonly resources: ResourceDescriptor[]
  readonly events: { readonly name: string }[]
  readonly systems: {
    readonly name: string
    readonly schedule: SystemSchedule
    readonly enabled: boolean
  }[]
  readonly plugins: PluginManifestEntry[]
  readonly capabilities: string[]
  readonly snapshotVersion: number
  // debug-tooling necessaries (decided 2026-05-30)
  readonly entityCount: number
  readonly componentCounts: Record<string, number>
  readonly archetypes: { readonly components: string[]; readonly entityCount: number }[]
}
