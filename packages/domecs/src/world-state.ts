import { internal } from './component.js'
import { restoreRng, type Rng } from './rng.js'
import {
  cloneSerializable,
  SNAPSHOT_VERSION,
  type WorldSnapshot,
} from './snapshot.js'
import type { TimeState } from './time.js'
import type { ComponentType, Entity } from './types.js'
import type { EntityView, QueryNode } from './query.js'
import type { ResourceState } from './world-resources.js'

/**
 * Snapshot/restore mechanics, extracted from world.ts (O-23). The public
 * `World.snapshot()`/`World.restore()` stay in the factory as orchestration
 * (they run the plugin onSnapshot/onRestore hook chains); the entity/
 * resource/clock serialization work lives here, threaded through a
 * {@link WorldStateCtx} that exposes the factory's closure state.
 */

export interface ArchetypeBucket {
  readonly key: string
  readonly types: Set<string>
  readonly entities: Set<Entity>
}

export interface CompiledQuery {
  id: number
  node: QueryNode
  hasTickFilter: boolean
  hasRemoved: boolean
  matchingArchetypes: Set<ArchetypeBucket>
  structuralMembers: Set<Entity>
  onAddFns: Set<(v: EntityView) => void>
  onRemoveFns: Set<(v: EntityView) => void>
}

/** F-3 drift-free fixed-step bookkeeping, reset wholesale on restore. */
export interface StepClock {
  fixedStepCounter: number
  totalScaledSeconds: number
  fixedStepsFired: number
  lastQuantizedElapsedMs: number
}

export interface WorldStateCtx {
  alive: Set<Entity>
  stores: Map<string, Map<Entity, unknown>>
  typeRegistry: Map<string, ComponentType<unknown>>
  archetypes: Map<string, ArchetypeBucket>
  entityArchetype: Map<Entity, ArchetypeBucket>
  tickAdded: Map<string, Set<Entity>>
  tickRemoved: Map<string, Set<Entity>>
  tickChanged: Map<string, Set<Entity>>
  pendingAdded: Map<string, Set<Entity>>
  pendingRemoved: Map<string, Set<Entity>>
  pendingChanged: Map<string, Set<Entity>>
  viewCache: Map<Entity, EntityView>
  queries: CompiledQuery[]
  time: TimeState
  clock: StepClock
  resources: ResourceState
  makeView(entity: Entity): EntityView
  ensureArchetype(types: Set<string>): ArchetypeBucket
  // Reassignable factory closure vars, threaded as accessors.
  getRand(): Rng
  setRand(r: Rng): void
  setNextId(id: Entity): void
  setEmptyArch(arch: ArchetypeBucket): void
}

export function buildSnapshot(ctx: WorldStateCtx, pruneEmpty: boolean): WorldSnapshot {
  const entities: Array<{ id: Entity; components: Record<string, unknown> }> = []
  const sortedAlive = Array.from(ctx.alive).sort((a, b) => a - b)
  for (const id of sortedAlive) {
    const arch = ctx.entityArchetype.get(id)
    if (!arch) continue
    const components: Record<string, unknown> = {}
    for (const name of arch.types) {
      const type = ctx.typeRegistry.get(name)
      if (type && internal(type).__transient) continue
      const store = ctx.stores.get(name)
      if (!store) continue
      const v = store.get(id)
      if (v !== undefined) components[name] = cloneSerializable(v)
    }
    if (pruneEmpty && Object.keys(components).length === 0) continue
    entities.push({ id, components })
  }
  // #16: serialize materialized resources by name; the field is omitted
  // entirely when there are none.
  const resourcesSnap = ctx.resources.snapshotValues()
  return {
    version: SNAPSHOT_VERSION,
    seed: ctx.getRand().seed(),
    tick: ctx.time.tick,
    entities,
    ...(resourcesSnap !== undefined ? { resources: resourcesSnap } : {}),
  }
}

export function applySnapshot(ctx: WorldStateCtx, s: WorldSnapshot): void {
  // Validate incoming resource values for every *registered* resource
  // type BEFORE any state is wiped, so an invalid snapshot throws cleanly
  // and leaves the world untouched instead of half-restored. This mirrors
  // the setResource() contract; names with no registered type pass
  // through (the name-keyed lazy contract). Component values are
  // deliberately NOT re-validated here: the live path validates only at
  // Component.create() and in-place field mutation is unvalidated, so a
  // snapshot may legitimately hold values a validator was never asked to
  // bless.
  if (s.resources) ctx.resources.validateSnapshot(s.resources)

  // Wipe world state (preserve plugins, system registrations, signals).
  // Capture each live query's current members AS POPULATED VIEWS before the
  // wipe: `makeView` reads stores eagerly, so views materialized here keep
  // their component values after the stores are cleared. Index positionally
  // — `q.id` is a world-global monotonic counter, NOT an index into the live
  // `queries` array (disposed queries are spliced out), so `prevMembers[q.id]`
  // looked up the wrong/undefined set after any dispose and onRemove misfired.
  const prevViews = ctx.queries.map((q) =>
    q.onRemoveFns.size > 0 ? Array.from(q.structuralMembers, (id) => ctx.makeView(id)) : null,
  )
  ctx.alive.clear()
  ctx.stores.clear()
  ctx.archetypes.clear()
  ctx.entityArchetype.clear()
  ctx.tickAdded.clear()
  ctx.tickRemoved.clear()
  ctx.tickChanged.clear()
  ctx.pendingAdded.clear()
  ctx.pendingRemoved.clear()
  ctx.pendingChanged.clear()
  // #16: resource values are part of the snapshot; clear then rehydrate.
  // The registry (type identity) persists like `typeRegistry`.
  ctx.resources.clearForRestore()
  ctx.viewCache.clear()
  ctx.queries.forEach((q, i) => {
    const views = prevViews[i]
    if (views) for (const view of views) for (const fn of q.onRemoveFns) fn(view)
    q.matchingArchetypes.clear()
    q.structuralMembers.clear()
  })
  ctx.setEmptyArch(ctx.ensureArchetype(new Set<string>()))

  // PRNG state + tick.
  ctx.setRand(restoreRng(s.seed))
  ctx.time.tick = s.tick
  ctx.time.elapsed = 0
  ctx.time.delta = 0
  ctx.time.scaledDelta = 0
  ctx.time.fixedAccumulator = 0
  ctx.clock.fixedStepCounter = 0
  ctx.clock.totalScaledSeconds = 0
  ctx.clock.fixedStepsFired = 0
  ctx.clock.lastQuantizedElapsedMs = 0

  // Rehydrate entities + components (name-keyed; ComponentType objects
  // attach lazily when callers mutate via addComponent/markChanged).
  let maxId = -1
  for (const rec of s.entities) {
    ctx.alive.add(rec.id)
    if (rec.id > maxId) maxId = rec.id
    const types = new Set<string>()
    for (const [name, value] of Object.entries(rec.components)) {
      let store = ctx.stores.get(name)
      if (!store) {
        store = new Map()
        ctx.stores.set(name, store)
      }
      store.set(rec.id, cloneSerializable(value))
      types.add(name)
    }
    const arch = ctx.ensureArchetype(types)
    arch.entities.add(rec.id)
    ctx.entityArchetype.set(rec.id, arch)
    for (const q of ctx.queries) {
      if (q.matchingArchetypes.has(arch)) {
        q.structuralMembers.add(rec.id)
        if (q.onAddFns.size > 0) {
          const view = ctx.makeView(rec.id)
          for (const fn of q.onAddFns) fn(view)
        }
      }
    }
  }
  ctx.setNextId(maxId + 1)

  // #16: rehydrate resources by name (v1 snapshots have no `resources`,
  // leaving the world's resource set empty — defaults re-materialize lazily).
  if (s.resources) ctx.resources.restoreValues(s.resources)
}
