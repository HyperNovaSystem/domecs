import { internal } from './component.js'
import { internalResource, type InternalResourceType } from './resource.js'
import type {
  DomecsError,
  FaultEntry,
  SystemFault,
  SystemResult,
  SystemicFault,
} from './errors.js'
import { createEventBus, type EventBus, type EventType, type EventView } from './events.js'
import {
  CONSOLIDATE_FAULTS_NAME,
  CONSOLIDATE_FAULTS_PRIORITY,
  Faulted,
} from './faulted.js'
import { emptyInput, type InputSnapshot } from './input.js'
import { createPluginRegistry, type Capability, type Plugin } from './plugin.js'
import { toJsonValue, type Result } from './result.js'
import { createRng, restoreRng, type Rng, type RngState } from './rng.js'
import {
  cloneSerializable,
  SNAPSHOT_VERSION,
  type SnapshotOptions,
  type WorldSnapshot,
} from './snapshot.js'
import {
  createScheduler,
  type CompiledSystem,
  type Scheduler,
  type System,
  type SystemContext,
  type SystemDef,
  type SystemHandle,
} from './scheduler.js'
import { createSignal, type EmittableSignal, type Signal } from './signals.js'
import { createTime, type TimeState } from './time.js'
import type {
  ComponentBag,
  ComponentDescriptor,
  ComponentType,
  Entity,
  FieldKind,
  FieldSchema,
  ResourceType,
} from './types.js'
import {
  Has,
  collectChangedResourceNames,
  collectHasComponents,
  normalize,
  treeHas,
  type EntityView,
  type FieldsFromComponents,
  type QueryDef,
  type QueryHooks,
  type QueryNode,
  type QueryResult,
} from './query.js'

// Reactive delta nodes a one-shot selector cannot evaluate, and the `where`
// kind that forces per-entity predicate filtering. Shared, allocation-free.
const oneshotReactiveKinds: ReadonlySet<QueryNode['kind']> = new Set([
  'added',
  'changed',
  'removed',
  'changedResource',
])
const oneshotWhereKind: ReadonlySet<QueryNode['kind']> = new Set(['where'])
// Per-tick delta kinds that force a query to run the per-entity filter pass.
const tickFilterKinds: ReadonlySet<QueryNode['kind']> = new Set([
  'added',
  'changed',
  'removed',
  'where',
  'changedResource',
])
const changedResourceKind: ReadonlySet<QueryNode['kind']> = new Set(['changedResource'])

// Infer a reflection FieldKind from a default value's runtime type. Used by
// describeComponent when a component declares no explicit schema (#14).
function inferFieldKind(value: unknown): FieldKind {
  switch (typeof value) {
    case 'number':
      return 'number'
    case 'string':
      return 'string'
    case 'boolean':
      return 'boolean'
    case 'object':
      return value === null ? 'unknown' : 'object'
    default:
      return 'unknown'
  }
}

export interface WorldSignals {
  entitySpawned: Signal<Entity>
  entityDespawned: Signal<Entity>
  componentAdded: Signal<{ entity: Entity; type: ComponentType<unknown> }>
  componentRemoved: Signal<{ entity: Entity; type: ComponentType<unknown> }>
  tickStart: Signal<Readonly<TimeState>>
  tickEnd: Signal<Readonly<TimeState>>
  /**
   * Inspector / error-stream channel for systemic faults (no `entity` on
   * the returned `SystemFault`). Entity-scoped faults attach as `Faulted`
   * components instead; this signal carries the ones that have no entity
   * to attach to. See doc/BETTER_ERRORS.md.
   */
  faultRaised: Signal<SystemicFault>
}

export interface World {
  readonly rand: Rng
  readonly time: Readonly<TimeState>
  readonly signals: WorldSignals
  readonly events: EventView
  readonly input: InputSnapshot
  /**
   * Publish a new InputSnapshot for subsequent systems to read (SPEC §4 step 2).
   * Intended for use by the `@domecs/input` plugin at `onTickStart`; user code may
   * call it in headless tests to drive input deterministically. Replaces the
   * current snapshot wholesale; there is no merge.
   */
  setInput(snap: InputSnapshot): void
  /**
   * Public idle-driver wake (D-4). External event sources — input plugins,
   * WebSocket feeds, custom drivers — call `world.requestTick()` after they
   * mutate world state from outside a tick so the idle RAF loop schedules a
   * frame. No-op when the driver is not running, when `idle: false`, or when
   * already inside a tick.
   */
  requestTick(): void
  spawn(components?: ComponentBag): Entity
  despawn(entity: Entity): void
  has(entity: Entity, type: ComponentType<unknown>): boolean
  addComponent<T>(entity: Entity, type: ComponentType<T>, value: T): void
  removeComponent(entity: Entity, type: ComponentType<unknown>): void
  getComponent<T>(entity: Entity, type: ComponentType<T>): T | undefined
  markChanged<T>(entity: Entity, type: ComponentType<T>): void
  /**
   * Read a world-singleton resource (review #16). Returns the current value,
   * lazily materializing the declared default on first read, or `undefined`
   * when no default was declared and nothing has been set. The returned object
   * is the live singleton — mutating it mutates the resource.
   */
  resource<T>(type: ResourceType<T>): T | undefined
  /** Replace a resource's value, validate it, and mark it changed this tick. */
  setResource<T>(type: ResourceType<T>, value: T): void
  /**
   * Flag a resource as changed without replacing its value — for in-place
   * edits (`world.resource(Cfg)!.v = 2`). Fires `ChangedResource(type)` gates
   * on the next tick (or the current one, if called inside a tick).
   */
  markResourceChanged<T>(type: ResourceType<T>): void
  emit<T>(type: EventType<T>, payload: T): void
  on<T>(type: EventType<T>, fn: (e: T) => void): () => void
  /**
   * Typed overload (TYPE_EVAL §3.1): when `def.query` is a tuple of
   * `ComponentType<unknown, Name>` (typically with `as const`), the system's
   * `ctx.entities` is typed as `ReadonlyArray<EntityView<{ Name: T }>>`.
   */
  system<
    T extends ReadonlyArray<ComponentType<unknown, string>>,
    S = unknown,
  >(
    name: string,
    def: Omit<SystemDef<FieldsFromComponents<T>, S>, 'query'> & {
      query: readonly [...T]
    },
    fn: System<FieldsFromComponents<T>, S>,
  ): SystemHandle
  system(name: string, def: SystemDef, fn: System): SystemHandle
  /**
   * Set the time-scale multiplier. `0` is equivalent to {@link pause}; any
   * positive value updates the stored pre-pause scale, so a subsequent
   * {@link resume} restores the most recent positive scale (D-3). Negative
   * or non-finite values throw.
   */
  setScale(scale: number): void
  pause(): void
  resume(): void
  componentTypes(): ComponentType<unknown>[]
  /**
   * Iterate every live entity that currently holds component `type`, paired
   * with its value. Convenience over `world.query(Has(type))` + per-entity
   * `getComponent`; equivalent in semantics, cheaper at the call-site. F-10.
   */
  entitiesWith<T>(type: ComponentType<T>): Iterable<{ id: Entity; value: T }>
  archetype(entity: Entity): ComponentType<unknown>[]
  /**
   * Reflect a component's name, transient flag, default value, and field
   * schema (review #14). `fields` resolves to the explicit `schema.fields`
   * when one was declared, otherwise it is inferred from `defaults` by runtime
   * `typeof`. Lets dev tools build edit widgets from the world alone — no
   * per-app schema registry. Works on any `ComponentType` without prior
   * registration; enumerate with `componentTypes()`.
   */
  describeComponent(type: ComponentType<unknown>): ComponentDescriptor
  /**
   * Typed overload (D-2): an array of `ComponentType<T, Name>` produces a
   * `QueryResult` whose `EntityView` exposes `view.Name: T` typed fields.
   */
  query<T extends ReadonlyArray<ComponentType<unknown, string>>>(
    def: readonly [...T],
  ): QueryResult<FieldsFromComponents<T>>
  query(def: QueryDef): QueryResult
  /**
   * Leak-free one-shot selectors. Unlike `query()`, these evaluate against the
   * world's current state WITHOUT registering a live query — there is nothing
   * to dispose, so they never leak. Use them for ad-hoc reads (UI labels, AI
   * decisions, asserts) where a persistent live query would accumulate. They
   * accept the same structural defs as `query()` — `Has`/`Not`/`And`/`Or`/
   * `Where` — but reject reactive nodes (`Added`/`Changed`/`Removed`), which
   * need the per-tick delta tracking only a live query or reactive system
   * provides.
   */
  count(def: QueryDef): number
  entitiesMatching(def: QueryDef): Entity[]
  select<T extends ReadonlyArray<ComponentType<unknown, string>>>(
    def: readonly [...T],
  ): EntityView<FieldsFromComponents<T>>[]
  select(def: QueryDef): EntityView[]
  /**
   * Observe a query reactively and receive structural + optional per-tick
   * change callbacks. Returns an unsubscribe function.
   *
   * - `onAdd` / `onRemove` fire when membership changes.
   * - `onChange` requires `def` to include at least one change-detection node
   *   such as `Added(...)`, `Removed(...)`, or `Changed(...)`; plain `Has(...)`
   *   queries do not support reactive change ticks.
   * - When valid, `onChange` fires for current members on ticks where the
   *   change-detection portion of the query is non-empty.
   */
  observe(def: QueryDef, hooks: QueryHooks): () => void
  step(dt?: number): void
  stepN(n: number, dt?: number): void
  turn<T>(type: EventType<T>, payload: T, dt?: number): void
  start(options?: StartOptions): () => void
  stop(): void
  /**
   * Install a plugin. Returns `Result<dispose, DomecsError>` — failed
   * installs (thrown or returned `err()`) are quarantined: provided
   * capabilities are unwound, the world keeps running, the caller decides
   * how to surface the failure. See doc/BETTER_ERRORS.md.
   */
  use<O>(plugin: Plugin<O>, options?: O): Result<() => void, DomecsError>
  capability<K extends string>(name: K): Capability<K>
  snapshot(options?: SnapshotOptions): WorldSnapshot
  restore(snap: WorldSnapshot): void
}

export interface WorldOptions {
  seed?: number | RngState
  headless?: boolean
  fixedStep?: number
  idle?: boolean
  /**
   * Dev-mode guardrail (BETTER_ERRORS Phase 4). When true, a system that
   * returns a non-void value not shaped like `SystemResult` (e.g. typo'd
   * `{ erorrs: [...] }`) logs a one-shot console.warn naming the system.
   * Off by default — production code should not pay the shape-check cost.
   * See doc/error-handling.md.
   */
  strictReturns?: boolean
}

/**
 * Options for {@link World.start}. The rAF driver is intentionally thin:
 * compute wall-clock dt, clamp it, pipe it to `step(dt)`. Consumers that
 * need custom scheduling keep using `step()` directly.
 */
export interface StartOptions {
  /** Per-frame dt ceiling in ms (default 100). Prevents tab-return spikes
   *  from exploding into hundreds of fixed-step ticks. */
  dtClampMs?: number
  /** Pause via {@link World.pause} when `document.hidden` flips true, resume
   *  on re-show. Default true; has no effect outside a DOM. */
  pauseOnHidden?: boolean
}

interface ArchetypeBucket {
  readonly key: string
  readonly types: Set<string>
  readonly entities: Set<Entity>
}

interface CompiledQuery {
  id: number
  node: QueryNode
  hasTickFilter: boolean
  hasRemoved: boolean
  matchingArchetypes: Set<ArchetypeBucket>
  structuralMembers: Set<Entity>
  onAddFns: Set<(v: EntityView) => void>
  onRemoveFns: Set<(v: EntityView) => void>
}

export function createWorld(options: WorldOptions = {}): World {
  const seed = options.seed ?? 0
  const headless = options.headless === true
  const idle = options.idle !== false
  const strictReturns = options.strictReturns === true
  const warnedSystems = new Set<number>()
  let rand = createRng(seed)
  const fixedStep = options.fixedStep ?? 1 / 60
  const time = createTime(fixedStep)
  const bus: EventBus = createEventBus()
  let preResumeScale = 1
  let input: InputSnapshot = emptyInput()

  const sigEntitySpawned: EmittableSignal<Entity> = createSignal()
  const sigEntityDespawned: EmittableSignal<Entity> = createSignal()
  const sigComponentAdded: EmittableSignal<{ entity: Entity; type: ComponentType<unknown> }> =
    createSignal()
  const sigComponentRemoved: EmittableSignal<{ entity: Entity; type: ComponentType<unknown> }> =
    createSignal()
  const sigTickStart: EmittableSignal<Readonly<TimeState>> = createSignal()
  const sigTickEnd: EmittableSignal<Readonly<TimeState>> = createSignal()
  const sigFaultRaised: EmittableSignal<SystemicFault> = createSignal()

  const signals: WorldSignals = {
    entitySpawned: sigEntitySpawned,
    entityDespawned: sigEntityDespawned,
    componentAdded: sigComponentAdded,
    componentRemoved: sigComponentRemoved,
    tickStart: sigTickStart,
    tickEnd: sigTickEnd,
    faultRaised: sigFaultRaised,
  }

  let scheduler!: Scheduler
  let plugins!: ReturnType<typeof createPluginRegistry>
  let fixedStepCounter = 0
  // F-5: rAF driver state. `rafHandle === null` means "not running".
  let rafStarted = false
  let rafHandle: number | null = null
  let rafLastWallMs: number | null = null
  let rafVisHandler: (() => void) | null = null
  let rafWakeStep = false
  let rafDtClampMs = 100
  // F-3: drift-free fixed-step driver.
  let totalScaledSeconds = 0
  let fixedStepsFired = 0
  let lastQuantizedElapsedMs = 0
  let nextId: Entity = 0
  const alive = new Set<Entity>()
  // componentName -> Map<Entity, value>
  const stores = new Map<string, Map<Entity, unknown>>()
  // componentName -> ComponentType registered in this world
  const typeRegistry = new Map<string, ComponentType<unknown>>()

  // archetype index
  const archetypes = new Map<string, ArchetypeBucket>()
  const entityArchetype = new Map<Entity, ArchetypeBucket>()

  // per-tick change sets (live during the current tick).
  const tickAdded = new Map<string, Set<Entity>>()
  const tickRemoved = new Map<string, Set<Entity>>()
  const tickChanged = new Map<string, Set<Entity>>()
  // Pending change sets for mutations made outside any tick.
  // SPEC §2.5 / F-2: between-tick markChanged calls land here, then are
  // promoted into the per-tick maps at step 0 of the next tick — symmetric
  // with the §2.6 event buffer-and-swap.
  const pendingAdded = new Map<string, Set<Entity>>()
  const pendingRemoved = new Map<string, Set<Entity>>()
  const pendingChanged = new Map<string, Set<Entity>>()
  let inTick = false

  // World-singleton resources (review #16). `resources` holds materialized
  // values by name; `resourceRegistry` guards against two ResourceType objects
  // colliding on a name (mirrors typeRegistry). Resource-change tracking mirrors
  // the component change sets: in-tick marks land in `tickResourcesChanged`,
  // between-tick marks buffer in `pendingResourcesChanged` and are promoted at
  // step 0 of the next tick (symmetric with tickChanged/pendingChanged).
  const resources = new Map<string, unknown>()
  const resourceRegistry = new Map<string, ResourceType<unknown>>()
  const tickResourcesChanged = new Set<string>()
  const pendingResourcesChanged = new Set<string>()

  // queries
  const queries: CompiledQuery[] = []
  let nextQueryId = 0
  let nextObserverId = 0

  // P-1/P-2: EntityView cache. Each entity has at most one view object, reused
  // across query reads. Invalidated on archetype change (the only event that
  // changes which component-name keys a view should carry).
  // Component values themselves are mutated in place by systems, so the cache
  // does not need per-value invalidation — the view holds the same Map.get
  // references the live store does.
  const viewCache = new Map<Entity, EntityView>()

  const EMPTY_ARCH_KEY = ''
  let emptyArch = ensureArchetype(new Set<string>())

  function archetypeKeyFor(types: Set<string>): string {
    if (types.size === 0) return EMPTY_ARCH_KEY
    return Array.from(types).sort().join('|')
  }

  function ensureArchetype(types: Set<string>): ArchetypeBucket {
    const key = archetypeKeyFor(types)
    let bucket = archetypes.get(key)
    if (bucket) return bucket
    bucket = { key, types, entities: new Set() }
    archetypes.set(key, bucket)
    for (const q of queries) evaluateQueryAgainstArchetype(q, bucket)
    return bucket
  }

  function moveEntity(entity: Entity, nextTypes: Set<string>): void {
    const prev = entityArchetype.get(entity)
    const next = ensureArchetype(nextTypes)
    if (prev === next) return
    if (prev) prev.entities.delete(entity)
    next.entities.add(entity)
    entityArchetype.set(entity, next)
    // P-2: archetype changed — drop the cached view so the next read rebuilds
    // it against the new key set.
    viewCache.delete(entity)

    for (const q of queries) {
      const wasIn = prev ? q.matchingArchetypes.has(prev) : false
      const nowIn = q.matchingArchetypes.has(next)
      if (wasIn && !nowIn) {
        q.structuralMembers.delete(entity)
        if (q.onRemoveFns.size > 0) {
          const view = makeView(entity)
          for (const fn of q.onRemoveFns) fn(view)
        }
      } else if (!wasIn && nowIn) {
        q.structuralMembers.add(entity)
        if (q.onAddFns.size > 0) {
          const view = makeView(entity)
          for (const fn of q.onAddFns) fn(view)
        }
      }
    }
  }

  function evalStructural(node: QueryNode, types: Set<string>): boolean {
    switch (node.kind) {
      case 'has': requireRegisteredType(node.type); return types.has(node.type.name)
      case 'not': return !evalStructural(node.child, types)
      case 'or': return node.children.some((c) => evalStructural(c, types))
      case 'and': return node.children.every((c) => evalStructural(c, types))
      case 'added': requireRegisteredType(node.type); return types.has(node.type.name)
      case 'changed': requireRegisteredType(node.type); return types.has(node.type.name)
      case 'removed': return true
      case 'where': requireRegisteredType(node.type); return types.has(node.type.name)
      // Structurally neutral: a resource gate does not constrain which entities
      // match (it is a per-tick gate evaluated in evalEntity), so it must not
      // prune the And() it sits inside. See ChangedResource (#16).
      case 'changedResource': return true
    }
  }

  function evalEntity(node: QueryNode, entity: Entity): boolean {
    switch (node.kind) {
      case 'has': requireRegisteredType(node.type); return hasType(entity, node.type.name)
      case 'not': return !evalEntity(node.child, entity)
      case 'or': return node.children.some((c) => evalEntity(c, entity))
      case 'and': return node.children.every((c) => evalEntity(c, entity))
      case 'added': return (tickAdded.get(node.type.name)?.has(entity)) ?? false
      case 'changed': return (tickChanged.get(node.type.name)?.has(entity)) ?? false
      case 'removed': return (tickRemoved.get(node.type.name)?.has(entity)) ?? false
      case 'where': {
        const v = stores.get(node.type.name)?.get(entity)
        if (v === undefined) return false
        return node.predicate(v)
      }
      // Entity-independent: true for every candidate on ticks where the
      // resource changed, false otherwise — so an entity-scoped query like
      // And(Has(X), ChangedResource(R)) yields the X entities only on change
      // ticks. See ChangedResource (#16).
      case 'changedResource': return tickResourcesChanged.has(node.resource.name)
    }
  }

  function hasType(entity: Entity, name: string): boolean {
    const s = stores.get(name)
    return s ? s.has(entity) : false
  }

  // Normalize + validate a def for the one-shot selectors (count/select/
  // entitiesMatching). Reactive nodes track per-tick deltas that only a
  // registered query maintains, so they are a misuse here; reject loudly.
  function oneshotNode(def: QueryDef): { node: QueryNode; needsEntityFilter: boolean } {
    const node = normalize(def)
    if (treeHas(node, oneshotReactiveKinds)) {
      throw new Error(
        'domecs: count/select/entitiesMatching are one-shot selectors and ' +
          'cannot evaluate reactive nodes (Added/Changed/Removed) — those need ' +
          'per-tick delta tracking; use a live query() or a reactive system instead',
      )
    }
    return { node, needsEntityFilter: treeHas(node, oneshotWhereKind) }
  }

  function evaluateQueryAgainstArchetype(
    q: CompiledQuery,
    arch: ArchetypeBucket,
  ): void {
    if (evalStructural(q.node, arch.types)) {
      q.matchingArchetypes.add(arch)
    }
  }

  function buildView(entity: Entity): EntityView {
    // P-1: walk this entity's archetype, not every component store in the
    // world. For a 30-component world with a 5-component entity this drops
    // from O(30) Map.gets per view to O(5).
    const view: Record<string, unknown> = { id: entity }
    const arch = entityArchetype.get(entity)
    if (arch) {
      for (const name of arch.types) {
        const v = stores.get(name)?.get(entity)
        if (v !== undefined) view[name] = v
      }
    }
    return view as EntityView
  }

  function makeView(entity: Entity): EntityView {
    // P-2: reuse the cached view object across query reads. The cache is
    // dropped whenever the entity's archetype changes (`moveEntity`) and
    // when the entity is despawned. Within a single archetype the same
    // object is handed back, so a system iterating the same query twice in
    // one tick allocates zero views.
    const cached = viewCache.get(entity)
    if (cached) return cached
    const fresh = buildView(entity)
    viewCache.set(entity, fresh)
    return fresh
  }

  function recordChange(
    tickMap: Map<string, Set<Entity>>,
    pendingMap: Map<string, Set<Entity>>,
    name: string,
    entity: Entity,
  ): void {
    const target = inTick ? tickMap : pendingMap
    let s = target.get(name)
    if (!s) {
      s = new Set()
      target.set(name, s)
    }
    s.add(entity)
  }

  function drainInto(
    src: Map<string, Set<Entity>>,
    dst: Map<string, Set<Entity>>,
  ): void {
    for (const [name, set] of src) {
      let d = dst.get(name)
      if (!d) {
        d = new Set()
        dst.set(name, d)
      }
      for (const e of set) d.add(e)
    }
    src.clear()
  }

  function storeFor<T>(type: ComponentType<T>): Map<Entity, T> {
    let s = stores.get(type.name)
    if (!s) {
      s = new Map()
      stores.set(type.name, s)
      typeRegistry.set(type.name, type as ComponentType<unknown>)
    } else if (!typeRegistry.has(type.name)) {
      typeRegistry.set(type.name, type as ComponentType<unknown>)
    } else if (typeRegistry.get(type.name) !== type) {
      throw new Error(
        `domecs: two distinct ComponentType objects share the name "${type.name}"`,
      )
    }
    return s as Map<Entity, T>
  }

  function requireRegisteredType(type: ComponentType<unknown>): void {
    storeFor(type)
  }

  function requireRegisteredResource(
    type: ResourceType<unknown>,
  ): InternalResourceType<unknown> {
    const existing = resourceRegistry.get(type.name)
    if (existing && existing !== type) {
      throw new Error(
        `domecs: two distinct ResourceType objects share the name "${type.name}"`,
      )
    }
    if (!existing) resourceRegistry.set(type.name, type)
    return internalResource(type)
  }

  function validateResource(
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

  function recordResourceChange(name: string): void {
    ;(inTick ? tickResourcesChanged : pendingResourcesChanged).add(name)
  }

  function iterateBag(
    bag: ComponentBag,
  ): Iterable<readonly [ComponentType<unknown>, unknown]> {
    if (bag instanceof Map) return bag
    return bag as ReadonlyArray<readonly [ComponentType<unknown>, unknown]>
  }

  function assertAlive(entity: Entity): void {
    if (!alive.has(entity)) {
      throw new Error(`domecs: entity ${entity} is not alive`)
    }
  }

  function currentTypes(entity: Entity): Set<string> {
    const arch = entityArchetype.get(entity)
    return arch ? new Set(arch.types) : new Set()
  }

  function isEnabled(s: CompiledSystem): boolean {
    if (!s.enabled) return false
    if (s.def.enabled && s.def.enabled() === false) return false
    return true
  }

  function eventMatches(s: CompiledSystem, view: EventView): boolean {
    const triggers = s.def.triggers
    if (!triggers || triggers.length === 0) return true
    for (const t of triggers) {
      if (view.of(t).length > 0) return true
    }
    return false
  }

  function hasPendingComponentWork(): boolean {
    return pendingAdded.size > 0 || pendingRemoved.size > 0 || pendingChanged.size > 0
  }

  // #16: only consulted when a reactive system's reactsTo yielded zero members
  // this tick. Fires iff the reactsTo is purely resource-gated (no structural
  // Has dependency) and one of its ChangedResource targets changed this tick.
  function reactiveResourceFallback(s: CompiledSystem): boolean {
    if (!s.def.reactsTo) return false
    const node = normalize(s.def.reactsTo)
    if (!treeHas(node, changedResourceKind)) return false
    if (collectHasComponents(node).size > 0) return false
    for (const name of collectChangedResourceNames(node)) {
      if (tickResourcesChanged.has(name)) return true
    }
    return false
  }

  function hasFrameSystems(): boolean {
    for (const s of scheduler.systemsByMode('once')) {
      if (!s.ranOnce && isEnabled(s)) return true
    }
    for (const s of scheduler.systemsByMode('tick')) {
      if (!isEnabled(s)) continue
      // The built-in fault consolidator is framework infrastructure — it
      // should not keep the idle driver awake when there's nothing to
      // consolidate. Treat it as passive when its query is empty.
      if (
        s.name === CONSOLIDATE_FAULTS_NAME &&
        s.query !== undefined &&
        s.query.size === 0
      ) {
        continue
      }
      return true
    }
    if (time.scale !== 0) {
      for (const s of scheduler.systemsByMode('fixed')) {
        if (isEnabled(s)) return true
      }
    }
    return false
  }

  function shouldKeepDriverAwake(): boolean {
    if (!idle) return true
    if (hasFrameSystems()) return true
    if (hasPendingComponentWork()) return true
    if (bus.hasPending()) return true
    return false
  }

  function scheduleDriverFrame(): void {
    if (!rafStarted || rafHandle !== null) return
    const g = globalThis as unknown as {
      requestAnimationFrame?: (cb: (t: number) => void) => number
    }
    if (typeof g.requestAnimationFrame !== 'function') return
    rafHandle = g.requestAnimationFrame(frame)
  }

  function wakeDriver(): void {
    if (!rafStarted || !idle || inTick) return
    if (rafHandle !== null) return
    if (rafLastWallMs !== null) rafWakeStep = true
    scheduleDriverFrame()
  }

  function runSystem(s: CompiledSystem, view: EventView): void {
    const ctx: SystemContext = {
      // Explicit `query` wins; otherwise a reactive system's `reactsTo` delta
      // is delivered as ctx.entities (SPEC: reactive systems see the query
      // delta). Falls back to [] for systems with neither.
      entities: s.query ? s.query.entities : s.reactsTo ? s.reactsTo.entities : [],
      time,
      input,
      events: view,
      world,
      rand,
      state: s.state,
    }
    // `System` is declared as `() => void`; we shape-check for a returned
    // SystemResult at runtime (BETTER_ERRORS Phase 1: systems may opt into
    // returning faults but the common case stays void).
    const result = s.fn(ctx) as unknown
    if (
      result &&
      typeof result === 'object' &&
      Array.isArray((result as { errors?: unknown }).errors)
    ) {
      handleSystemResult(s, result as SystemResult)
    } else if (strictReturns && result != null && !warnedSystems.has(s.id)) {
      warnedSystems.add(s.id)
      // eslint-disable-next-line no-console
      console.warn(
        `domecs: system "${s.name}" returned a value that is not void or SystemResult; the value is ignored. See doc/error-handling.md.`,
      )
    }
  }

  function handleSystemResult(s: CompiledSystem, result: SystemResult): void {
    const errors = result.errors
    if (!errors || errors.length === 0) return
    for (const fault of errors) {
      const entry: FaultEntry = buildFaultEntry(s.name, fault)
      if (fault.entity === undefined) {
        sigFaultRaised.emit({ source: s.name, tick: time.tick, entry })
      } else {
        appendFault(fault.entity, entry)
      }
    }
  }

  function buildFaultEntry(source: string, fault: SystemFault): FaultEntry {
    const { kind, ...rest } = fault.error as { kind: string } & Record<string, unknown>
    const entry: FaultEntry = {
      kind,
      source,
      tick: time.tick,
      recoverable: fault.recoverable,
    }
    if (fault.component !== undefined) entry.component = fault.component
    if (Object.keys(rest).length > 0) {
      entry.detail = toJsonValue(rest)
    }
    return entry
  }

  function appendFault(entity: Entity, entry: FaultEntry): void {
    // Despawned mid-tick: silently drop. The system reported a fault for
    // an entity that no longer exists, which is a benign race during teardown.
    if (!alive.has(entity)) return
    const store = storeFor(Faulted)
    const existing = store.get(entity)
    if (existing) {
      // Mutate in place so any cached EntityView keeps observing the
      // same `faults` array reference (matches the ECS direct-access
      // contract used elsewhere — e.g. `e.Position.x += dx`).
      ;(existing.faults as FaultEntry[]).push(entry)
      recordChange(tickChanged, pendingChanged, Faulted.name, entity)
      wakeDriver()
    } else {
      world.addComponent(entity, Faulted, { faults: [entry] })
    }
  }

  function frame(t: number): void {
    if (!rafStarted) return
    rafHandle = null
    if (rafLastWallMs === null) {
      // First frame primes the reference — skip the step to avoid a
      // spurious dt = t (time-origin) on the very first tick.
      rafLastWallMs = t
      scheduleDriverFrame()
      return
    }
    const gap = t - rafLastWallMs
    rafLastWallMs = t
    const dtMs = rafWakeStep ? 1 : (gap > rafDtClampMs ? rafDtClampMs : gap)
    rafWakeStep = false
    world.step(dtMs / 1000)
    if (!rafStarted) return
    if (!shouldKeepDriverAwake()) return
    scheduleDriverFrame()
  }

  const world: World = {
    get rand() {
      return rand
    },
    get time() {
      return time
    },
    get signals() {
      return signals
    },
    get events() {
      return bus.view()
    },
    get input() {
      return input
    },
    setInput(snap: InputSnapshot): void {
      input = snap
      wakeDriver()
    },
    spawn(components?: ComponentBag): Entity {
      const id = nextId++
      alive.add(id)
      // new entity enters empty archetype
      emptyArch.entities.add(id)
      entityArchetype.set(id, emptyArch)
      for (const q of queries) {
        if (q.matchingArchetypes.has(emptyArch)) {
          q.structuralMembers.add(id)
          if (q.onAddFns.size > 0) {
            const view = makeView(id)
            for (const fn of q.onAddFns) fn(view)
          }
        }
      }
      if (components) {
        for (const [type, value] of iterateBag(components)) {
          world.addComponent(id, type, value)
        }
      }
      sigEntitySpawned.emit(id)
      wakeDriver()
      return id
    },

    despawn(entity: Entity): void {
      if (!alive.has(entity)) return
      const arch = entityArchetype.get(entity)
      if (arch) {
        // SPEC §2.10: componentRemoved fires before the bag is released.
        if (sigComponentRemoved.size > 0) {
          for (const name of arch.types) {
            const t = typeRegistry.get(name)
            if (t) sigComponentRemoved.emit({ entity, type: t })
          }
        }
        for (const name of arch.types) {
          recordChange(tickRemoved, pendingRemoved, name, entity)
          stores.get(name)?.delete(entity)
        }
        // fire onRemove hooks for queries this entity was in
        for (const q of queries) {
          if (q.matchingArchetypes.has(arch)) {
            q.structuralMembers.delete(entity)
            if (q.onRemoveFns.size > 0) {
              const view: EntityView = { id: entity }
              for (const fn of q.onRemoveFns) fn(view)
            }
          }
        }
        arch.entities.delete(entity)
      }
      entityArchetype.delete(entity)
      alive.delete(entity)
      viewCache.delete(entity)
      sigEntityDespawned.emit(entity)
      wakeDriver()
    },

    has(entity: Entity, type: ComponentType<unknown>): boolean {
      requireRegisteredType(type)
      return hasType(entity, type.name)
    },

    addComponent<T>(entity: Entity, type: ComponentType<T>, value: T): void {
      assertAlive(entity)
      const store = storeFor(type)
      if (store.has(entity)) {
        throw new Error(
          `domecs: entity ${entity} already has component "${type.name}"`,
        )
      }
      const merged = type.create(value as Partial<T>)
      store.set(entity, merged)
      recordChange(tickAdded, pendingAdded, type.name, entity)
      const nextTypes = currentTypes(entity)
      nextTypes.add(type.name)
      moveEntity(entity, nextTypes)
      sigComponentAdded.emit({ entity, type: type as ComponentType<unknown> })
      wakeDriver()
    },

    removeComponent(entity: Entity, type: ComponentType<unknown>): void {
      requireRegisteredType(type)
      const s = stores.get(type.name)
      if (!s || !s.has(entity)) return
      // SPEC §2.10: componentRemoved fires before the store drops the value.
      sigComponentRemoved.emit({ entity, type })
      s.delete(entity)
      recordChange(tickRemoved, pendingRemoved, type.name, entity)
      const nextTypes = currentTypes(entity)
      nextTypes.delete(type.name)
      moveEntity(entity, nextTypes)
      wakeDriver()
    },

    getComponent<T>(entity: Entity, type: ComponentType<T>): T | undefined {
      requireRegisteredType(type)
      const s = stores.get(type.name)
      if (!s) return undefined
      return s.get(entity) as T | undefined
    },

    markChanged<T>(entity: Entity, type: ComponentType<T>): void {
      // register type into registry even if caller only marks
      storeFor(type)
      recordChange(tickChanged, pendingChanged, type.name, entity)
      wakeDriver()
    },

    resource<T>(type: ResourceType<T>): T | undefined {
      const meta = requireRegisteredResource(type as ResourceType<unknown>)
      if (resources.has(type.name)) return resources.get(type.name) as T
      if (meta.__default) {
        const value = (meta.__default as () => T)()
        validateResource(meta, value, type.name)
        resources.set(type.name, value)
        return value
      }
      return undefined
    },

    setResource<T>(type: ResourceType<T>, value: T): void {
      const meta = requireRegisteredResource(type as ResourceType<unknown>)
      validateResource(meta, value, type.name)
      resources.set(type.name, value)
      recordResourceChange(type.name)
      wakeDriver()
    },

    markResourceChanged<T>(type: ResourceType<T>): void {
      requireRegisteredResource(type as ResourceType<unknown>)
      recordResourceChange(type.name)
      wakeDriver()
    },

    componentTypes(): ComponentType<unknown>[] {
      return Array.from(typeRegistry.values())
    },

    *entitiesWith<T>(type: ComponentType<T>): Iterable<{ id: Entity; value: T }> {
      requireRegisteredType(type)
      const store = stores.get(type.name) as Map<Entity, T> | undefined
      if (!store) return
      for (const [id, value] of store) yield { id, value }
    },

    archetype(entity: Entity): ComponentType<unknown>[] {
      const arch = entityArchetype.get(entity)
      if (!arch) return []
      const out: ComponentType<unknown>[] = []
      for (const name of arch.types) {
        const t = typeRegistry.get(name)
        if (t) out.push(t)
      }
      return out
    },

    describeComponent(type: ComponentType<unknown>): ComponentDescriptor {
      const meta = internal(type)
      const defaults =
        meta.__defaults !== undefined
          ? cloneSerializable(meta.__defaults as Record<string, unknown>)
          : undefined
      let fields: Record<string, FieldSchema>
      let fieldsSource: ComponentDescriptor['fieldsSource']
      if (meta.__schema) {
        fields = { ...meta.__schema.fields }
        fieldsSource = 'schema'
      } else if (defaults && Object.keys(defaults).length > 0) {
        fields = {}
        for (const [key, value] of Object.entries(defaults)) {
          fields[key] = { kind: inferFieldKind(value) }
        }
        fieldsSource = 'defaults'
      } else {
        fields = {}
        fieldsSource = 'none'
      }
      return { name: type.name, transient: meta.__transient, defaults, fields, fieldsSource }
    },

    query(def: QueryDef): QueryResult {
      const node = normalize(def)
      const hasTickFilter = treeHas(node, tickFilterKinds)
      const hasRemoved = treeHas(node, new Set<QueryNode['kind']>(['removed']))
      const q: CompiledQuery = {
        id: nextQueryId++,
        node,
        hasTickFilter,
        hasRemoved,
        matchingArchetypes: new Set(),
        structuralMembers: new Set(),
        onAddFns: new Set(),
        onRemoveFns: new Set(),
      }
      queries.push(q)
      // seed against all existing archetypes
      for (const arch of archetypes.values()) {
        evaluateQueryAgainstArchetype(q, arch)
        if (q.matchingArchetypes.has(arch)) {
          for (const e of arch.entities) q.structuralMembers.add(e)
        }
      }

      const needsEntityFilter = hasTickFilter
      const collectCandidates = (): Iterable<Entity> => {
        if (!hasRemoved) return q.structuralMembers
        // Removed: include entities that were removed this tick, which may
        // no longer sit in any structurally matching archetype.
        const set = new Set<Entity>(q.structuralMembers)
        for (const name of collectRemovedTypeNames(node)) {
          const s = tickRemoved.get(name)
          if (s) for (const e of s) set.add(e)
        }
        return set
      }

      let disposed = false
      const result: QueryResult = {
        get entities() {
          if (disposed) return []
          const candidates = collectCandidates()
          const out: EntityView[] = []
          for (const e of candidates) {
            if (needsEntityFilter && !evalEntity(node, e)) continue
            out.push(makeView(e))
          }
          return out
        },
        get size() {
          if (disposed) return 0
          if (!needsEntityFilter && !hasRemoved) return q.structuralMembers.size
          let count = 0
          for (const e of collectCandidates()) {
            if (needsEntityFilter && !evalEntity(node, e)) continue
            count++
          }
          return count
        },
        onAdd(fn) {
          if (disposed) return () => {}
          q.onAddFns.add(fn)
          return () => q.onAddFns.delete(fn)
        },
        onRemove(fn) {
          if (disposed) return () => {}
          q.onRemoveFns.add(fn)
          return () => q.onRemoveFns.delete(fn)
        },
        dispose() {
          if (disposed) return
          disposed = true
          const idx = queries.indexOf(q)
          if (idx >= 0) queries.splice(idx, 1)
          q.matchingArchetypes.clear()
          q.structuralMembers.clear()
          q.onAddFns.clear()
          q.onRemoveFns.clear()
        },
      }
      return result
    },

    count(def: QueryDef): number {
      const { node, needsEntityFilter } = oneshotNode(def)
      let n = 0
      for (const arch of archetypes.values()) {
        if (!evalStructural(node, arch.types)) continue
        if (!needsEntityFilter) {
          n += arch.entities.size
          continue
        }
        for (const e of arch.entities) if (evalEntity(node, e)) n++
      }
      return n
    },

    entitiesMatching(def: QueryDef): Entity[] {
      const { node, needsEntityFilter } = oneshotNode(def)
      const out: Entity[] = []
      for (const arch of archetypes.values()) {
        if (!evalStructural(node, arch.types)) continue
        for (const e of arch.entities) {
          if (needsEntityFilter && !evalEntity(node, e)) continue
          out.push(e)
        }
      }
      return out
    },

    select(def: QueryDef): EntityView[] {
      const { node, needsEntityFilter } = oneshotNode(def)
      const out: EntityView[] = []
      for (const arch of archetypes.values()) {
        if (!evalStructural(node, arch.types)) continue
        for (const e of arch.entities) {
          if (needsEntityFilter && !evalEntity(node, e)) continue
          out.push(makeView(e))
        }
      }
      return out
    },

    observe(def: QueryDef, hooks: QueryHooks): () => void {
      const q = world.query(def)
      const unsubscribers: Array<() => void> = []
      if (hooks.onAdd) unsubscribers.push(q.onAdd(hooks.onAdd))
      if (hooks.onRemove) unsubscribers.push(q.onRemove(hooks.onRemove))
      let changeHandle: SystemHandle | null = null
      if (hooks.onChange) {
        const node = normalize(def)
        changeHandle = world.system(
          `__observe_${nextObserverId++}`,
          { schedule: 'reactive', reactsTo: node },
          () => {
            for (const entity of q.entities) hooks.onChange!(entity)
          },
        )
      }
      return () => {
        for (const unsubscribe of unsubscribers) unsubscribe()
        changeHandle?.remove()
        q.dispose()
      }
    },

    emit<T>(type: EventType<T>, payload: T): void {
      bus.emit(type, payload)
      wakeDriver()
    },

    on<T>(type: EventType<T>, fn: (e: T) => void): () => void {
      return bus.on(type, fn)
    },

    setScale(scale: number): void {
      // D-3: setScale(0) is the same observable state as pause(); setScale(x>0)
      // both updates `preResumeScale` and (if currently paused) resumes. The
      // old behaviour silently corrupted resume targets when callers passed 0
      // outside of pause/resume.
      if (!Number.isFinite(scale) || scale < 0) {
        throw new Error(
          `domecs: setScale requires a non-negative finite number; got ${scale}`,
        )
      }
      if (scale === 0) {
        if (time.scale !== 0) preResumeScale = time.scale
        time.scale = 0
        return
      }
      preResumeScale = scale
      time.scale = scale
      wakeDriver()
    },

    pause(): void {
      if (time.scale !== 0) preResumeScale = time.scale
      time.scale = 0
    },

    resume(): void {
      if (time.scale === 0) time.scale = preResumeScale
      wakeDriver()
    },

    requestTick(): void {
      wakeDriver()
    },

    system(name: string, def: SystemDef, fn: System): SystemHandle {
      const handle = scheduler.register(name, def, fn)
      wakeDriver()
      return handle
    },

    step(dt?: number): void {
      // F-6: an *explicit* dt<=0 is a "heartbeat" — no time advancement,
      // no system execution, no change-detection buffer swap. Plugin hooks,
      // signals, and onRender still fire so UIs can paint initial state
      // and input plugins can republish snapshots between turns. A no-arg
      // step() keeps its legacy meaning ("advance a tick with d=0"), which
      // turn-based exemplars and turn() rely on.
      if (dt !== undefined && dt <= 0) {
        time.delta = 0
        time.scaledDelta = 0
        inTick = true
        try {
          plugins.callTickStart(world)
          if (sigTickStart.size > 0) sigTickStart.emit(time)
          plugins.callRender(world)
          plugins.callTickEnd(world)
          if (sigTickEnd.size > 0) sigTickEnd.emit(time)
        } finally {
          inTick = false
        }
        return
      }
      const d = dt ?? 0

      scheduler.applyPendingReplacements()

      // SPEC §4 step 0 — reset per-tick change-detection, then promote
      // any between-tick (pending) marks into the live sets (F-2).
      tickAdded.clear()
      tickRemoved.clear()
      tickChanged.clear()
      drainInto(pendingAdded, tickAdded)
      drainInto(pendingRemoved, tickRemoved)
      drainInto(pendingChanged, tickChanged)
      // #16: same buffer-and-swap for resource-change marks.
      tickResourcesChanged.clear()
      for (const name of pendingResourcesChanged) tickResourcesChanged.add(name)
      pendingResourcesChanged.clear()

      const scaledDt = d * time.scale
      // F-3: accumulate unquantized scaled time, then derive ms-quantized
      // user-visible scaledDelta/elapsed from the cumulative total. Per-frame
      // values stay ms-aligned (SPEC §2.7) but aggregate rates do not drift.
      totalScaledSeconds += scaledDt
      const newQuantizedMs = Math.round(totalScaledSeconds * 1000)
      // F-6: when the caller passed a positive dt, floor per-tick
      // quantized dt at 1 ms so sub-ms wall-clock frames never expose
      // scaledDelta = 0 to consumers that divide by it (PIDs, smoothing
      // filters, rate estimators). No-arg step() keeps its d=0 behaviour.
      // Guard on `d`, not `rawDtMs`: `rawDtMs` can be 0 from quantization
      // carry even with positive caller dt, and that is exactly the case
      // we need to raise to 1 ms.
      const rawDtMs = newQuantizedMs - lastQuantizedElapsedMs
      const dtMs = time.scale !== 0 && d > 0 && rawDtMs < 1 ? 1 : rawDtMs
      lastQuantizedElapsedMs = newQuantizedMs
      time.delta = d
      time.scaledDelta = dtMs / 1000
      time.elapsed = newQuantizedMs / 1000
      time.tick += 1

      inTick = true
      try {
        // SPEC §9.4 — plugin onTickStart fires at step 0.
        plugins.callTickStart(world)

        // SPEC §4 step 1 — flush event buffer from last tick into readable view.
        const eventView = bus.flush()
        if (sigTickStart.size > 0) sigTickStart.emit(time)

        // SPEC §4 step 2 — input collection (stub in headless).

        // SPEC §4 step 3 — fixed systems against shared accumulator (SPEC §3).
        // F-3: drive from cumulative unquantized seconds; ms-rounding drift
        // in per-tick scaledDelta does not entangle the scheduler.
        if (time.scale !== 0) {
          const expected = Math.floor(totalScaledSeconds / time.fixedStep + 1e-9)
          while (fixedStepsFired < expected) {
            fixedStepsFired += 1
            fixedStepCounter += 1
            for (const s of scheduler.systemsByMode('fixed')) {
              if (!isEnabled(s)) continue
              if (fixedStepCounter % s.fixedDivisor !== 0) continue
              runSystem(s, eventView)
            }
          }
          time.fixedAccumulator =
            totalScaledSeconds - fixedStepsFired * time.fixedStep
        }

        // SPEC §3 — `once` systems fire on first tick of world.
        for (const s of scheduler.systemsByMode('once')) {
          if (s.ranOnce || !isEnabled(s)) continue
          runSystem(s, eventView)
          s.ranOnce = true
        }

        // SPEC §4 step 4 — tick systems.
        if (time.scale !== 0) {
          for (const s of scheduler.systemsByMode('tick')) {
            if (!isEnabled(s)) continue
            runSystem(s, eventView)
          }
        }

        // SPEC §4 step 5 — event systems for events in this tick's view.
        for (const s of scheduler.systemsByMode('event')) {
          if (!isEnabled(s)) continue
          if (!eventMatches(s, eventView)) continue
          runSystem(s, eventView)
        }

        // SPEC §4 step 6 — reactive systems; one coalesced call if reactsTo has entities.
        for (const s of scheduler.systemsByMode('reactive')) {
          if (!isEnabled(s) || !s.reactsTo) continue
          if (s.reactsTo.size > 0) {
            runSystem(s, eventView)
            continue
          }
          // #16: a reactsTo with no structural entity dependency (no Has leaf)
          // still fires when one of its ChangedResource targets changed this
          // tick — supports world-level resource reactions in entity-empty
          // worlds where the structural member count is zero. Entity-scoped
          // reactsTo (any Has leaf) is governed by `size` above only.
          if (reactiveResourceFallback(s)) runSystem(s, eventView)
        }

        // SPEC §4 step 7 — renderer diff/commit handled by dom plugin (not core).
        plugins.callRender(world)

        // SPEC §9.4 — plugin onTickEnd fires at step 8.
        plugins.callTickEnd(world)
        if (sigTickEnd.size > 0) sigTickEnd.emit(time)
      } finally {
        inTick = false
      }
    },

    stepN(n: number, dt?: number): void {
      for (let i = 0; i < n; i++) world.step(dt)
    },

    turn<T>(type: EventType<T>, payload: T, dt?: number): void {
      // SPEC §3 turn-based mode: emit action, advance one tick.
      // Because events flush at next step's step 1, we emit first then step.
      bus.emit(type, payload)
      world.step(dt)
    },

    start(options?: StartOptions): () => void {
      // F-5: thin rAF driver. Every browser exemplar was hand-rolling this
      // with bespoke dt-clamp / first-frame priming / visibility-pause
      // logic. Owning it here gives one place to fix that mis-tune.
      if (headless) {
        throw new Error(
          'domecs: World.start() is disabled for worlds created with headless=true; use step(dt) instead',
        )
      }
      const g = globalThis as unknown as {
        requestAnimationFrame?: (cb: (t: number) => void) => number
        cancelAnimationFrame?: (h: number) => void
        document?: { hidden?: boolean; addEventListener: Function; removeEventListener: Function }
      }
      if (typeof g.requestAnimationFrame !== 'function' || typeof g.cancelAnimationFrame !== 'function') {
        throw new Error(
          'domecs: World.start() requires requestAnimationFrame; use step(dt) in headless environments',
        )
      }
      if (rafStarted) {
        wakeDriver()
        return () => world.stop()
      }
      rafStarted = true
      rafDtClampMs = options?.dtClampMs ?? 100
      // Default true; explicit `false` disables. Anything else (undefined,
      // nullish, truthy) enables — the switch is strict boolean-false.
      const pauseOnHidden = options?.pauseOnHidden !== false
      rafLastWallMs = null
      rafWakeStep = false
      scheduleDriverFrame()
      if (pauseOnHidden && g.document && typeof g.document.addEventListener === 'function') {
        const doc = g.document
        rafVisHandler = (): void => {
          // Defensive: browsers may deliver a queued visibilitychange event
          // after stop()+removeEventListener fires on the same microtask.
          // Ignore it; the next start() installs a fresh handler.
          if (!rafStarted) return
          if (doc.hidden) {
            world.pause()
          } else {
            world.resume()
            // Discard the accumulated wall-clock gap so the first post-
            // resume frame primes cleanly instead of delivering a spike.
            rafLastWallMs = null
            scheduleDriverFrame()
          }
        }
        doc.addEventListener('visibilitychange', rafVisHandler)
      }
      return () => world.stop()
    },

    stop(): void {
      if (!rafStarted) return
      const g = globalThis as unknown as {
        cancelAnimationFrame?: (h: number) => void
        document?: { removeEventListener: Function }
      }
      if (rafHandle !== null) g.cancelAnimationFrame?.(rafHandle)
      rafStarted = false
      rafHandle = null
      rafLastWallMs = null
      rafWakeStep = false
      if (rafVisHandler && g.document && typeof g.document.removeEventListener === 'function') {
        g.document.removeEventListener('visibilitychange', rafVisHandler)
        rafVisHandler = null
      }
    },

    use<O>(plugin: Plugin<O>, options?: O): Result<() => void, DomecsError> {
      const result = plugins.use(plugin, options)
      if (result.ok) wakeDriver()
      return result
    },

    capability<K extends string>(name: K): Capability<K> {
      return plugins.capability(name)
    },

    snapshot(options?: SnapshotOptions): WorldSnapshot {
      const pruneEmpty = options?.pruneEmptyEntities === true
      const entities: Array<{ id: Entity; components: Record<string, unknown> }> = []
      const sortedAlive = Array.from(alive).sort((a, b) => a - b)
      for (const id of sortedAlive) {
        const arch = entityArchetype.get(id)
        if (!arch) continue
        const components: Record<string, unknown> = {}
        for (const name of arch.types) {
          const type = typeRegistry.get(name)
          if (type && internal(type).__transient) continue
          const store = stores.get(name)
          if (!store) continue
          const v = store.get(id)
          if (v !== undefined) components[name] = cloneSerializable(v)
        }
        if (pruneEmpty && Object.keys(components).length === 0) continue
        entities.push({ id, components })
      }
      // #16: serialize materialized resources by name (deep-cloned like
      // component values). Omit the field entirely when there are none so a
      // resource-free world's snapshot is byte-identical to the pre-v2 shape
      // (modulo `version`).
      let resourcesSnap: Record<string, unknown> | undefined
      if (resources.size > 0) {
        resourcesSnap = {}
        for (const [name, value] of resources) {
          resourcesSnap[name] = cloneSerializable(value)
        }
      }
      let snap: WorldSnapshot = {
        version: SNAPSHOT_VERSION,
        seed: rand.seed(),
        tick: time.tick,
        entities,
        ...(resourcesSnap !== undefined ? { resources: resourcesSnap } : {}),
      }
      for (const entry of plugins.list()) {
        if (entry.handle?.onSnapshot) {
          snap = entry.handle.onSnapshot(snap) as WorldSnapshot
        }
      }
      return snap
    },

    restore(snap: WorldSnapshot): void {
      let s = snap
      for (const entry of plugins.list()) {
        if (entry.handle?.onRestore) s = entry.handle.onRestore(s) as WorldSnapshot
      }

      // Wipe world state (preserve plugins, system registrations, signals).
      // Capture each live query's current members AS POPULATED VIEWS before the
      // wipe: `buildView` reads stores eagerly, so views materialized here keep
      // their component values after the stores are cleared. Index positionally
      // — `q.id` is a world-global monotonic counter, NOT an index into the live
      // `queries` array (disposed queries are spliced out), so `prevMembers[q.id]`
      // looked up the wrong/undefined set after any dispose and onRemove misfired.
      const prevViews = queries.map((q) =>
        q.onRemoveFns.size > 0 ? Array.from(q.structuralMembers, (id) => makeView(id)) : null,
      )
      alive.clear()
      stores.clear()
      archetypes.clear()
      entityArchetype.clear()
      tickAdded.clear()
      tickRemoved.clear()
      tickChanged.clear()
      pendingAdded.clear()
      pendingRemoved.clear()
      pendingChanged.clear()
      // #16: resource values are part of the snapshot; clear then rehydrate.
      // `resourceRegistry` (type identity) persists like `typeRegistry`.
      resources.clear()
      tickResourcesChanged.clear()
      pendingResourcesChanged.clear()
      viewCache.clear()
      queries.forEach((q, i) => {
        const views = prevViews[i]
        if (views) for (const view of views) for (const fn of q.onRemoveFns) fn(view)
        q.matchingArchetypes.clear()
        q.structuralMembers.clear()
      })
      emptyArch = ensureArchetype(new Set<string>())

      // PRNG state + tick.
      rand = restoreRng(s.seed)
      time.tick = s.tick
      time.elapsed = 0
      time.delta = 0
      time.scaledDelta = 0
      time.fixedAccumulator = 0
      fixedStepCounter = 0
      totalScaledSeconds = 0
      fixedStepsFired = 0
      lastQuantizedElapsedMs = 0

      // Rehydrate entities + components (name-keyed; ComponentType objects
      // attach lazily when callers mutate via addComponent/markChanged).
      let maxId = -1
      for (const rec of s.entities) {
        alive.add(rec.id)
        if (rec.id > maxId) maxId = rec.id
        const types = new Set<string>()
        for (const [name, value] of Object.entries(rec.components)) {
          let store = stores.get(name)
          if (!store) {
            store = new Map()
            stores.set(name, store)
          }
          store.set(rec.id, cloneSerializable(value))
          types.add(name)
        }
        const arch = ensureArchetype(types)
        arch.entities.add(rec.id)
        entityArchetype.set(rec.id, arch)
        for (const q of queries) {
          if (q.matchingArchetypes.has(arch)) {
            q.structuralMembers.add(rec.id)
            if (q.onAddFns.size > 0) {
              const view = makeView(rec.id)
              for (const fn of q.onAddFns) fn(view)
            }
          }
        }
      }
      nextId = maxId + 1

      // #16: rehydrate resources by name (v1 snapshots have no `resources`,
      // leaving the world's resource set empty — defaults re-materialize lazily).
      if (s.resources) {
        for (const [name, value] of Object.entries(s.resources)) {
          resources.set(name, cloneSerializable(value))
        }
      }
    },
  }

  // D-4: `__wake` is the deprecated alias for `world.requestTick()`. Kept
  // for one release cycle so any external plugins still on the private side
  // channel continue to compile. Remove after v0.2.
  ;(world as World & { __wake?: () => void }).__wake = wakeDriver
  scheduler = createScheduler(world.query.bind(world), fixedStep)
  plugins = createPluginRegistry(world)

  // Register the built-in end-of-tick fault consolidator (BETTER_ERRORS
  // Phase 1). Collapses redundant entries by (source, kind, component)
  // keeping the most recent. Userland may disable for forensic builds.
  world.system(
    CONSOLIDATE_FAULTS_NAME,
    {
      schedule: 'tick',
      priority: CONSOLIDATE_FAULTS_PRIORITY,
      query: Has(Faulted),
    },
    (ctx) => {
      for (const view of ctx.entities) {
        const stored = world.getComponent(view.id, Faulted)
        if (!stored) continue
        const faults = stored.faults
        if (faults.length < 2) continue
        const seen = new Map<string, FaultEntry>()
        for (const f of faults) {
          seen.set(`${f.source}|${f.kind}|${f.component ?? ''}`, f)
        }
        if (seen.size === faults.length) continue
        const collapsed = Array.from(seen.values())
        const mut = faults as FaultEntry[]
        mut.length = 0
        for (const f of collapsed) mut.push(f)
        world.markChanged(view.id, Faulted)
      }
    },
  )

  return world
}

function collectRemovedTypeNames(node: QueryNode, out: Set<string> = new Set()): Set<string> {
  if (node.kind === 'removed') out.add(node.type.name)
  if (node.kind === 'or' || node.kind === 'and') {
    for (const c of node.children) collectRemovedTypeNames(c, out)
  }
  if (node.kind === 'not') collectRemovedTypeNames(node.child, out)
  return out
}
