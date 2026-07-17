import { internal } from './component.js'
import { createRafDriver } from './driver.js'
import { createResourceState } from './world-resources.js'
import {
  applySnapshot,
  buildSnapshot,
  type ArchetypeBucket,
  type CompiledQuery,
  type StepClock,
  type WorldStateCtx,
} from './world-state.js'
import type {
  DomecsError,
  FaultEntry,
  SystemFault,
  SystemResult,
  SystemicFault,
} from './errors.js'
import {
  createEventBus,
  internalEvent,
  type EmittedEvent,
  type EventBus,
  type EventDescriptor,
  type EventType,
  type EventView,
} from './events.js'
import {
  CONSOLIDATE_FAULTS_NAME,
  CONSOLIDATE_FAULTS_PRIORITY,
  Faulted,
} from './faulted.js'
import { emptyInput, type InputSnapshot } from './input.js'
import { createPluginRegistry, type Capability, type Plugin } from './plugin.js'
import { normalizeCause, toJsonValue, type Result } from './result.js'
import { createRng, type Rng, type RngState } from './rng.js'
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
  type SystemSchedule,
} from './scheduler.js'
import type { WorldManifest, PluginManifestEntry } from './manifest.js'
import { createSignal, type EmittableSignal, type Signal } from './signals.js'
import { createTime, type TimeState } from './time.js'
import type {
  ComponentBag,
  ComponentDescriptor,
  ComponentType,
  Entity,
  FieldKind,
  FieldSchema,
  ResourceDescriptor,
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
  type OneShotQueryDef,
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

// The manifest is a plain-data handoff: clone FieldSchema values so no
// consumer holds references into the live component/event schema metadata
// (mutating a manifest must never corrupt reflection world-wide).
function cloneFields(src: Record<string, FieldSchema>): Record<string, FieldSchema> {
  const out: Record<string, FieldSchema> = {}
  for (const [key, value] of Object.entries(src)) out[key] = { ...value }
  return out
}

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
   * Public idle-driver wake. External event sources — input plugins,
   * WebSocket feeds, custom drivers — call `world.requestTick()` after they
   * mutate world state from outside a tick so the idle RAF loop schedules a
   * frame. No-op when the driver is not running, when `idle: false`, or when
   * already inside a tick.
   */
  requestTick(): void
  /**
   * Spawn an entity, optionally with an initial component bag.
   *
   * **Shallow-copy semantics (O-34):** each value is shallow-merged via
   * `ComponentType.create()`. Top-level scalars on the caller's object stop
   * tracking the live store; nested object/array refs stay shared. Prefer
   * capturing the entity id and reading via {@link World.getComponent}.
   */
  spawn(components?: ComponentBag): Entity
  despawn(entity: Entity): void
  has(entity: Entity, type: ComponentType<unknown>): boolean
  addComponent<T>(entity: Entity, type: ComponentType<T>, value: T): void
  removeComponent(entity: Entity, type: ComponentType<unknown>): void
  getComponent<T>(entity: Entity, type: ComponentType<T>): T | undefined
  markChanged<T>(entity: Entity, type: ComponentType<T>): void
  /**
   * Read a world-singleton resource. Returns the current value,
   * lazily materializing the declared default on first read, or `undefined`
   * when no default was declared and nothing has been set. The returned object
   * is the live singleton — mutating it mutates the resource.
   */
  getResource<T>(type: ResourceType<T>): T | undefined
  /** Replace a resource's value, validate it, and mark it changed this tick. */
  setResource<T>(type: ResourceType<T>, value: T): void
  /**
   * Flag a resource as changed without replacing its value — for in-place
   * edits (`world.getResource(Cfg)!.v = 2`). Fires `OnChangedResource(type)` gates
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
   * Retrieve the live {@link SystemHandle} for a registered system by `name`
   * (built-in or user-registered), or `undefined` if none is registered under
   * that name. The returned handle is the SAME one `system()` produced, so
   * flipping its `enabled` / calling `disable()` really affects scheduling on
   * the next step. This is the public escape hatch for disabling built-ins such
   * as the fault consolidator (`CONSOLIDATE_FAULTS_NAME`), whose handle is
   * otherwise unreachable.
   */
  getSystem(name: string): SystemHandle | undefined
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
  /** Every resource type registered or touched in this world. */
  resourceTypes(): ResourceType<unknown>[]
  /**
   * Iterate every live entity that currently holds component `type`, paired
   * with its value. Convenience over `world.query(Has(type))` + per-entity
   * `getComponent`; equivalent in semantics, cheaper at the call-site. F-10.
   */
  iterEntitiesWith<T>(type: ComponentType<T>): Iterable<{ id: Entity; value: T }>
  archetype(entity: Entity): ComponentType<unknown>[]
  /**
   * Reflect a component's name, transient flag, default value, and field
   * schema. `fields` resolves to the explicit `schema.fields`
   * when one was declared, otherwise it is inferred from `defaults` by runtime
   * `typeof`. Lets dev tools build edit widgets from the world alone — no
   * per-app schema registry. Works on any `ComponentType` without prior
   * registration; enumerate with `componentTypes()`.
   */
  describeComponent(type: ComponentType<unknown>): ComponentDescriptor
  /**
   * Reflect an event's name and optional payload schema. `name` is an opaque
   * diagnostic label; event identity is the internal symbol.
   */
  describeEvent(type: EventType<unknown>): EventDescriptor
  /**
   * Reflect a resource's name, whether a default was declared, and whether it
   * has been materialized in this world. Registers the type on first call,
   * the same as any resource access.
   */
  describeResource<T>(type: ResourceType<T>): ResourceDescriptor
  /**
   * One machine-readable manifest of the whole live world: the schema surface
   * (components/resources/events/systems/plugins/capabilities/snapshotVersion)
   * plus live debug counts (entityCount/componentCounts/archetypes). All
   * counts are O(1)/O(archetype) reads — cheap enough to poll.
   */
  describe(): WorldManifest
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
   * `Where` — but reject reactive `On*` nodes (`OnAdded`/`OnChanged`/
   * `OnRemoved`/`OnChangedResource`) at *compile time* via the `OneShotQueryDef`
   * negative brand, since those need per-tick delta tracking only a live query
   * or reactive system provides. (Untyped JS callers are still rejected at
   * runtime by the `oneshotNode()` guard.)
   */
  countEntities(def: OneShotQueryDef): number
  listEntities(def: OneShotQueryDef): Entity[]
  selectViews<T extends ReadonlyArray<ComponentType<unknown, string>>>(
    def: readonly [...T],
  ): EntityView<FieldsFromComponents<T>>[]
  selectViews(def: OneShotQueryDef): EntityView[]
  /**
   * Observe a query reactively and receive structural + optional per-tick
   * change callbacks. Returns an unsubscribe function.
   *
   * - `onAdd` / `onRemove` fire when membership changes.
   * - `onChange` requires `def` to include at least one change-detection node
   *   such as `OnAdded(...)`, `OnRemoved(...)`, or `OnChanged(...)`; plain `Has(...)`
   *   queries do not support reactive change ticks.
   * - When valid, `onChange` fires for current members on ticks where the
   *   change-detection portion of the query is non-empty.
   */
  observe(def: QueryDef, hooks: QueryHooks): () => void
  /**
   * Advance the world by `dt` seconds (real-time tick).
   * - `dt > 0` → normal real-time tick; time advances by `dt`.
   * - `dt <= 0` → **heartbeat**: plugin hooks + render fire, but system
   *   execution and change-detection buffer swap are skipped. Use for
   *   lightweight UI repaints between turns (SPEC F-6).
   *
   * For the turn-based no-arg single advance, use {@link stepOnce}.
   */
  step(dt: number): void
  /**
   * Advance exactly one tick with `delta = 0` — the turn-based single step.
   * Systems run normally; time does not advance. This is the former no-arg
   * `step()` behaviour.
   *
   * **Fixed schedule (O-37):** `fixed` systems only run when the scaled-time
   * accumulator crosses a step boundary. `stepOnce()` uses dt=0, so the
   * accumulator never advances and `fixed` systems never fire. For headless
   * tests of fixed-schedule sims, use `step(world.time.fixedStep)` (or
   * `stepN(n, dt)` with a positive `dt`).
   */
  stepOnce(): void
  stepN(n: number, dt?: number): void
  turn<T>(type: EventType<T>, payload: T, dt?: number): void
  /**
   * Turn-based command with a structured result. Emits `type`, advances
   * one tick (like `turn()`), then reports `{ accepted, consumedTurn, reason,
   * events, snapshot? }`. `events` are the events emitted *during* the tick
   * (the command's downstream effects — the action event itself was flushed
   * and consumed at step 1). `accepted`/`consumedTurn`/`reason` come from
   * `opts.resolve` (default `{ accepted: true, consumedTurn: true }`).
   * `turn()` remains the void fire-and-forget form.
   */
  action<T>(type: EventType<T>, payload: T, opts?: ActionOptions): ActionResult
  startLoop(options?: StartOptions): () => void
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
   * Also validates each fault entry's shape
   * (`{ error: { kind: string, ... }, recoverable: boolean }`) — malformed
   * entries are warned about (one-shot per system) and skipped instead of
   * producing a vague entry with an undefined kind.
   * Off by default — production code should not pay the shape-check cost.
   * See doc/error-handling.md.
   */
  strictReturns?: boolean
}

/**
 * Options for {@link World.startLoop}. The rAF driver is intentionally thin:
 * compute wall-clock dt, clamp it, pipe it to `step(dt)`. Consumers that
 * need custom scheduling keep using `step(dt)` directly.
 */
export interface StartOptions {
  /** Per-frame dt ceiling in ms (default 100). Prevents tab-return spikes
   *  from exploding into hundreds of fixed-step ticks. */
  dtClampMs?: number
  /**
   * When `document.hidden` flips true, pause via {@link World.pause} if the
   * world was running; on re-show, resume **only** a pause this driver
   * initiated. App-managed pauses (`world.pause()` / Pause button) are not
   * trampled. Default true; has no effect outside a DOM. Pass `false` to
   * opt out entirely.
   *
   * Known limit: ownership is tracked as a flag, not an epoch. If the tab
   * hides while running (driver claims the pause) and app logic then calls
   * `resume()` followed by its own `pause()` while still hidden, the stale
   * ownership bit makes re-show resume over that app pause. Apps driving
   * pause state from background logic (timers, sockets) should pass
   * `pauseOnHidden: false` and manage visibility themselves.
   */
  pauseOnHidden?: boolean
}

/** An event emitted during an {@link World.action} tick. */
export type ActionEvent = EmittedEvent

/**
 * The game's verdict on an action, produced by an {@link ActionResolver}.
 * `consumedTurn` defaults to `accepted` when omitted (an accepted command
 * spends the turn; a rejected one does not). `reason` is for diagnostics /
 * UI on rejection.
 */
export interface ActionVerdict {
  accepted: boolean
  consumedTurn?: boolean
  reason?: string
}

/**
 * Derives the verdict from the events the action produced this tick and the
 * resulting world. Policy lives here, in game code — the engine stays
 * agnostic about what "accepted" means. Omit it to default to
 * `{ accepted: true, consumedTurn: true }`.
 */
export type ActionResolver = (ctx: {
  events: readonly ActionEvent[]
  world: World
}) => ActionVerdict

export interface ActionOptions {
  /** dt forwarded to the underlying `step`. Omit for a turn-based tick
   *  advance (like `turn()`); a non-positive explicit dt is a heartbeat and
   *  will not process the action (see §4.0) — the result is then
   *  `{ accepted: false, consumedTurn: false, events: [] }` with a reason,
   *  the resolver is not invoked, and the action stays buffered for the
   *  next real tick. */
  dt?: number
  /** Compute accepted/consumedTurn/reason from the tick's events + world. */
  resolve?: ActionResolver
  /** Attach `world.snapshot()` to the result. `true` uses defaults; pass a
   *  `SnapshotOptions` object to forward options (e.g. `pruneEmptyEntities`). */
  snapshot?: boolean | SnapshotOptions
}

/**
 * Structured result of {@link World.action}: did the command land, did it
 * spend the turn, why not, what events it produced, and an optional snapshot.
 */
export interface ActionResult {
  accepted: boolean
  consumedTurn: boolean
  reason?: string
  events: readonly ActionEvent[]
  snapshot?: WorldSnapshot
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

  // The event bus is decoupled from fault plumbing; it reports a throwing
  // direct on() subscriber back through this sink. Core owns the DomecsError
  // construction and the signal. There is no originating system, so the
  // SystemicFault `source` is the offending event's name (it identifies what
  // was being delivered when the handler threw).
  const bus: EventBus = createEventBus((eventName, cause) => {
    const error: DomecsError = {
      kind: 'event_handler_threw',
      event: eventName,
      cause: normalizeCause(cause),
      retryable: true,
    }
    const entry = buildFaultEntry(eventName, {
      error,
      recoverable: true,
    })
    sigFaultRaised.emit({ source: eventName, tick: time.tick, entry })
  })

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
  // F-3: drift-free fixed-step driver. Grouped so the extracted
  // restore mechanics (world-state.ts) can reset it in place.
  const clock: StepClock = {
    fixedStepCounter: 0,
    totalScaledSeconds: 0,
    fixedStepsFired: 0,
    lastQuantizedElapsedMs: 0,
  }
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

  // World-singleton resources (#16) — registry, materialized values and the
  // tick/pending change-set pair live in the extracted resource-state module.
  const resourceState = createResourceState(() => inTick)

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

  // O-23: snapshot/restore mechanics live in world-state.ts; this context
  // threads the factory's closure state through to them. The reassignable
  // closure vars (rand, nextId, emptyArch) are exposed as accessors.
  const stateCtx: WorldStateCtx = {
    alive,
    stores,
    typeRegistry,
    archetypes,
    entityArchetype,
    tickAdded,
    tickRemoved,
    tickChanged,
    pendingAdded,
    pendingRemoved,
    pendingChanged,
    viewCache,
    queries,
    time,
    clock,
    resources: resourceState,
    makeView: (entity) => makeView(entity),
    ensureArchetype: (types) => ensureArchetype(types),
    getRand: () => rand,
    setRand: (r) => {
      rand = r
    },
    setNextId: (id) => {
      nextId = id
    },
    setEmptyArch: (arch) => {
      emptyArch = arch
    },
  }

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
      // And(Has(X), OnChangedResource(R)) yields the X entities only on change
      // ticks. See ChangedResource (#16).
      case 'changedResource': return resourceState.changedThisTick(node.resource.name)
    }
  }

  function hasType(entity: Entity, name: string): boolean {
    const s = stores.get(name)
    return s ? s.has(entity) : false
  }

  // Normalize + validate a def for the one-shot selectors (countEntities/
  // listEntities/selectViews). Reactive nodes track per-tick deltas that only a
  // registered query maintains, so they are a misuse here; reject loudly.
  function oneshotNode(def: QueryDef): { node: QueryNode; needsEntityFilter: boolean } {
    const node = normalize(def)
    if (treeHas(node, oneshotReactiveKinds)) {
      throw new Error(
        'domecs: countEntities/listEntities/selectViews are one-shot selectors and ' +
          'cannot evaluate reactive nodes (OnAdded/OnChanged/OnRemoved) — those need ' +
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
    const triggers = s.def.schedule === 'event' ? s.def.triggers : undefined
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
    if (s.def.schedule !== 'reactive' || !s.def.reactsTo) return false
    const node = normalize(s.def.reactsTo)
    if (!treeHas(node, changedResourceKind)) return false
    if (collectHasComponents(node).size > 0) return false
    for (const name of collectChangedResourceNames(node)) {
      if (resourceState.changedThisTick(name)) return true
    }
    return false
  }

  function hasFrameSystems(): boolean {
    for (const s of scheduler.systemsByMode('once')) {
      if (!s.ranOnce && isEnabled(s)) return true
    }
    // Tick systems are gated off at scale 0 in step() (SPEC §4 step 4), so —
    // like fixed systems below — they must not keep the idle driver spinning
    // while paused. Renderers still get frames while paused via the mutation
    // wake path (hasPendingComponentWork / bus pending in
    // shouldKeepDriverAwake).
    if (time.scale !== 0) {
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

  // F-5: rAF bookkeeping lives in the driver module; the world supplies
  // behaviour (step, pause/resume, idle policy) through hooks. The hooks
  // close over `world`/`runTick` lazily — they only run once frames fire.
  const driver = createRafDriver(
    { idle, headless },
    {
      step: (dt) => runTick(dt),
      pause: () => world.pause(),
      resume: () => world.resume(),
      isPaused: () => time.scale === 0,
      shouldKeepAwake: () => shouldKeepDriverAwake(),
      isInTick: () => inTick,
    },
  )

  function wakeDriver(): void {
    driver.wake()
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

  // strictReturns-only per-fault shape check: the permissive default trusts
  // typed callers, but a typo'd entry (e.g. `{ knid }`, `recoverable: 'yes'`)
  // would otherwise surface downstream as a vague entry with an undefined kind.
  function isWellFormedFault(fault: unknown): boolean {
    if (fault === null || typeof fault !== 'object') return false
    const f = fault as { error?: unknown; recoverable?: unknown }
    if (typeof f.recoverable !== 'boolean') return false
    if (f.error === null || typeof f.error !== 'object') return false
    return typeof (f.error as { kind?: unknown }).kind === 'string'
  }

  function handleSystemResult(s: CompiledSystem, result: SystemResult): void {
    const errors = result.errors
    if (!errors || errors.length === 0) return
    for (const fault of errors) {
      if (strictReturns && !isWellFormedFault(fault)) {
        if (!warnedSystems.has(s.id)) {
          warnedSystems.add(s.id)
          const f = fault as { error?: { kind?: unknown }; recoverable?: unknown } | null
          // eslint-disable-next-line no-console
          console.warn(
            `domecs: system "${s.name}" returned a malformed fault entry — expected { error: { kind: string, ... }, recoverable: boolean } but got error.kind: ${typeof f?.error?.kind}, recoverable: ${typeof f?.recoverable}; the entry is skipped. See doc/error-handling.md.`,
          )
        }
        continue
      }
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

  /**
   * Core tick implementation shared by `step(dt)` and `stepOnce()`.
   *
   * - `dt === undefined` → turn-based full tick at d=0 (stepOnce path).
   *   Systems run, change-detection fires, tick count increments, but time
   *   does not advance.
   * - `dt <= 0` → heartbeat (F-6): plugin hooks + render only. No system
   *   execution, no change-detection buffer swap.
   * - `dt > 0` → real-time tick; time advances by dt seconds.
   */
  function runTick(dt: number | undefined): void {
    // F-6: an explicit dt<=0 is a "heartbeat" — no time advancement,
    // no system execution, no change-detection buffer swap. Plugin hooks,
    // signals, and onRender still fire so UIs can paint initial state
    // and input plugins can republish snapshots between turns.
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
    resourceState.promoteChanges()

    const scaledDt = d * time.scale
    // F-3: accumulate unquantized scaled time, then derive ms-quantized
    // user-visible scaledDelta/elapsed from the cumulative total. Per-frame
    // values stay ms-aligned (SPEC §2.7) but aggregate rates do not drift.
    clock.totalScaledSeconds += scaledDt
    const newQuantizedMs = Math.round(clock.totalScaledSeconds * 1000)
    // F-6: when the caller passed a positive dt, floor per-tick
    // quantized dt at 1 ms so sub-ms wall-clock frames never expose
    // scaledDelta = 0 to consumers that divide by it (PIDs, smoothing
    // filters, rate estimators). stepOnce() keeps its d=0 behaviour.
    // Guard on `d`, not `rawDtMs`: `rawDtMs` can be 0 from quantization
    // carry even with positive caller dt, and that is exactly the case
    // we need to raise to 1 ms.
    const rawDtMs = newQuantizedMs - clock.lastQuantizedElapsedMs
    const dtMs = time.scale !== 0 && d > 0 && rawDtMs < 1 ? 1 : rawDtMs
    clock.lastQuantizedElapsedMs = newQuantizedMs
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
        const expected = Math.floor(clock.totalScaledSeconds / time.fixedStep + 1e-9)
        while (clock.fixedStepsFired < expected) {
          clock.fixedStepsFired += 1
          clock.fixedStepCounter += 1
          for (const s of scheduler.systemsByMode('fixed')) {
            if (!isEnabled(s)) continue
            if (clock.fixedStepCounter % s.fixedDivisor !== 0) continue
            runSystem(s, eventView)
          }
        }
        time.fixedAccumulator =
          clock.totalScaledSeconds - clock.fixedStepsFired * time.fixedStep
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

    getResource<T>(type: ResourceType<T>): T | undefined {
      return resourceState.get(type)
    },

    setResource<T>(type: ResourceType<T>, value: T): void {
      resourceState.set(type, value)
      wakeDriver()
    },

    markResourceChanged<T>(type: ResourceType<T>): void {
      resourceState.markChanged(type)
      wakeDriver()
    },

    componentTypes(): ComponentType<unknown>[] {
      return Array.from(typeRegistry.values())
    },

    resourceTypes(): ResourceType<unknown>[] {
      return resourceState.types()
    },

    *iterEntitiesWith<T>(type: ComponentType<T>): Iterable<{ id: Entity; value: T }> {
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
        fields = cloneFields(meta.__schema.fields)
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

    describeEvent(type: EventType<unknown>): EventDescriptor {
      const meta = internalEvent(type)
      if (meta.__schema) {
        return { name: type.name, fields: cloneFields(meta.__schema.fields), fieldsSource: 'schema' }
      }
      return { name: type.name, fields: {}, fieldsSource: 'none' }
    },

    describeResource<T>(type: ResourceType<T>): ResourceDescriptor {
      return resourceState.describe(type)
    },

    describe(): WorldManifest {
      const componentDescs = world.componentTypes().map((t) => world.describeComponent(t))
      const resourceDescs = world.resourceTypes().map((t) => world.describeResource(t))
      const events = bus.knownTypes().map((t) => ({ name: t.name }))

      const modes: SystemSchedule[] = ['tick', 'fixed', 'event', 'once', 'reactive']
      const systems = modes.flatMap((mode) =>
        scheduler.systemsByMode(mode).map((s) => ({
          name: s.name,
          schedule: s.schedule,
          enabled: s.enabled,
        })),
      )

      const installed = plugins.list()
      const pluginEntries: PluginManifestEntry[] = installed.map((e) => ({
        name: e.plugin.name,
        ...(e.plugin.version !== undefined ? { version: e.plugin.version } : {}),
        provides: e.plugin.provides ?? [],
      }))
      const capabilities = Array.from(
        new Set(installed.flatMap((e) => e.plugin.provides ?? [])),
      ).sort()

      const componentCounts: Record<string, number> = {}
      for (const [name, store] of stores) componentCounts[name] = store.size

      const archetypeList = Array.from(archetypes.values()).map((b) => ({
        components: Array.from(b.types).sort(),
        entityCount: b.entities.size,
      }))

      return {
        components: componentDescs,
        resources: resourceDescs,
        events,
        systems,
        plugins: pluginEntries,
        capabilities,
        snapshotVersion: SNAPSHOT_VERSION,
        entityCount: alive.size,
        componentCounts,
        archetypes: archetypeList,
      }
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

    countEntities(def: QueryDef): number {
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

    listEntities(def: QueryDef): Entity[] {
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

    selectViews(def: QueryDef): EntityView[] {
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

    // Implementation overload — parameter type must accept both declared overloads.
    // The first overload passes Omit<SystemDef,…> & {query:T[]}; casting to
    // SystemDef is safe because the overload constraints enforce valid variants.
    system(name: string, def: SystemDef | (Omit<SystemDef, 'query'> & { query: QueryDef }), fn: System): SystemHandle {
      const handle = scheduler.register(name, def as SystemDef, fn)
      wakeDriver()
      return handle
    },

    getSystem(name: string): SystemHandle | undefined {
      return scheduler.getHandle(name)
    },

    step(dt: number): void {
      // F-6: an explicit dt<=0 is a "heartbeat" — no time advancement,
      // no system execution, no change-detection buffer swap. Plugin hooks,
      // signals, and onRender still fire so UIs can paint initial state
      // and input plugins can republish snapshots between turns.
      //
      // For the turn-based no-arg single advance (delta=0, full tick), use
      // stepOnce() instead.
      runTick(dt)
    },

    stepOnce(): void {
      // Turn-based single advance: full tick with d=0. This is the former
      // no-arg step() behaviour — systems run, change-detection fires, but
      // time does not advance.
      //
      // O-37: fixed systems are driven by the scaled-time accumulator, which
      // only advances when dt > 0. stepOnce() therefore never fires `fixed`
      // systems — use step(fixedStep) (or stepN with a dt) for headless tests
      // of fixed-schedule sims.
      runTick(undefined)
    },

    stepN(n: number, dt?: number): void {
      for (let i = 0; i < n; i++) dt === undefined ? world.stepOnce() : world.step(dt)
    },

    turn<T>(type: EventType<T>, payload: T, dt?: number): void {
      // SPEC §3 turn-based mode: emit action, advance one tick.
      // Because events flush at next step's step 1, we emit first then step.
      bus.emit(type, payload)
      dt === undefined ? world.stepOnce() : world.step(dt)
    },

    action<T>(type: EventType<T>, payload: T, opts: ActionOptions = {}): ActionResult {
      // A typed turn() that surfaces a structured command result. Emit the
      // action, advance one tick (the action flushes at step 1 and its handlers
      // run during steps 3–6), then read back the events those handlers emitted
      // — they are now buffered as "pending" for next tick, so bus.pendingEvents
      // is exactly the command's downstream effects (the action event itself was
      // already consumed and is not included).
      bus.emit(type, payload)
      const heartbeat = opts.dt !== undefined && opts.dt <= 0
      opts.dt === undefined ? world.stepOnce() : world.step(opts.dt)
      // A heartbeat (F-6, dt<=0) never flushes the buffer: the action event
      // is still pending — not consumed, not processed — so it must not be
      // reported as a downstream event, the resolver has no tick to
      // adjudicate, and the command cannot have been accepted. The action
      // stays buffered and flushes on the next real tick.
      const events = heartbeat ? [] : bus.pendingEvents()
      const verdict = heartbeat
        ? {
            accepted: false,
            consumedTurn: false,
            reason: 'heartbeat (dt <= 0): action not processed; it remains pending for the next tick',
          }
        : opts.resolve
          ? opts.resolve({ events, world })
          : { accepted: true, consumedTurn: true }
      const consumedTurn = verdict.consumedTurn ?? verdict.accepted
      const result: ActionResult = {
        accepted: verdict.accepted,
        consumedTurn,
        events,
        ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
      }
      if (opts.snapshot) {
        result.snapshot =
          typeof opts.snapshot === 'object' ? world.snapshot(opts.snapshot) : world.snapshot()
      }
      return result
    },

    startLoop(options?: StartOptions): () => void {
      return driver.startLoop(options)
    },

    stop(): void {
      driver.stop()
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
      let snap = buildSnapshot(stateCtx, options?.pruneEmptyEntities === true)
      for (const entry of plugins.list()) {
        if (entry.handle?.onSnapshot) {
          snap = entry.handle.onSnapshot(snap) as WorldSnapshot
        }
      }
      return snap
    },

    restore(snap: WorldSnapshot): void {
      // Discard pending (undelivered) events first: they were emitted on the
      // timeline being abandoned and would otherwise fire into the first
      // tick after the restore, making identical episodes diverge (SPEC
      // §7.1). Cleared before the plugin chain so anything a plugin emits
      // during onRestore survives.
      bus.clear()
      let s = snap
      for (const entry of plugins.list()) {
        if (entry.handle?.onRestore) s = entry.handle.onRestore(s) as WorldSnapshot
      }

      applySnapshot(stateCtx, s)
    },
  }

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
