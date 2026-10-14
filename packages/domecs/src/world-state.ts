import { internal } from './component.js'
import { restoreRng, type Rng } from './rng.js'
import {
  cloneSerializable,
  SNAPSHOT_VERSION,
  type WorldSnapshot,
} from './snapshot.js'
import { fixedStepsDue, type TimeState } from './time.js'
import type { ComponentType, Entity } from './types.js'
import type { SortedIdSet } from './id-set.js'
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
  readonly entities: SortedIdSet
}

export interface CompiledQuery {
  id: number
  node: QueryNode
  hasTickFilter: boolean
  hasRemoved: boolean
  matchingArchetypes: Set<ArchetypeBucket>
  structuralMembers: SortedIdSet
  onAddFns: Set<(v: EntityView) => void>
  onRemoveFns: Set<(v: EntityView) => void>
}

/**
 * F-3 drift-free fixed-step bookkeeping. Restore rebuilds it from the
 * snapshot's `scaledTime` (O-40): every field is a pure function of
 * `totalScaledSeconds` and `time.fixedStep` after a completed tick.
 */
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
  getNextId(): Entity
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
  // O-40: fixed steps the clock has accumulated but not run — normally 0;
  // positive when a tickStart hook paused the world after time advanced, or
  // when the snapshot is taken inside the fixed-step loop.
  const fixedBacklog =
    fixedStepsDue(ctx.clock.totalScaledSeconds, ctx.time.fixedStep) - ctx.clock.fixedStepsFired
  return {
    version: SNAPSHOT_VERSION,
    seed: ctx.getRand().seed(),
    tick: ctx.time.tick,
    scaledTime: ctx.clock.totalScaledSeconds,
    ...(fixedBacklog > 0 ? { fixedBacklog, fixedStep: ctx.time.fixedStep } : {}),
    entities,
    nextId: ctx.getNextId(),
    ...(resourcesSnap !== undefined ? { resources: resourcesSnap } : {}),
  }
}

/**
 * Replace world state with `s`. The caller has already passed `s` through
 * {@link validateSnapshot} — before any state is wiped, so an invalid
 * snapshot throws cleanly instead of leaving the world half-restored — and
 * hands over the clock it parsed.
 */
export function applySnapshot(ctx: WorldStateCtx, s: WorldSnapshot, clock: SnapshotClock): void {
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

  // PRNG state + tick + clock.
  ctx.setRand(restoreRng(s.seed))
  ctx.time.tick = s.tick
  ctx.time.delta = 0
  ctx.time.scaledDelta = 0
  resumeClock(ctx, clock)

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
  // O-38: honor the snapshot's id cursor so post-restore id assignment
  // matches the live world even when the max-id entity was despawned before
  // the snapshot. Older snapshots lack the field — fall back to the derived
  // cursor. Never allow a corrupt cursor to re-issue a live id.
  ctx.setNextId(Math.max(s.nextId ?? 0, maxId + 1))

  // #16: rehydrate resources by name (v1 snapshots have no `resources`,
  // leaving the world's resource set empty — defaults re-materialize lazily).
  if (s.resources) ctx.resources.restoreValues(s.resources)
}

/** The clock fields of a snapshot, validated, with absent fields defaulted. */
export interface SnapshotClock {
  readonly scaledTime: number
  readonly fixedBacklog: number
  /** The step `fixedBacklog` is counted in; undefined means this world's. */
  readonly fixedStep: number | undefined
}

/**
 * Check everything restore would reject — resource values and the clock
 * fields — without touching any state. `world.restore()` calls it on the
 * envelope the `onRestore` hooks produce, before it applies it. Returns the
 * parsed clock.
 */
export function validateSnapshot(ctx: WorldStateCtx, s: WorldSnapshot): SnapshotClock {
  // Resource values are validated for every *registered* resource type,
  // mirroring the setResource() contract; names with no registered type
  // pass through (the name-keyed lazy contract). Component values are
  // deliberately NOT validated: the live path validates only at
  // Component.create() and in-place field mutation is unvalidated, so a
  // snapshot may legitimately hold values a validator was never asked to
  // bless.
  if (s.resources) ctx.resources.validateSnapshot(s.resources)
  // O-40: absent means a pre-O-40 envelope (clock at 0). Present-but-invalid
  // — including null — is rejected rather than read as absent.
  const scaledTime = s.scaledTime === undefined ? 0 : s.scaledTime
  if (typeof scaledTime !== 'number' || !Number.isFinite(scaledTime) || scaledTime < 0) {
    throw new Error(
      `domecs: invalid snapshot scaledTime: expected a finite number >= 0, got ${String(s.scaledTime)}`,
    )
  }
  const fixedBacklog = s.fixedBacklog === undefined ? 0 : s.fixedBacklog
  if (typeof fixedBacklog !== 'number' || !Number.isInteger(fixedBacklog) || fixedBacklog < 0) {
    throw new Error(
      `domecs: invalid snapshot fixedBacklog: expected an integer >= 0, got ${String(s.fixedBacklog)}`,
    )
  }
  const fixedStep = s.fixedStep
  if (
    fixedStep !== undefined &&
    (typeof fixedStep !== 'number' || !Number.isFinite(fixedStep) || fixedStep <= 0)
  ) {
    throw new Error(
      `domecs: invalid snapshot fixedStep: expected a finite number > 0, got ${String(fixedStep)}`,
    )
  }
  return { scaledTime, fixedBacklog, fixedStep }
}

/**
 * O-40: rebuild the F-3 clock from the cumulative scaled time, using the
 * tick's own expressions (`fixedStepsDue`, the accumulator remainder), so
 * every value matches the live world bit for bit. The fixed-step count is
 * derived against this world's `fixedStep` rather than stored: a world
 * restored with a different `fixedStep` neither bursts through catch-up
 * steps nor stalls until the old count is reached. `fixedBacklog` keeps the
 * steps the live world still owed outstanding after the restore — under
 * another `fixedStep`, the time they stood for.
 */
function resumeClock(
  ctx: WorldStateCtx,
  { scaledTime, fixedBacklog, fixedStep }: SnapshotClock,
): void {
  const { clock, time } = ctx
  const quantizedMs = Math.round(scaledTime * 1000)
  // Steps the live world had run, in the step size the backlog counts in.
  const step = fixedStep ?? time.fixedStep
  const ran = Math.max(0, fixedStepsDue(scaledTime, step) - fixedBacklog)
  // Under another fixedStep, keep the fixed time those steps consumed and
  // count it in this world's steps, so the time still owed carries over
  // (within one step) rather than the number of steps.
  const fixedSteps = step === time.fixedStep ? ran : fixedStepsDue(ran * step, time.fixedStep)
  clock.totalScaledSeconds = scaledTime
  clock.lastQuantizedElapsedMs = quantizedMs
  clock.fixedStepsFired = fixedSteps
  clock.fixedStepCounter = fixedSteps
  time.elapsed = quantizedMs / 1000
  time.fixedAccumulator = scaledTime - fixedSteps * time.fixedStep
}
