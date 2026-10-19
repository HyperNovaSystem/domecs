import { internal, isComponentType } from './component.js'
import { ACT_TAP, type ActTap, type ActTapListener, type ActVia } from './act-tap.js'
import { createChangeLog, type MarkKind } from './change-log.js'
import { createRafDriver } from './driver.js'
import { isResourceType } from './resource.js'
import { createResourceState } from './world-resources.js'
import {
  applySnapshot,
  buildSnapshot,
  resolvePendingEvents,
  validateSnapshot,
  type ArchetypeBucket,
  type CompiledQuery,
  type SnapshotClock,
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
  isEventType,
  validateEventPayload,
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
import { byId, mergeSortedRuns, SortedIdSet } from './id-set.js'
import { emptyInput, type InputSnapshot } from './input.js'
import { createPluginRegistry, type Capability, type Plugin, type TickInfo } from './plugin.js'
import { err, normalizeCause, ok, toJsonValue, type Result } from './result.js'
import { createRng, deriveStream, rewindRng, seedToState, type Rng, type RngState } from './rng.js'
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
import { createTime, fixedStepsDue, type TimeState } from './time.js'
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
// O-57: the frame kind handed to plugin tick hooks.
const HEARTBEAT: TickInfo = Object.freeze({ heartbeat: true })
const FULL_TICK: TickInfo = Object.freeze({ heartbeat: false })

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

// O-74: three-valued archetype match (see matchArchetype in createWorld).
type ArchMatch = 0 | 1 | 2
const ARCH_NO: ArchMatch = 0
const ARCH_MAYBE: ArchMatch = 1
const ARCH_YES: ArchMatch = 2

// The manifest is a plain-data handoff: clone FieldSchema values so no
// consumer holds references into the live component/event schema metadata
// (mutating a manifest must never corrupt reflection world-wide).
/** Short label for a bad {@link World.register} argument in its TypeError. */
function describeValue(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v !== 'object') return typeof v
  const name = (v as { name?: unknown }).name
  return typeof name === 'string' ? `an object named "${name}"` : 'an object'
}

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
  /** Whether `entity` was spawned and has not been despawned (O-61). */
  isAlive(entity: Entity): boolean
  /**
   * The entity's current view — `{ id, [ComponentName]: value }` for every
   * component it holds, the same object queries hand out — or undefined if
   * it is not alive (O-54).
   */
  getView(entity: Entity): EntityView | undefined
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
  /** Replace a resource's value, validate it, and mark it changed. */
  setResource<T>(type: ResourceType<T>, value: T): void
  /**
   * Flag a resource as changed without replacing its value — for in-place
   * edits (`world.getResource(Cfg)!.v = 2`). `OnChangedResource(type)` gates
   * report it within each reader's change window (SPEC §2.9).
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
   * Every known event type — registered, emitted, subscribed to, or named as
   * an event system's trigger — in first-seen order (parity with
   * {@link componentTypes} / {@link resourceTypes}). A fresh array each call.
   */
  eventTypes(): EventType<unknown>[]
  /**
   * Eagerly register component, event and resource types so reflection
   * (`componentTypes()`, `eventTypes()`, `resourceTypes()`, `describe()`) and
   * the `lookup*` methods list them before first use (O-30, §4.5).
   *
   * Registering is idempotent and touches no state the snapshot carries: a
   * resource's default is not materialized, no entity or event is created.
   * Implicit discovery (spawn, emit, `on`, triggers, resource access) works as
   * before; `register` is how to assert that a name is unique — an
   * agent-facing command name must be.
   *
   * All-or-nothing: when any argument's name is already held by a different
   * type of the same kind (or by another argument), nothing is registered and
   * the first conflict is returned as `name_conflict`. Components, events and
   * resources are separate namespaces. Throws `TypeError` for an argument that
   * is not a type made by `defineComponent` / `defineEvent` / `defineResource`.
   *
   * (Resources are taken as `ResourceType<never>` so a `ResourceType<T>` of
   * any `T` is accepted: its brand is contravariant in `T`.)
   */
  register(
    ...types: ReadonlyArray<ComponentType<unknown> | EventType<unknown> | ResourceType<never>>
  ): Result<void, RegisterError>
  /** The component type registered under `name` (eagerly or by first use), or `undefined`. */
  lookupComponent(name: string): ComponentType<unknown> | undefined
  /**
   * The known event type named `name`, or `undefined` when none is known, or
   * when two distinct known event types share the name (F-8 lets them
   * coexist; the name is then ambiguous).
   */
  lookupEvent(name: string): EventType<unknown> | undefined
  /** The resource type registered under `name` (eagerly or by first use), or `undefined`. */
  lookupResource(name: string): ResourceType<unknown> | undefined
  /**
   * Iterate every live entity that currently holds component `type`, paired
   * with its value. Convenience over `world.query(Has(type))` + per-entity
   * `getComponent`; equivalent in semantics, cheaper at the call-site. F-10.
   */
  iterEntitiesWith<T>(type: ComponentType<T>): Iterable<{ id: Entity; value: T }>
  /**
   * The component types `entity` holds, sorted by name (2.3; before, in the
   * order its archetype was first built). Despawn marks, `componentRemoved`
   * and snapshot component keys follow the same order.
   */
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
   * - `dt <= 0` → **heartbeat**: plugin hooks (`onTickStart`, `onRender`,
   *   `onTickEnd`) and the `tickStart`/`tickEnd` signals fire, but system
   *   execution and change-detection buffer swap are skipped (SPEC F-6). To
   *   repaint without re-firing `tickStart`/`tickEnd`, use {@link render}.
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
  /**
   * Run the named enabled `tick`/`fixed` systems once now, in run order (the
   * `fixed` phase, then `tick`; within each, priority, order, registration),
   * without advancing time, flushing events, or firing tickStart/tickEnd
   * (§6.3; O-88). Returns the names it ran (one entry per system run, so a
   * name two systems share appears twice) and the names it skipped: unknown,
   * disabled, or of another schedule (`event`, `reactive`, `once`).
   *
   * Use it only for **derived and transient** state the next tick recomputes
   * anyway — e.g. priming `composeTransforms` output after `restore()`.
   * `ctx.time` is the current time (`scaledDelta` is what the last tick left),
   * `ctx.events` the current view; emits stay queued for the next tick.
   * Tick systems run even while paused and a fixed `rateHz` divisor is not
   * applied. A run is a normal run for change windows (O-42). Mutations are
   * out of tick, so an attached act-log recorder notes an
   * `out_of_tick_mutation` gap whenever a system runs. A throwing system
   * propagates; the systems after it do not run. Throws `TypeError` unless
   * `names` is an array of strings, and `Error` during a tick.
   */
  runSystems(names: readonly string[]): { readonly ran: string[]; readonly skipped: string[] }
  /**
   * Run plugin `onRender` hooks only, with heartbeat `TickInfo`
   * (`{ heartbeat: true }`): no `tickStart`/`tickEnd` signals or plugin tick
   * hooks, no systems, no change to `time` (§6.3; O-88). Advances renderer
   * query windows as the heartbeat render does, so marks are painted once.
   * Use it to redraw after a restore, scrub or branch selection without
   * re-triggering `tickEnd` subscribers. Throws `Error` during a tick.
   */
  render(): void
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
  /**
   * The undelivered events — emitted this tick or between ticks, delivered
   * at step 1 of the next tick — in bus order: by first emit of each type,
   * then payload order within a type (§4.7). A fresh array each call; reading
   * it consumes nothing. Lets a host report what an act produced without
   * `action()`'s extra tick.
   */
  pendingEvents(): EmittedEvent[]
  /**
   * Serialize world state. With `{ pendingEvents: true }` the undelivered
   * events travel too (§4.7), so a world restored from it delivers them on
   * its next tick like the live one.
   */
  snapshot(options?: SnapshotOptions): WorldSnapshot
  /**
   * Replace world state with `snap`. When `snap.pendingEvents` is present,
   * each name resolves through {@link lookupEvent} before any state changes
   * (unknown or ambiguous throws) and the queue becomes those events;
   * otherwise the queue is abandoned (SPEC §7.1).
   */
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


/**
 * Why {@link World.register} refused: `name` is already held, in `registry`,
 * by a different type object (§4.5).
 */
export interface RegisterError {
  readonly kind: 'name_conflict'
  readonly registry: 'component' | 'event' | 'resource'
  readonly name: string
}

export function createWorld(options: WorldOptions = {}): World {
  const seed = options.seed ?? 0
  const headless = options.headless === true
  const idle = options.idle !== false
  const strictReturns = options.strictReturns === true
  const warnedSystems = new Set<number>()
  let rand = createRng(seed)
  // §4.4: the root every own stream derives from — the createWorld seed,
  // replaced by a restored snapshot's `rngRoot`; it never advances. A
  // snapshot without one (v2) restores onto the createWorld root, so the
  // outcome never depends on what the world restored before.
  const createRoot: RngState = seedToState(seed)
  let rngRoot: RngState = createRoot
  // Every own stream this world has created, by stream key. An entry
  // outlives its system: a re-registration under the key resumes it.
  let streams = new Map<string, Rng>()
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

  // §7.1 (G4; O-80): the act-log tap (act-tap.ts). Listeners hear external
  // emits, frame boundaries, out-of-tick mutations and restores.
  const tapListeners = new Set<ActTapListener>()
  // > 0 while a system or an `on` handler runs: replay reproduces their
  // emits, so they are not external.
  let reproducing = 0
  // True only during a full (non-heartbeat) tick: a mutation outside one is
  // a direct write a replay cannot reproduce.
  let inFullTick = false
  let emitVia: ActVia = 'emit'
  // `tapListeners.size > 0`, kept as a plain boolean: the mutation hot paths
  // (`markChanged` runs per entity per tick) test it before calling out, so
  // a world with no recorder pays one field read (E13 bench: soak p50).
  let tapAttached = false

  function tapMutated(): void {
    if (inFullTick) return
    for (const l of tapListeners) l.mutated()
  }

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
  }, (type, payload) => {
    if (tapListeners.size === 0 || reproducing > 0) return
    for (const l of tapListeners) l.emitted(type, payload, emitVia)
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

  // O-42: every add/change/remove mark is stamped into one change log;
  // change-detection filters report the marks in their reader's window
  // (SPEC §2.9). Nothing is reset at tick boundaries.
  const changes = createChangeLog()
  // The stamp at the end of the last completed tick: where a new reader's
  // window starts.
  let lastTickEndSeq = 0
  // Snapshot cursors for systems registered after the restore that carried
  // them, by cursor key (see cursorKey); dropped at the next tick end.
  const pendingCursors = new Map<string, number>()
  let inTick = false

  // The change window the query being read reports (O-42), set around each
  // read of a change-detection query and restored after — reads nest when
  // a Where predicate reads another query.
  let winFrom = 0
  let winTo = 0
  const savedWindows: number[] = []
  const addedStamps = changes.stamps.added
  const changedStamps = changes.stamps.changed
  const removedStamps = changes.stamps.removed

  function inWindow(m: ReadonlyMap<string, ReadonlyMap<Entity, number>>, name: string, entity: Entity): boolean {
    const byEntity = m.get(name)
    if (byEntity === undefined) return false
    const stamp = byEntity.get(entity)
    return stamp !== undefined && stamp > winFrom && stamp <= winTo
  }

  // World-singleton resources (#16) — registry and materialized values live
  // in the extracted resource-state module; changes go to the change log.
  const resourceState = createResourceState((name) => changes.markResource(name))

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
    changes,
    changeCursors: () => {
      const keys = cursorKeys()
      return scheduler
        .all()
        .filter(readsChanges)
        .map((sys) => ({
          name: keys.get(sys)!,
          seenThrough: sys.seenThrough,
          readsRemovals: sys.watchesRemoved,
        }))
    },
    resumeChangeWindows: (base, count, seen) => {
      const end = base + count
      const keys = cursorKeys()
      for (const sys of scheduler.all()) {
        const n = seen[keys.get(sys)!]
        sys.seenThrough = n === undefined ? end : base + n
      }
      pendingCursors.clear()
      for (const [name, n] of Object.entries(seen)) pendingCursors.set(name, base + n)
      for (const q of queries) {
        if (q.owner) continue
        q.seenThrough = end
        q.readThrough = end
      }
      lastTickEndSeq = end
    },
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
    getRngRoot: () => rngRoot,
    getStreams: () => streams,
    restoreStreams: (root, rec) => restoreStreams(root, rec),
    getNextId: () => nextId,
    setNextId: (id) => {
      nextId = id
    },
    setEmptyArch: (arch) => {
      emptyArch = arch
    },
  }

  function archetypeKeyFor(types: Set<string>): string {
    if (types.size === 0) return EMPTY_ARCH_KEY
    // O-49: JSON-encode the sorted names; a plain `|` join made {"a|b"} and
    // {"a", "b"} share a bucket.
    return JSON.stringify(Array.from(types).sort())
  }

  function ensureArchetype(types: Set<string>): ArchetypeBucket {
    const key = archetypeKeyFor(types)
    let bucket = archetypes.get(key)
    if (bucket) return bucket
    // E18.1: the bucket keeps its names sorted, never in the order the first
    // entity happened to gain them. Despawn marks, componentRemoved,
    // archetype() and snapshot keys follow this order, so a world restored
    // from canonicalJson text (sorted keys) records what the live one does.
    bucket = { key, types: new Set(Array.from(types).sort()), entities: new SortedIdSet() }
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

  /**
   * Whether an archetype with `types` can hold entities matching `node`:
   * the candidate filter for every query. `evalEntity` settles the
   * per-entity nodes (`Where`, change filters) for the candidates.
   */
  function evalStructural(node: QueryNode, types: Set<string>): boolean {
    return matchArchetype(node, types) !== ARCH_NO
  }

  /**
   * O-74: three-valued archetype match — every entity of the archetype
   * matches (YES), none does (NO), or it depends on per-entity state such
   * as a `Where` predicate or a change window (MAYBE). Negation keeps MAYBE,
   * so `Not(Where(T, p))` keeps `T` holders as candidates and matches those
   * whose `T` fails `p`, as `evalEntity` does — a two-valued match read
   * `Where` as `Has` and dropped them.
   */
  function matchArchetype(node: QueryNode, types: Set<string>): ArchMatch {
    switch (node.kind) {
      case 'has': requireRegisteredType(node.type); return types.has(node.type.name) ? ARCH_YES : ARCH_NO
      case 'not': return (ARCH_YES - matchArchetype(node.child, types)) as ArchMatch
      case 'or': {
        let m: ArchMatch = ARCH_NO
        for (const c of node.children) {
          const r = matchArchetype(c, types)
          if (r > m) m = r
          if (m === ARCH_YES) break
        }
        return m
      }
      case 'and': {
        let m: ArchMatch = ARCH_YES
        for (const c of node.children) {
          const r = matchArchetype(c, types)
          if (r < m) m = r
          if (m === ARCH_NO) break
        }
        return m
      }
      case 'added':
      case 'changed':
      case 'where':
        requireRegisteredType(node.type)
        return types.has(node.type.name) ? ARCH_MAYBE : ARCH_NO
      // A removed component is no longer in any archetype.
      case 'removed': return ARCH_MAYBE
      // Structurally neutral: a resource gate does not constrain which entities
      // match (it is a per-tick gate evaluated in evalEntity), so it must not
      // prune the And() it sits inside. See ChangedResource (#16).
      case 'changedResource': return ARCH_MAYBE
    }
  }

  function evalEntity(node: QueryNode, entity: Entity): boolean {
    switch (node.kind) {
      case 'has': requireRegisteredType(node.type); return hasType(entity, node.type.name)
      case 'not': return !evalEntity(node.child, entity)
      case 'or': return node.children.some((c) => evalEntity(c, entity))
      case 'and': return node.children.every((c) => evalEntity(c, entity))
      case 'added': return inWindow(addedStamps, node.type.name, entity)
      case 'changed': return inWindow(changedStamps, node.type.name, entity)
      case 'removed': return inWindow(removedStamps, node.type.name, entity)
      case 'where': {
        const v = stores.get(node.type.name)?.get(entity)
        if (v === undefined) return false
        return node.predicate(v)
      }
      // Entity-independent: true for every candidate when the resource
      // changed in the reader's window, false otherwise — so an entity-scoped
      // query like And(Has(X), OnChangedResource(R)) yields the X entities
      // only then. See ChangedResource (#16).
      case 'changedResource':
        return changes.resourceChanged(node.resource.name, { from: winFrom, to: winTo })
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

  // One-shot selection in ascending entity id (SPEC §8, O-40). Archetype
  // iteration order depends on when each archetype was first created, which
  // a restore does not reproduce, so each matching archetype's id-ordered
  // run is merged rather than returned archetype by archetype.
  function selectIds(def: QueryDef): Entity[] {
    const { node, needsEntityFilter } = oneshotNode(def)
    return selectMatching(node, needsEntityFilter)
  }

  function selectMatching(node: QueryNode, needsEntityFilter: boolean): Entity[] {
    const runs: Array<readonly Entity[]> = []
    for (const arch of archetypes.values()) {
      if (!evalStructural(node, arch.types)) continue
      const ids = arch.entities.ordered()
      if (ids.length > 0) runs.push(ids)
    }
    const ids = mergeSortedRuns(runs)
    // `Where` predicates run after the merge, so they see entities in id
    // order too — a predicate with side effects (say, drawing world.rand)
    // makes the same calls live and after a restore.
    return needsEntityFilter ? ids.filter((e) => evalEntity(node, e)) : ids
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
    // O-47: `OnRemoved` reads build views of despawned ids. Ids are never
    // reused, so caching those would grow the cache for the world's life.
    if (alive.has(entity)) viewCache.set(entity, fresh)
    return fresh
  }

  function record(kind: MarkKind, name: string, entity: Entity): void {
    changes.mark(kind, name, entity)
  }

  /**
   * O-42: a system's snapshot cursor key — its name, or `name#k` for the
   * k-th (from 0) live system sharing that name, in registration order.
   */
  function cursorKeys(): Map<CompiledSystem, string> {
    const seen = new Map<string, number>()
    const out = new Map<CompiledSystem, string>()
    for (const sys of scheduler.all()) {
      const k = seen.get(sys.name) ?? 0
      seen.set(sys.name, k + 1)
      out.set(sys, k === 0 ? sys.name : `${sys.name}#${k}`)
    }
    return out
  }

  /**
   * §4.4: the own stream of a system registering now under `name`. Its key
   * is the lowest of `name`, `name#1`, `name#2`, … that no live own-stream
   * system holds — the cursor key (`name`, or `name#k` on a clash) whenever
   * no earlier same-named system was removed — so no two live systems share
   * a generator, and removing and re-registering a system while a
   * same-named one stays live (two rules handles sharing a rule name, each
   * `update()`) resumes the key it left. An existing entry is resumed;
   * otherwise the stream is derived from the root.
   */
  function claimStream(name: string): { key: string; rng: Rng } {
    const held = new Set<string>()
    for (const sys of scheduler.all()) {
      if (sys.rngKey !== undefined) held.add(sys.rngKey)
    }
    let key = name
    for (let k = 1; held.has(key); k++) key = `${name}#${k}`
    let rng = streams.get(key)
    if (rng === undefined) {
      rng = createRng(deriveStream(rngRoot, key))
      streams.set(key, rng)
    }
    return { key, rng }
  }

  /**
   * §4.4 restore: adopt the snapshot's root (absent: the createWorld root), replace the
   * stream map with its streams (absent: empty), then re-derive from the
   * root the stream of every registered own system whose key is missing.
   * Live generators are rewound in place (O-46), so captured `ctx.rand`
   * handles follow. Called after validation, so nothing here throws.
   */
  function restoreStreams(
    root: RngState | undefined,
    rec: Readonly<Record<string, RngState>> | undefined,
  ): void {
    rngRoot = root !== undefined ? seedToState(root) : createRoot
    const prev = streams
    const next = new Map<string, Rng>()
    const held = new Map<string, Rng>()
    for (const sys of scheduler.all()) {
      if (sys.rngKey !== undefined && sys.ownRand !== undefined) held.set(sys.rngKey, sys.ownRand)
    }
    if (rec !== undefined) {
      for (const key of Object.keys(rec)) {
        const state = rec[key]!
        const rng = held.get(key) ?? prev.get(key)
        if (rng !== undefined && rewindRng(rng, state)) next.set(key, rng)
        else next.set(key, createRng(state))
      }
    }
    for (const [key, rng] of held) {
      if (next.has(key)) continue
      rewindRng(rng, deriveStream(rngRoot, key))
      next.set(key, rng)
    }
    streams = next
  }

  /** The key a system registered now under `name` gets (see cursorKeys). */
  function nextCursorKey(name: string): string {
    let k = 0
    for (const sys of scheduler.all()) if (sys.name === name) k++
    return k === 0 ? name : `${name}#${k}`
  }

  /**
   * A system that reads change-detection filters and can still run: a
   * `once` system that has run never reads them again (O-42).
   */
  function readsChanges(sys: CompiledSystem): boolean {
    return sys.watchesChanges && !(sys.schedule === 'once' && sys.ranOnce)
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
    // Removed earlier in the phase that is iterating it (O-43).
    if (s.removed || !s.enabled) return false
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

  /**
   * O-42: marks someone will act on — an enabled reactive system whose
   * `reactsTo` would fire, or a non-system query read in the last tick (a
   * renderer) with unread marks. They keep an idle driver awake; marks no
   * reader cares about do not.
   */
  function hasUnseenWork(): boolean {
    for (const s of scheduler.systemsByMode('reactive')) {
      if (!s.reactsTo || s.seenThrough >= changes.seq || !isEnabled(s)) continue
      if (s.reactsTo.size > 0 || reactiveResourceFallback(s)) return true
    }
    for (const q of queries) {
      if (q.owner || !q.temporal || q.seenThrough >= changes.seq) continue
      if (q.lastReadTick < time.tick) continue
      if (q.peekUnread()) return true
    }
    return false
  }

  // #16: only consulted when a reactive system's reactsTo yielded zero
  // members. Fires iff the reactsTo is purely resource-gated (no structural
  // Has dependency) and one of its ChangedResource targets changed in the
  // system's change window (O-42).
  function reactiveResourceFallback(s: CompiledSystem): boolean {
    if (s.def.schedule !== 'reactive' || !s.def.reactsTo) return false
    const node = normalize(s.def.reactsTo)
    if (!treeHas(node, changedResourceKind)) return false
    if (collectHasComponents(node).size > 0) return false
    const w = { from: s.seenThrough, to: changes.seq }
    for (const name of collectChangedResourceNames(node)) {
      if (changes.resourceChanged(name, w)) return true
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
    if (hasUnseenWork()) return true
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
    // O-42: this run's change window is (seenThrough, runStart]. Whatever is
    // marked while it runs — its own writes included — is after the window,
    // and seenThrough moves past it when the run ends.
    s.runStart = changes.seq
    s.running = true
    reproducing++
    try {
      runSystemBody(s, view)
    } finally {
      reproducing--
      s.running = false
      s.seenThrough = changes.seq
    }
  }

  function runSystemBody(s: CompiledSystem, view: EventView): void {
    const ctx: SystemContext = {
      // Explicit `query` wins; otherwise a reactive system's `reactsTo` delta
      // is delivered as ctx.entities (SPEC: reactive systems see the query
      // delta). Falls back to [] for systems with neither.
      entities: s.query ? s.query.entities : s.reactsTo ? s.reactsTo.entities : [],
      time,
      input,
      events: view,
      world,
      rand: s.ownRand ?? rand,
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
      record('changed', Faulted.name, entity)
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
        plugins.callTickStart(world, HEARTBEAT)
        if (sigTickStart.size > 0) sigTickStart.emit(time)
        plugins.callRender(world, HEARTBEAT)
        plugins.callTickEnd(world, HEARTBEAT)
        if (sigTickEnd.size > 0) sigTickEnd.emit(time)
      } finally {
        inTick = false
        // A heartbeat render has read what it painted (O-42), even if a
        // hook threw (O-53).
        advanceQueryWindows()
      }
      return
    }
    const d = dt ?? 0
    // §7.1: the scale on entry is the one this step's dt is scaled by,
    // before any tickStart hook can change it.
    if (tapListeners.size > 0) {
      for (const l of tapListeners) l.frameEntered(time.tick, dt === undefined ? null : dt, time.scale)
    }

    scheduler.applyPendingReplacements()

    // SPEC §4 step 0. O-42: no change state is reset — readers' windows
    // carry every mark they have not seen.

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
    inFullTick = true
    try {
      // SPEC §9.4 — plugin onTickStart fires at step 0.
      plugins.callTickStart(world, FULL_TICK)
      if (tapListeners.size > 0) for (const l of tapListeners) l.frameStarted()

      // SPEC §4 step 1 — flush event buffer from last tick into readable view.
      // Direct `on` handlers run inside the flush (their emits are reproduced).
      reproducing++
      let eventView: EventView
      try {
        eventView = bus.flush()
      } finally {
        reproducing--
      }
      if (sigTickStart.size > 0) sigTickStart.emit(time)
      if (tapListeners.size > 0) for (const l of tapListeners) l.hooksDone()

      // SPEC §4 step 2 — input collection (stub in headless).

      // SPEC §4 step 3 — fixed systems against shared accumulator (SPEC §3).
      // F-3: drive from cumulative unquantized seconds; ms-rounding drift
      // in per-tick scaledDelta does not entangle the scheduler.
      if (time.scale !== 0) {
        const expected = fixedStepsDue(clock.totalScaledSeconds, time.fixedStep)
        while (clock.fixedStepsFired < expected) {
          clock.fixedStepsFired += 1
          clock.fixedStepCounter += 1
          for (const s of scheduler.systemsByMode('fixed')) {
            if (!isEnabled(s)) continue
            if (clock.fixedStepCounter % s.fixedDivisor !== 0) continue
            runSystem(s, eventView)
          }
        }
      }
      // Kept current even when a tickStart hook paused the world after time
      // advanced: the unrun steps stay owed (snapshot `fixedBacklog`, O-40)
      // and the accumulator reports them.
      time.fixedAccumulator =
        clock.totalScaledSeconds - clock.fixedStepsFired * time.fixedStep

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
        // #16: a reactsTo with no structural entity dependency (no Has leaf)
        // still fires when one of its ChangedResource targets changed —
        // supports world-level resource reactions in entity-empty worlds
        // where the structural member count is zero. Entity-scoped reactsTo
        // (any Has leaf) is governed by `size` only.
        if (s.reactsTo.size > 0 || reactiveResourceFallback(s)) {
          runSystem(s, eventView)
        } else {
          // O-42: checked and empty counts as a run — the window is spent,
          // so a stale mark cannot fire it later when structure changes.
          s.seenThrough = changes.seq
        }
      }

      // SPEC §4 step 7 — renderer diff/commit handled by dom plugin (not core).
      plugins.callRender(world, FULL_TICK)

      // SPEC §9.4 — plugin onTickEnd fires at step 8.
      plugins.callTickEnd(world, FULL_TICK)
      if (sigTickEnd.size > 0) sigTickEnd.emit(time)
    } finally {
      inTick = false
      inFullTick = false
      // SPEC §4 step 8 (O-42): close the tick for change windows. Also when
      // the tick threw (O-53): a query read before the throw has seen what
      // it read, so a renderer whose callback threw is not handed the same
      // marks — and the same throw — every frame after.
      advanceQueryWindows()
    }
    lastTickEndSeq = changes.seq
    pendingCursors.clear()
    changes.pruneRemoved(removalHorizon())
    if (tapListeners.size > 0) for (const l of tapListeners) l.frameEnded()
  }

  /**
   * O-42: a query that is not a system's advances its window, at the end of
   * each tick or heartbeat, to the point of its last read — marks made after
   * that read are reported at its next one.
   */
  function advanceQueryWindows(): void {
    for (const q of queries) {
      if (q.owner || !q.temporal) continue
      if (q.readThrough > q.seenThrough) q.seenThrough = q.readThrough
    }
  }

  /** Removal marks at or below this stamp have been seen by every reader. */
  function removalHorizon(): number {
    let h = changes.seq
    for (const sys of scheduler.all()) {
      if (sys.watchesRemoved && readsChanges(sys) && sys.seenThrough < h) h = sys.seenThrough
    }
    for (const q of queries) {
      if (!q.owner && q.temporal && q.hasRemoved && q.seenThrough < h) h = q.seenThrough
    }
    return h
  }

  /**
   * O-42: enter the change window a read of `q` reports, saving the
   * current one for {@link leaveWindow}.
   */
  function enterWindowOf(q: CompiledQuery): void {
    const prevFrom = winFrom
    const prevTo = winTo
    if (q.owner) {
      const o = q.owner
      winFrom = o.seenThrough
      winTo = o.running ? o.runStart : changes.seq
    } else {
      if (q.temporal) {
        q.readThrough = changes.seq
        q.lastReadTick = time.tick
      }
      winFrom = q.seenThrough
      winTo = changes.seq
    }
    savedWindows.push(prevFrom, prevTo)
  }

  function leaveWindow(): void {
    winTo = savedWindows.pop()!
    winFrom = savedWindows.pop()!
  }

  /**
   * @param readsChanges false for a query only its onAdd/onRemove hooks use
   *   (observe): it is not a change reader, so it never holds back pruning.
   */
  function createQuery(
    def: QueryDef,
    owner: CompiledSystem | null,
    readsChanges = true,
  ): QueryResult {
    const node = normalize(def)
    const hasTickFilter = treeHas(node, tickFilterKinds)
    const hasRemoved = treeHas(node, new Set<QueryNode['kind']>(['removed']))
    const temporal = readsChanges && treeHas(node, oneshotReactiveKinds)
    // O-42: a new reader's window starts at the end of the last tick.
    const start = owner ? 0 : lastTickEndSeq
    const q: CompiledQuery = {
      id: nextQueryId++,
      node,
      hasTickFilter,
      hasRemoved,
      temporal,
      owner,
      seenThrough: start,
      readThrough: start,
      lastReadTick: -1,
      peekUnread: () => false,
      matchingArchetypes: new Set(),
      structuralMembers: new SortedIdSet(),
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
    const removedNames = hasRemoved ? collectRemovedTypeNames(node) : null
    // O-54: a query every match of which carries an added/changed mark of
    // one type takes its candidates from that type's marks in the window,
    // not from every structural member.
    // Hook-only queries (observe) never read a window: no log for them.
    const driver = removedNames || !readsChanges ? null : requiredMark(node)
    const unwatch = driver ? changes.watchMarks(driver.kind, driver.name) : null
    // Call inside the read's window (hasRemoved implies needsEntityFilter).
    const collectCandidates = (): readonly Entity[] => {
      if (driver) {
        // Worth it only when the window is small next to the membership:
        // the marks then need a sort the members do not.
        const marked = changes.markedInWindow(
          driver.kind, driver.name, winFrom, winTo, q.structuralMembers.size >> 2,
        )
        if (marked) {
          // Only structural members are candidates, as on the scan path: a
          // restored mark may name a component the entity no longer has.
          const held = marked.filter((e) => q.structuralMembers.has(e))
          return held.length > 1 ? held.sort(byId) : held
        }
      }
      if (!removedNames) return q.structuralMembers.ordered()
      // Removed: include entities removed within the read's window, which
      // may no longer sit in any structurally matching archetype. Re-sorted
      // so the union keeps ascending id order (SPEC §8, O-40).
      const removed = changes.removedInWindow(removedNames, winFrom, winTo)
      if (removed.length === 0) return q.structuralMembers.ordered()
      const set = new Set<Entity>(q.structuralMembers)
      for (const e of removed) set.add(e)
      return Array.from(set).sort(byId)
    }
    // O-42: whether a read now would report anything, without counting as
    // a read (idle-driver check).
    q.peekUnread = () => {
      if (disposed) return false
      const prevFrom = winFrom
      const prevTo = winTo
      winFrom = q.seenThrough
      winTo = changes.seq
      try {
        for (const e of collectCandidates()) if (evalEntity(node, e)) return true
        return false
      } finally {
        winFrom = prevFrom
        winTo = prevTo
      }
    }

    let disposed = false
    const result: QueryResult = {
      get entities() {
        if (disposed) return []
        // Indexed over the length read up front: membership changes made
        // by a Where predicate mid-loop do not leak into this result.
        const out: EntityView[] = []
        if (needsEntityFilter) enterWindowOf(q)
        try {
          const candidates = collectCandidates()
          const n = candidates.length
          for (let i = 0; i < n; i++) {
            const e = candidates[i]!
            if (needsEntityFilter && !evalEntity(node, e)) continue
            out.push(makeView(e))
          }
        } finally {
          if (needsEntityFilter) leaveWindow()
        }
        return out
      },
      get size() {
        if (disposed) return 0
        if (!needsEntityFilter && !hasRemoved) return q.structuralMembers.size
        let count = 0
        if (needsEntityFilter) enterWindowOf(q)
        try {
          const candidates = collectCandidates()
          const n = candidates.length
          for (let i = 0; i < n; i++) {
            if (needsEntityFilter && !evalEntity(node, candidates[i]!)) continue
            count++
          }
        } finally {
          if (needsEntityFilter) leaveWindow()
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
        unwatch?.()
        const idx = queries.indexOf(q)
        if (idx >= 0) queries.splice(idx, 1)
        q.matchingArchetypes.clear()
        q.structuralMembers.clear()
        q.onAddFns.clear()
        q.onRemoveFns.clear()
      },
    }
    return result
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
      // A restored cursor can sit at the top of the safe range: past it,
      // ids collide (2^53 + 1 === 2^53), so refuse rather than reuse one.
      if (!Number.isSafeInteger(nextId)) {
        throw new RangeError('domecs: spawn: entity ids are exhausted (the next id would exceed Number.MAX_SAFE_INTEGER)')
      }
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
      if (tapAttached) tapMutated()
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
          record('removed', name, entity)
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
      if (tapAttached) tapMutated()
      wakeDriver()
    },

    isAlive(entity: Entity): boolean {
      return alive.has(entity)
    },

    getView(entity: Entity): EntityView | undefined {
      return alive.has(entity) ? makeView(entity) : undefined
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
      record('added', type.name, entity)
      const nextTypes = currentTypes(entity)
      nextTypes.add(type.name)
      moveEntity(entity, nextTypes)
      sigComponentAdded.emit({ entity, type: type as ComponentType<unknown> })
      if (tapAttached) tapMutated()
      wakeDriver()
    },

    removeComponent(entity: Entity, type: ComponentType<unknown>): void {
      requireRegisteredType(type)
      const s = stores.get(type.name)
      if (!s || !s.has(entity)) return
      // SPEC §2.10: componentRemoved fires before the store drops the value.
      sigComponentRemoved.emit({ entity, type })
      s.delete(entity)
      record('removed', type.name, entity)
      const nextTypes = currentTypes(entity)
      nextTypes.delete(type.name)
      moveEntity(entity, nextTypes)
      if (tapAttached) tapMutated()
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
      const store = storeFor(type)
      // A mark on a component the entity lacks can never match OnChanged;
      // recording it would only leave a stamp nothing removes (O-42).
      if (store.has(entity)) {
        record('changed', type.name, entity)
        if (tapAttached) tapMutated()
      }
      wakeDriver()
    },

    getResource<T>(type: ResourceType<T>): T | undefined {
      return resourceState.get(type)
    },

    setResource<T>(type: ResourceType<T>, value: T): void {
      resourceState.set(type, value)
      if (tapAttached) tapMutated()
      wakeDriver()
    },

    markResourceChanged<T>(type: ResourceType<T>): void {
      resourceState.markChanged(type)
      if (tapAttached) tapMutated()
      wakeDriver()
    },

    componentTypes(): ComponentType<unknown>[] {
      return Array.from(typeRegistry.values())
    },

    resourceTypes(): ResourceType<unknown>[] {
      return resourceState.types()
    },

    eventTypes(): EventType<unknown>[] {
      return bus.knownTypes()
    },

    register(
      ...types: ReadonlyArray<ComponentType<unknown> | EventType<unknown> | ResourceType<never>>
    ): Result<void, RegisterError> {
      // Validate the whole call first so a conflict registers nothing.
      const components = new Map<string, ComponentType<unknown>>()
      const events = new Map<string, EventType<unknown>>()
      const resources = new Map<string, ResourceType<unknown>>()
      const conflict = (registry: RegisterError['registry'], name: string) =>
        err<RegisterError>({ kind: 'name_conflict', registry, name })
      for (const t of types) {
        if (isComponentType(t)) {
          const held = components.get(t.name) ?? typeRegistry.get(t.name)
          if (held !== undefined && held !== t) return conflict('component', t.name)
          components.set(t.name, t)
        } else if (isResourceType(t)) {
          const held = resources.get(t.name) ?? resourceState.lookup(t.name)
          if (held !== undefined && held !== t) return conflict('resource', t.name)
          resources.set(t.name, t as ResourceType<unknown>)
        } else if (isEventType(t)) {
          const held = events.get(t.name)
          if ((held !== undefined && held !== t) || bus.nameTakenByOther(t)) {
            return conflict('event', t.name)
          }
          events.set(t.name, t)
        } else {
          throw new TypeError(
            `domecs: register() expects types made by defineComponent, defineEvent or defineResource; got ${describeValue(t)}`,
          )
        }
      }
      for (const t of components.values()) storeFor(t)
      for (const t of events.values()) bus.note(t)
      for (const t of resources.values()) resourceState.register(t as ResourceType<unknown>)
      return ok(undefined)
    },

    lookupComponent(name: string): ComponentType<unknown> | undefined {
      return typeRegistry.get(name)
    },

    lookupEvent(name: string): EventType<unknown> | undefined {
      return bus.lookup(name)
    },

    lookupResource(name: string): ResourceType<unknown> | undefined {
      return resourceState.lookup(name)
    },

    *iterEntitiesWith<T>(type: ComponentType<T>): Iterable<{ id: Entity; value: T }> {
      requireRegisteredType(type)
      const store = stores.get(type.name) as Map<Entity, T> | undefined
      if (!store) return
      // Ascending entity id, like every query form (SPEC §8, O-40). The ids
      // are taken up front: an entity that loses the component mid-iteration
      // is skipped, one that gains it is not visited.
      for (const id of selectMatching(Has(type), false)) {
        const value = store.get(id)
        if (value !== undefined) yield { id, value }
      }
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
      const description =
        meta.__description !== undefined ? { description: meta.__description } : {}
      if (meta.__schema) {
        return {
          name: type.name,
          fields: cloneFields(meta.__schema.fields),
          fieldsSource: 'schema',
          ...description,
        }
      }
      return { name: type.name, fields: {}, fieldsSource: 'none', ...description }
    },

    describeResource<T>(type: ResourceType<T>): ResourceDescriptor {
      return resourceState.describe(type)
    },

    describe(): WorldManifest {
      const componentDescs = world.componentTypes().map((t) => world.describeComponent(t))
      const resourceDescs = world.resourceTypes().map((t) => world.describeResource(t))
      const events = bus.knownTypes().map((t) => world.describeEvent(t))

      const modes: SystemSchedule[] = ['tick', 'fixed', 'event', 'once', 'reactive']
      const systems = modes.flatMap((mode) =>
        scheduler.systemsByMode(mode).map((s) => ({
          name: s.name,
          schedule: s.schedule,
          enabled: s.enabled,
          priority: s.priority,
          order: s.order,
          rng: s.rng,
          components: s.components.slice(),
          ...(s.meta !== undefined ? { meta: cloneSerializable(s.meta) } : {}),
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
      return createQuery(def, null)
    },


    countEntities(def: QueryDef): number {
      const { node, needsEntityFilter } = oneshotNode(def)
      // Predicates run in id order (see selectMatching).
      if (needsEntityFilter) return selectMatching(node, true).length
      let n = 0
      for (const arch of archetypes.values()) {
        if (evalStructural(node, arch.types)) n += arch.entities.size
      }
      return n
    },

    listEntities(def: QueryDef): Entity[] {
      return selectIds(def)
    },

    selectViews(def: QueryDef): EntityView[] {
      return selectIds(def).map((e) => makeView(e))
    },

    observe(def: QueryDef, hooks: QueryHooks): () => void {
      const q = createQuery(def, null, false)
      const unsubscribers: Array<() => void> = []
      if (hooks.onAdd) unsubscribers.push(q.onAdd(hooks.onAdd))
      if (hooks.onRemove) unsubscribers.push(q.onRemove(hooks.onRemove))
      let changeHandle: SystemHandle | null = null
      if (hooks.onChange) {
        const node = normalize(def)
        changeHandle = world.system(
          `__observe_${nextObserverId++}`,
          { schedule: 'reactive', reactsTo: node },
          // The reactive system's own delta: the marks in its window (O-42).
          (ctx) => {
            for (const entity of ctx.entities) hooks.onChange!(entity)
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
      // O-51: an event system's triggers are commands the world accepts —
      // list them in describe() before anything emits them.
      const sdef = def as SystemDef
      if (sdef.schedule === 'event') for (const t of sdef.triggers ?? []) bus.note(t)
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

    runSystems(names: readonly string[]): { readonly ran: string[]; readonly skipped: string[] } {
      if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
        throw new TypeError('domecs: runSystems(names) needs an array of system names (strings)')
      }
      if (inTick) {
        throw new Error('domecs: runSystems must be called outside a tick (not from a system, hook or handler)')
      }
      const wanted = new Set(names)
      // Snapshot both phases first (copy-on-write arrays, O-43): systems a
      // run registers are not run by this call.
      const candidates = [
        ...scheduler.systemsByMode('fixed').filter((s) => wanted.has(s.name)),
        ...scheduler.systemsByMode('tick').filter((s) => wanted.has(s.name)),
      ]
      const ran: string[] = []
      const ranNames = new Set<string>()
      if (candidates.length > 0) {
        const view = bus.view()
        let noted = false
        inTick = true
        try {
          for (const s of candidates) {
            if (!isEnabled(s)) continue
            // §6.3: out of tick, whatever the system writes (or reads from
            // world.rand); a replay cannot reproduce it.
            if (!noted) {
              noted = true
              tapMutated()
            }
            runSystem(s, view)
            ran.push(s.name)
            ranNames.add(s.name)
          }
        } finally {
          inTick = false
          // O-48 as after a restore: an idle loop repaints what ran (also
          // when a system threw) with a heartbeat frame. A wake would make
          // that frame a step and move tick identity, which priming must not.
          if (ran.length > 0 || noted) driver.repaint()
        }
      }
      const skipped: string[] = []
      const listed = new Set<string>()
      for (const n of names) {
        if (ranNames.has(n) || listed.has(n)) continue
        listed.add(n)
        skipped.push(n)
      }
      return { ran, skipped }
    },

    render(): void {
      if (inTick) {
        throw new Error('domecs: render must be called outside a tick (not from a system, hook or handler)')
      }
      inTick = true
      try {
        plugins.callRender(world, HEARTBEAT)
      } finally {
        inTick = false
        // As the heartbeat render (O-42): a renderer has read what it
        // painted, even if a hook threw (O-53).
        advanceQueryWindows()
      }
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
      // O-39: when the event declares a schema, the command boundary rejects
      // malformed payloads outright — no emit, no tick, no consumed turn —
      // instead of accepting a command whose handler will silently no-op or
      // NaN-poison state. Schema-less events remain unvalidated (declare a
      // schema on agent-facing commands to opt in). turn()/emit stay raw.
      const invalid = validateEventPayload(type, payload)
      if (invalid !== null) {
        return {
          accepted: false,
          consumedTurn: false,
          reason: `invalid payload for "${type.name}": ${invalid}`,
          events: [],
        }
      }
      // A typed turn() that surfaces a structured command result. Emit the
      // action, advance one tick (the action flushes at step 1 and its handlers
      // run during steps 3–6), then read back the events those handlers emitted
      // — they are now buffered as "pending" for next tick, so bus.pendingEvents
      // is exactly the command's downstream effects (the action event itself was
      // already consumed and is not included).
      emitVia = 'action'
      try {
        bus.emit(type, payload)
      } finally {
        emitVia = 'emit'
      }
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

    pendingEvents(): EmittedEvent[] {
      return bus.pendingEvents()
    },

    snapshot(options?: SnapshotOptions): WorldSnapshot {
      let snap = buildSnapshot(
        stateCtx,
        options?.pruneEmptyEntities === true,
        options?.pendingEvents === true ? bus.pendingEvents() : undefined,
        (name) => bus.lookup(name),
      )
      for (const entry of plugins.list()) {
        if (entry.handle?.onSnapshot) {
          snap = entry.handle.onSnapshot(snap) as WorldSnapshot
        }
      }
      return snap
    },

    restore(snap: WorldSnapshot): void {
      // Pending (undelivered) events were emitted on the timeline being
      // abandoned and would otherwise fire into the first tick after the
      // restore, making identical episodes diverge (SPEC §7.1). They are set
      // aside before the plugin chain, so anything a plugin emits during
      // onRestore survives.
      if (tapListeners.size > 0) for (const l of tapListeners) l.restoreBegan()
      const abandoned = bus.takePending()
      let s = snap
      let clock: SnapshotClock
      let restored: EmittedEvent[] | undefined
      try {
        for (const entry of plugins.list()) {
          if (entry.handle?.onRestore) s = entry.handle.onRestore(s) as WorldSnapshot
        }
        // The hooks may decode what their onSnapshot encoded, so it is the
        // envelope they produce that must be valid. An invalid one — or a
        // throwing hook — puts the pending events back and throws before
        // world state is touched (O-40).
        clock = validateSnapshot(stateCtx, s)
        // §4.7: resolve in-flight event names before any effect.
        restored = resolvePendingEvents(s, (name) => bus.lookup(name), () => bus.knownTypes())
      } catch (cause) {
        bus.putBackPending(abandoned)
        if (tapListeners.size > 0) for (const l of tapListeners) l.restoreEnded(false)
        throw cause
      }
      applySnapshot(stateCtx, s, clock)
      // The flushed view belongs to the abandoned timeline too (O-88): a
      // restored world reads what a fresh one restored from `s` reads.
      bus.clearCurrent()
      // The snapshot's queue replaces the abandoned one; anything an
      // onRestore hook emitted stays queued after it.
      if (restored !== undefined) bus.prependPending(restored)
      if (tapListeners.size > 0) for (const l of tapListeners) l.restoreEnded(true)
      // O-48: an idle startLoop driver repaints the restored state with a
      // heartbeat frame — no tick, so the world stays at the checkpoint.
      driver.repaint()
    },
  }

  scheduler = createScheduler(
    (def, owner) => createQuery(def, owner),
    fixedStep,
    (name) => pendingCursors.get(nextCursorKey(name)) ?? lastTickEndSeq,
    (name) => claimStream(name),
  )
  plugins = createPluginRegistry(world)

  const tap: ActTap = {
    attach(listener) {
      tapListeners.add(listener)
      tapAttached = true
      return () => {
        tapListeners.delete(listener)
        tapAttached = tapListeners.size > 0
      }
    },
    get inTick() {
      return inTick
    },
    get resumeScale() {
      return preResumeScale
    },
  }
  Object.defineProperty(world, ACT_TAP, { value: tap })

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

/**
 * O-54: an `OnAdded`/`OnChanged` leaf that every match of `node` must
 * satisfy — `node` itself, or such a leaf of an `And` — or null.
 */
function requiredMark(node: QueryNode): { kind: 'added' | 'changed'; name: string } | null {
  if (node.kind === 'added' || node.kind === 'changed') return { kind: node.kind, name: node.type.name }
  if (node.kind === 'and') {
    for (const c of node.children) {
      const r = requiredMark(c)
      if (r) return r
    }
  }
  return null
}

function collectRemovedTypeNames(node: QueryNode, out: Set<string> = new Set()): Set<string> {
  if (node.kind === 'removed') out.add(node.type.name)
  if (node.kind === 'or' || node.kind === 'and') {
    for (const c of node.children) collectRemovedTypeNames(c, out)
  }
  if (node.kind === 'not') collectRemovedTypeNames(node.child, out)
  return out
}
