# DOMECS — API Reference (v1.0)

> **Authoritative source:** the committed type surface in
> [`doc/api-surface/`](./api-surface/) is the contract; this file is a
> derived, human-readable view. Where they disagree, the types win.

Concrete type and function signatures for the public API described in `SPEC.md`. Anything not listed here is internal and may change without notice.

---

## `@domecs/core` (core)

### `createWorld`

```ts
function createWorld(options?: WorldOptions): World

interface WorldOptions {
  seed?:      number | [number, number, number, number]
  headless?:  boolean      // default false; startLoop() throws, world.step(dt) drives ticks; no browser globals required
  fixedStep?: number       // seconds; default 1/60
  idle?:      boolean      // default true; sleep RAF when no frame work remains
}
```

### `defineComponent`

```ts
// Two overloads. The dual-type-arg form captures the literal `Name`, which
// flows through `world.query([T1, T2, ...])` to produce a typed EntityView
// (SPEC §2.4 EntityView typing rule, D-2). The single-type-arg form keeps
// today's behaviour for callers who don't care about typed view fields.
function defineComponent<T, const Name extends string>(
  name:    Name,
  options?: ComponentOptions<T>
): ComponentType<T, Name>
function defineComponent<T>(
  name:    string,
  options?: ComponentOptions<T>
): ComponentType<T, string>

interface ComponentOptions<T> {
  // Copied per entity: arrays and plain objects are cloned on each create()
  // (O-44); other objects (class instances, Maps) are shared by reference.
  defaults?:  Partial<T>
  transient?: boolean        // excluded from snapshots; default false
  // Called after defaults are merged by ComponentType.create() and
  // world.addComponent(). Return true to accept, or a string message to throw.
  validate?:  (value: T) => true | string
  // Optional reflection schema (#14). Surfaced by world.describeComponent so
  // dev tools build edit widgets from the world alone. When omitted,
  // describeComponent infers field kinds from `defaults`.
  schema?:    ComponentSchema
}

// Reflection descriptors (#14). describeComponent resolves `fields` from the
// explicit schema, else infers from defaults, else empty.
type FieldKind = 'number' | 'string' | 'boolean' | 'enum' | 'object' | 'unknown'
interface FieldSchema {
  readonly kind:      FieldKind
  readonly min?:      number
  readonly max?:      number
  readonly step?:     number
  readonly options?:  ReadonlyArray<string | number>  // enum widget
  readonly label?:    string
  readonly readonly?: boolean
  readonly description?: string  // free text for humans/agents; persist round-trips it
}
interface ComponentSchema { readonly fields: Readonly<Record<string, FieldSchema>> }
interface ComponentDescriptor {
  readonly name:         string
  readonly transient:    boolean
  readonly defaults:     Record<string, unknown> | undefined  // independent clone
  readonly fields:       Readonly<Record<string, FieldSchema>>
  readonly fieldsSource: 'schema' | 'defaults' | 'none'
}

interface ComponentType<T, Name extends string = string> {
  readonly name:   Name
  readonly __tag:  unique symbol
  create(value?: Partial<T>): T
}

// Extract a component's value type. Prefer over `ReturnType<typeof X.create>`:
//   type Ship = ComponentValue<typeof Ship>
type ComponentValue<C> = C extends ComponentType<infer T, string> ? T : never
```

Two usage patterns:

```ts
// Untyped views — Position.name widens to `string`. View access is
// `(view as Record<string, unknown>).Position`.
const Position = defineComponent<{ x: number; y: number }>('Position')

// Typed views — Position.name is the literal `'Position'`. View access is
// `view.Position` (typed). Required for the tuple-form query overload to
// produce typed EntityView fields.
const Position = defineComponent<{ x: number; y: number }, 'Position'>('Position')
```

The duplication of `'Position'` in the dual-type-arg form is a TypeScript
limitation: partial type-argument inference does not fill in `Name` from
the argument when `T` is supplied explicitly. The single-arg form remains
fully supported for the common case.

### `defineResource`

World-level named value (SPEC §2.11) — the home for game-global state (score,
level, gravity, the active turn command). Same name-keyed identity discipline
as `defineComponent`: two distinct resource objects sharing a name collide and
the engine throws on the second registration.

```ts
// Two overloads mirroring defineComponent. The dual-type-arg form captures
// the literal Name; the single-arg form widens Name to string.
function defineResource<T, const Name extends string>(
  name:    Name,
  options?: ResourceOptions<T>
): ResourceType<T, Name>
function defineResource<T>(
  name:    string,
  options?: ResourceOptions<T>
): ResourceType<T, string>

interface ResourceOptions<T> {
  // Function default = per-world factory, called lazily on first read.
  // Non-function default = deep-cloned per world (worlds never share it).
  default?:  T | (() => T)
  // Run by setResource and by a materialized default. Return true to accept,
  // or a string message to throw.
  validate?: (value: T) => true | string
}

interface ResourceType<T, Name extends string = string> {
  readonly name: Name
  readonly [__resourceTag]: symbol
}

// Extract a resource's value type:  type S = ResourceValue<typeof Score>
type ResourceValue<R> = R extends ResourceType<infer T, string> ? T : never
```

```ts
const Score = defineResource<number>('Score', { default: 0 })
const Config = defineResource<Cfg, 'Config'>('Config', { default: () => makeConfig() })

world.setResource(Score, 10)      // validates, stores, marks changed
world.getResource(Score)          // → 10 (materializes default on first read)
world.markResourceChanged(Score)  // mark without replacing (in-place mutation)
```

Reactive systems observe resource edges via `OnChangedResource(R)` in `reactsTo`
(see Query builder below and SPEC §4 step 6). Resources are part of
`snapshot()` / `restore()` (Snapshot below).

### `World`

```ts
interface World {
  // lifecycle
  //
  // `startLoop(options?)` installs an rAF-driven loop that computes wall-clock
  // dt, clamps it, and pipes each frame into `step(dt)`. Returns a disposer
  // that calls `stop()`. Calling `startLoop()` on an already-running world is a
  // no-op (returns the disposer) and also wakes a sleeping idle loop. In
  // environments without `requestAnimationFrame` it throws — use `step(dt)`
  // instead. Worlds created with `{ headless: true }` also throw even if rAF
  // exists in the host environment.
  //
  // When `WorldOptions.idle !== false`, the driver sleeps when no always-on
  // frame work remains (no enabled `tick`/`fixed`/unfired `once` systems, no
  // pending component work, no queued events). It wakes on external
  // `world.emit(...)`, structural component mutations / `markChanged`,
  // `@domecs/input` activity, `resume()`, or an explicit `startLoop()`.
  //
  // `step(dt)` semantics (`dt` is required):
  //   - `step(dt)` with `dt > 0`: normal tick advance.
  //   - `step(dt)` with `dt <= 0` — F-6 heartbeat: no tick advance, no system
  //     execution, no change-detection buffer swap. Plugin hooks +
  //     tickStart/tickEnd signals + onRender still fire so UIs can paint
  //     initial state and input plugins can republish snapshots between
  //     turns. Use this to prime the world before `startLoop()` or to poll
  //     between turns in a turn-based game.
  //   - `stepOnce()`: advance exactly one tick with `delta = 0` — the
  //     turn-based single step. Systems run normally; time does not advance.
  //     (This is the former no-arg `step()` behaviour. `turn()` uses it.)
  //     O-37: fixed systems are driven by the scaled-time accumulator, which
  //     only advances when dt > 0. stepOnce() therefore never fires `fixed`
  //     systems — use step(fixedStep) for headless fixed-schedule tests.
  //   - `step(dt)` with `0 < dt < 1 ms`: dt is floored at 1 ms of
  //     scaled time so PID derivative consumers never see `scaledDelta=0`.
  //     See SPEC §2.7.
  //
  // Pause / scale-0 gating (O-3): `tick` and `fixed` systems do not run while
  // `time.scale === 0` (pause / setScale(0)). Control input that must work
  // while paused belongs on the always-fires `tickStart` signal, plugin
  // onTickStart, or outside the world (DOM keydown → pause/resume/setScale).
  startLoop(options?: StartOptions): () => void
  stop():   void
  step(dt: number):  void      // see rules above
  stepOnce(): void             // one tick, delta = 0; fixed systems do not fire
  stepN(n: number, dt?: number): void

  // Turn-based action: emit an event and advance one tick.
  turn<T>(type: EventType<T>, payload: T, dt?: number): void

  // Turn-based command with a structured result (#17). Like turn(), but
  // returns { accepted, consumedTurn, reason?, events, snapshot? }. `events`
  // are the events emitted during the action's tick (downstream effects; the
  // action event itself was consumed at step 1). The verdict comes from
  // opts.resolve (default { accepted: true, consumedTurn: true }; an omitted
  // consumedTurn mirrors accepted). action advances one tick — except with an
  // explicit opts.dt <= 0 (F-6 heartbeat): the action is NOT processed and
  // stays buffered for the next real tick; the result is then
  // { accepted: false, consumedTurn: false, events: [] } with a reason, and
  // opts.resolve is not invoked. consumedTurn is a reported value, not
  // engine-enforced.
  // O-39: when the event declares a schema, the payload is validated FIRST —
  // unknown fields, wrong-typed declared fields, or out-of-enum values reject
  // with { accepted: false, reason } before any emit and with NO tick advance.
  // Absent declared fields are optional; schema-less events are unvalidated,
  // as are turn()/emit. SPEC §3.
  action<T>(type: EventType<T>, payload: T, opts?: ActionOptions): ActionResult

  // entities
  spawn(components?: ComponentBag): Entity
  despawn(entity: Entity): void
  isAlive(entity: Entity): boolean          // spawned and not despawned (O-61)
  // The entity's current view ({ id, [ComponentName]: value }, the object
  // queries hand out), or undefined when it is not alive.
  getView(entity: Entity): EntityView | undefined
  has(entity: Entity, type: ComponentType<unknown>): boolean

  // components
  addComponent<T>(entity: Entity, type: ComponentType<T>, value: T): void
  removeComponent(entity: Entity, type: ComponentType<unknown>): void
  getComponent<T>(entity: Entity, type: ComponentType<T>): T | undefined
  // May be called inside or outside a running system. Each change-detection
  // reader reports the mark in its change window: a system at its next run
  // (never its own writes back to itself), any other live query at its next
  // read. See SPEC §2.9 (O-42).
  // v1.0 has no proxy-backed dev diagnostics surface: no WorldOptions.dev and
  // no world.diag. Missed marks are caller bugs; future tooling may warn.
  markChanged<T>(entity: Entity, type: ComponentType<T>): void

  // resources (SPEC §2.11). Marks land in readers' change windows like
  // markChanged. getResource() returns undefined only when there is no value
  // and no default; a default is materialized (validated, stored) on first
  // read. setResource validates + stores + marks changed; markResourceChanged
  // marks without replacing (for in-place mutation). Both wake an idle driver.
  getResource<T>(type: ResourceType<T>): T | undefined
  setResource<T>(type: ResourceType<T>, value: T): void
  markResourceChanged<T>(type: ResourceType<T>): void

  // systems
  system(name: string, def: SystemDef, fn: System): SystemHandle
  // The live SystemHandle for a registered system by name (built-in or
  // user-registered), or undefined. Flipping its enabled/disable() affects
  // scheduling on the next step — the escape hatch for disabling built-ins
  // like the fault consolidator (CONSOLIDATE_FAULTS_NAME).
  getSystem(name: string): SystemHandle | undefined

  // queries — every form iterates in ascending entity id (query().entities,
  // system ctx.entities, reactive deltas, listEntities, selectViews,
  // countEntities, iterEntitiesWith; Where predicates too — SPEC §8)
  query(def: QueryDef): QueryResult
  // Leak-free one-shot selectors: evaluate the current world without
  // registering a live query (nothing to dispose). Accept Has/Not/And/Or/Where;
  // reactive nodes (OnAdded/OnChanged/OnRemoved/OnChangedResource) reject at
  // compile time (and throw at runtime for untyped JS callers) — use
  // query()/observe() for per-tick deltas. countEntities → number, listEntities →
  // Entity[], selectViews → EntityView[] (typed fields for the array shorthand, like query()).
  countEntities(def: OneShotQueryDef): number
  listEntities(def: OneShotQueryDef): Entity[]
  selectViews(def: OneShotQueryDef): EntityView[]
  // Convenience over query(...).onAdd/onRemove. If hooks.onChange is present,
  // def must contain at least one OnAdded/OnRemoved/OnChanged node; callbacks fire
  // at step 6 reactive time, once per matching entity for that tick.
  observe(def: QueryDef, hooks: QueryHooks): () => void

  // events
  emit<T>(type: EventType<T>, payload: T): void
  on<T>(type: EventType<T>, fn: (e: T) => void): () => void
  // This tick's delivered events (the view event systems read).
  readonly events: EventView

  // input — the snapshot @domecs/input publishes at onTickStart; setInput is
  // how an input plugin (or a test) publishes one.
  readonly input: InputSnapshot
  setInput(snap: InputSnapshot): void

  // time
  readonly time:  Readonly<TimeState>
  // setScale(0) is equivalent to pause(); setScale(x>0) updates the stored
  // pre-pause scale and resumes if paused. Negative or non-finite scales
  // throw. SPEC §2.7 scale-control rule (D-3).
  setScale(scale: number): void
  pause():  void
  resume(): void

  // Idle-driver wake (D-4). External event sources call this after mutating
  // world state from outside a tick so the idle RAF loop schedules a frame.
  // No-op when the driver is not running, when `idle: false`, or while
  // inside a tick. SPEC §3 idle suspension.
  requestTick(): void

  // random
  readonly rand: Rng

  // plugins — use() returns the disposer, or the install's DomecsError; it
  // throws for programmer errors such as a duplicate plugin name.
  use<O>(plugin: Plugin<O>, options?: O): Result<() => void, DomecsError>
  capability<K extends string>(name: K): Capability<K>

  // reflection
  componentTypes(): ComponentType<unknown>[]
  // Iterate every live entity carrying `type`, paired with its value. Same
  // semantics as `world.query(Has(type))` + per-entity `getComponent`, with
  // less ceremony at the call-site (F-10).
  iterEntitiesWith<T>(type: ComponentType<T>): Iterable<{ id: Entity; value: T }>
  archetype(entity: Entity): ComponentType<unknown>[]
  // Reflect a component's name/transient/defaults/field-schema (#14). Works on
  // any ComponentType without prior registration; enumerate via componentTypes().
  describeComponent(type: ComponentType<unknown>): ComponentDescriptor
  resourceTypes(): ResourceType<unknown>[]
  describeResource<T>(type: ResourceType<T>): ResourceDescriptor
  // An event's name, declared schema fields (fieldsSource 'schema' | 'none')
  // and `description` when defineEvent was given one.
  describeEvent(type: EventType<unknown>): EventDescriptor
  // Every known event type (registered, emitted, subscribed to, or named as a
  // trigger), first-seen order. Fresh array each call.
  eventTypes(): EventType<unknown>[]
  // The world manifest (agents: bridge.observe()). Schema: components,
  // resources, events (EventDescriptors: every type registered, emitted,
  // subscribed to, or named as an event system's trigger — O-51), systems,
  // plugins, capabilities, snapshotVersion. Live: entityCount,
  // componentCounts, archetypes. Cheap enough to poll. See WorldManifest.
  describe(): WorldManifest

  // registry and name lookup (O-30, O-78)
  // Eagerly register types so componentTypes()/eventTypes()/resourceTypes(),
  // describe() and lookup* list them before first use. Idempotent and
  // all-or-nothing; a name already held by a *different* type of the same
  // kind (or by another argument) → err name_conflict, nothing registered.
  // Components, events and resources are separate namespaces. Touches nothing
  // the snapshot carries (a resource default is not materialized). Throws
  // TypeError only for a value that is not a defined type.
  register(
    ...types: ReadonlyArray<ComponentType<unknown> | EventType<unknown> | ResourceType<never>>
  ): Result<void, RegisterError>
  lookupComponent(name: string): ComponentType<unknown> | undefined
  // undefined when unknown, or when two distinct known event types share the
  // name (F-8 lets them coexist; the name is then ambiguous).
  lookupEvent(name: string): EventType<unknown> | undefined
  lookupResource(name: string): ResourceType<unknown> | undefined

  // snapshots
  // options.pruneEmptyEntities (default false): drop entities whose
  // serializable bag is empty once transient components are excluded —
  // transient-only and bare spawn() entities. Persist's
  // pruneTransientOnlyEntities() plugin applies this on the no-arg save() path.
  // options.pendingEvents (default false): record the undelivered events, so
  // a fork restored from it delivers them on its next tick (O-90). A pending
  // payload that is not plain data, or a pending event whose name another
  // known event type shares, throws TypeError naming the event.
  snapshot(options?: SnapshotOptions): WorldSnapshot
  // The undelivered events in bus order (first emit of each type, then
  // payload order). A fresh array; reading consumes nothing.
  pendingEvents(): EmittedEvent[]
  // Trusted authored-snapshot restore. Rehydrates name-keyed component bags;
  // strict schema validation and unknown-component tooling are future work.
  // The envelope shape (seed, rngRoot, rngStreams, tick, nextId, every
  // entity record's id and components bag — O-41) and incoming values for *registered* resource
  // types (their validate hook, mirroring setResource) are checked BEFORE any
  // state is wiped; an invalid snapshot throws and leaves the world
  // untouched. Component values are not re-validated — the live path
  // validates only at Component.create(). world.rand is rewound in place, so
  // captured references follow the restore (O-46); so are own streams, after
  // the map is replaced by snap.rngStreams and every registered own-stream
  // system whose key is missing is re-derived from the restored root
  // (snap.rngRoot, or this world's own for a v2 snapshot). A snapshot whose version
  // is newer than SNAPSHOT_VERSION throws (O-63); migrate older ones first.
  // The pending event queue is abandoned — or, when snap.pendingEvents is
  // present, replaced by it after every name resolves through lookupEvent
  // (unknown or ambiguous → throws before any state change).
  restore(snap: WorldSnapshot): void

  // signals
  //
  // Listener-gated: a signal with no subscribers is a noop — the world skips
  // the bookkeeping needed to fan out that event. Users who attach no
  // subscribers pay zero for signals they do not consume. Subscribers run
  // synchronously in the tick phase that emitted the signal (SPEC §2.10).
  readonly signals: {
    entitySpawned:   Signal<Entity>
    entityDespawned: Signal<Entity>
    componentAdded:  Signal<{ entity: Entity; type: ComponentType<unknown> }>
    componentRemoved: Signal<{ entity: Entity; type: ComponentType<unknown> }>
    tickStart:       Signal<TimeState>
    tickEnd:         Signal<TimeState>
    // A system returned a fault with no entity (doc/error-handling.md).
    faultRaised:     Signal<SystemicFault>
  }
}

type Entity = number

interface RegisterError {
  readonly kind:     'name_conflict'
  readonly registry: 'component' | 'event' | 'resource'
  readonly name:     string
}

interface WorldManifest {
  readonly components: ComponentDescriptor[]
  readonly resources:  ResourceDescriptor[]
  readonly events:     EventDescriptor[]
  readonly systems: {
    readonly name:       string
    readonly schedule:   SystemSchedule
    readonly enabled:    boolean
    readonly priority:   number
    readonly order:      number
    readonly rng:        'shared' | 'own'   // SystemDef.rng (2.1)
    // Sorted, de-duplicated component names every query / reactsTo leaf
    // names (Not branches included; resource leaves excluded).
    readonly components: string[]
    readonly meta?:      JsonValue   // SystemDef.meta, cloned per call
  }[]
  readonly plugins:         PluginManifestEntry[]
  readonly capabilities:    string[]
  readonly snapshotVersion: number
  readonly entityCount:     number
  readonly componentCounts: Record<string, number>
  readonly archetypes: { readonly components: string[]; readonly entityCount: number }[]
}

// Options for `World.startLoop`. The rAF driver is intentionally thin:
// compute wall-clock dt, clamp it, pipe it to step(dt). Consumers that
// need custom scheduling keep using `step()` directly.
interface StartOptions {
  dtClampMs?:    number   // default 100
  // Default true. On document.hidden, pause only if the world was running;
  // on re-show, resume only a pause the driver itself initiated (O-32).
  // App-managed world.pause() is not trampled. Pass false to opt out.
  pauseOnHidden?: boolean
}

// world.action types (#17). EmittedEvent pairs a buffered payload with its
// originating EventType.
interface EmittedEvent { readonly type: EventType<unknown>; readonly payload: unknown }
type ActionEvent = EmittedEvent

// Game policy: derive the verdict from the tick's events + world. Omit to
// default to { accepted: true, consumedTurn: true }.
type ActionResolver = (ctx: {
  events: readonly ActionEvent[]
  world:  World
}) => ActionVerdict

interface ActionVerdict {
  accepted:      boolean
  consumedTurn?: boolean   // defaults to `accepted` when omitted
  reason?:       string
}

interface ActionOptions {
  dt?:       number                      // forwarded to step(); omit for a turn-based advance.
                                         // dt <= 0 = heartbeat: action not processed (see above)
  resolve?:  ActionResolver
  snapshot?: boolean | SnapshotOptions   // true = defaults; object = forwarded options
}

interface ActionResult {
  accepted:     boolean
  consumedTurn: boolean
  reason?:      string
  events:       readonly ActionEvent[]   // emitted during the action's tick
  snapshot?:    WorldSnapshot            // present only when opts.snapshot set
}

// Observation channel returned from `World.signals`. Subscribers fire
// synchronously in the tick phase that emitted the signal (see SPEC §2.10).
interface Signal<T> {
  subscribe(fn: (e: T) => void): () => void   // returns unsubscribe
}

// Spawn bags: pass components either as a Map (runtime-keyed by ComponentType)
// or as a readonly array of tuple pairs. For tuple arrays, prefer
// `entry(type, value)` over raw `[type, value]` — `entry<T>()` preserves the
// tie between the tuple's component type and its value's T under strict
// TypeScript, eliminating `as never` casts (F-7 in doc/findings.md).
type ComponentEntry<T = unknown> = readonly [ComponentType<T>, T]
type ComponentBag =
  | ReadonlyMap<ComponentType<unknown>, unknown>
  | ReadonlyArray<ComponentEntry<any>>

function entry<T>(type: ComponentType<T>, value: T): ComponentEntry<T>

interface SystemDef {
  query?:    QueryDef
  schedule?: 'tick' | 'fixed' | 'event' | 'once' | 'reactive'
  priority?: number                        // lower runs first; default 0
  order?:    number                        // tie-break within a priority; default 0, finite (throws otherwise)
  rateHz?:   number                        // fixed only
  triggers?: EventType<unknown>[]          // event only
  reactsTo?: QueryDef                      // reactive only
  enabled?:  () => boolean
  state?:    unknown                       // system-local; preserved across dev-mode hot-swap (SPEC §9.5)
  meta?:     JsonValue                     // annotation for tools; cloned into describe().systems[i].meta
                                           // (@domecs/rules sets { rule: name }); non-JSON
                                           // (function, undefined, NaN, class instance, cycle)
                                           // → world.system() throws TypeError
  rng?:      'shared' | 'own'              // which stream ctx.rand is (SPEC §2.8, 2.1): 'shared' (default)
                                           // = world.rand; 'own' = a stream keyed by the system's cursor
                                           // key, derived from the world's root seed, kept across
                                           // removal and snapshotted (rngStreams); else throws
}

type System = (ctx: SystemContext) => void

interface SystemContext {
  // For `tick`/`fixed`/`once` systems: the `query` result. For `reactive`
  // systems with only `reactsTo` and no explicit `query`: the `reactsTo`
  // change delta — marks since the system last ran (an explicit `query`
  // takes precedence). Empty
  // when neither is declared.
  entities: EntityView[]
  time:     TimeState
  input:    InputSnapshot
  events:   EventView
  world:    WorldAPI
  rand:     Rng                            // world.rand, or the system's own stream (rng: 'own')
  state:    unknown                        // system-local; read SystemDef.state
}

// EntityView carries only the components the entity currently holds — never
// keys for unrelated types (SPEC §2.4 EntityView shape rule, P-1). Within a
// stable archetype, the engine returns the same view object across reads
// (SPEC §2.4 EntityView caching rule, P-2).
//
// `Fields` is inferred by the typed tuple-form query overload, so
// `world.query([Position, Velocity] as const).entities[0]` yields a view
// whose `Position` / `Velocity` fields are typed. Combinator-form queries
// fall back to the unconstrained shape and use `world.getComponent` for
// typed access. SPEC §2.4 EntityView typing rule (D-2).
type EntityView<Fields = Record<string, unknown>> = Readonly<Fields> & {
  readonly id: Entity
}

// Project a tuple of `ComponentType<T, Name>` into the field record of a
// typed `EntityView`. Capturing the literal `Name` requires declaring the
// component with both type parameters:
//   defineComponent<{x:number;y:number}, 'Position'>('Position')
// The single-arg form `defineComponent<T>('Name')` still works but widens
// `Name` to `string` and the resulting view falls back to the untyped
// shape.
type FieldsFromComponents<
  T extends readonly ComponentType<unknown, string>[]
> = /* …distributes over T[number] and intersects {Name: V}… */ unknown

interface SystemHandle {
  name:     string
  enabled:  boolean
  enable():  void
  disable(): void
  remove():  void
  replaceFn?(fn: System): void   // source/dev builds; SPEC §9.5. Queued for next tick boundary.
}

interface Rng {
  next():      number          // [0, 1)
  int(max: number): number     // [0, max)
  range(lo: number, hi: number): number
  pick<T>(arr: readonly T[]): T
  roll(sides: number): number  // [1, sides]
  seed():      readonly [number, number, number, number]
  fork(label: string): Rng     // deterministic subrng
}
```

### Query builder

```ts
type QueryDef = QueryNode

// Component shortcuts carry a single ComponentType and produce a leaf node.
// Predicate combinators (Not / And / Or) carry child QueryNodes.
type QueryNode =
  | { kind: 'has';      type: ComponentType<unknown> }
  | { kind: 'changed';  type: ComponentType<unknown> }
  | { kind: 'added';    type: ComponentType<unknown> }
  | { kind: 'removed';  type: ComponentType<unknown> }
  | { kind: 'where';    type: ComponentType<unknown>; predicate: (v: unknown) => boolean }
  | { kind: 'changedResource'; resource: ResourceType<unknown> }
  | { kind: 'not';      child: QueryNode }
  | { kind: 'and';      children: QueryNode[] }
  | { kind: 'or';       children: QueryNode[] }

// Component shortcuts: take a ComponentType, produce a leaf node.
function Has<T>(t: ComponentType<T>): QueryNode
function OnChanged<T>(t: ComponentType<T>): TemporalQueryNode
function OnAdded<T>(t: ComponentType<T>): TemporalQueryNode
function OnRemoved<T>(t: ComponentType<T>): TemporalQueryNode
function Where<T>(t: ComponentType<T>, p: (v: T) => boolean): QueryNode

// Resource change-detection node (SPEC §2.11): fires when resource R changed
// within the reader's change window (SPEC §2.9). Structurally neutral —
// matches every entity then, none otherwise — so And(Has(T),
// OnChangedResource(R)) yields the T entities only when R changed; a bare OnChangedResource(R) is a
// world-level edge a reactive system reacts to even in an empty world.
// Counts as a change-detection node for the reactsTo contract (SPEC §4 step 6).
function OnChangedResource<T>(r: ResourceType<T>): TemporalQueryNode

// Predicate combinators: take child QueryNodes, OR a bare ComponentType as a
// one-arg shortcut for Has(T). `Not(Player)` and `Not(Has(Player))` are
// equivalent; `And(Position, Velocity)` and `And(Has(Position), Has(Velocity))`
// are equivalent.
type NodeOrComponent = QueryNode | ComponentType<unknown>
function Not(arg: NodeOrComponent): QueryNode
function And(...args: NodeOrComponent[]): QueryNode
function Or(...args: NodeOrComponent[]): QueryNode

// shorthand: a plain array is sugar for And(Has(A), Has(B), ...)
type QueryShorthand = ComponentType<unknown>[] | QueryNode

// QueryResult is parameterized by the inferred view fields. Tuple-form
// queries supply typed fields automatically; combinator-form queries leave
// `Fields` at its default and the view stays untyped.
interface QueryResult<Fields = Record<string, unknown>> {
  readonly entities: ReadonlyArray<EntityView<Fields>>
  readonly size:     number
  onAdd(fn: (e: EntityView<Fields>) => void): () => void
  onRemove(fn: (e: EntityView<Fields>) => void): () => void
  dispose(): void // releases live archetype tracking; entities=[], size=0 after disposal
}

// World.query has two overloads. The tuple form infers typed fields:
//   const q = world.query([Position, Velocity] as const)
//   q.entities[0]!.Position.x  // typed as number
// The combinator form returns a generic result:
//   const q = world.query(And(Has(Position), Not(Dead)))
interface WorldQuery {
  <T extends readonly ComponentType<unknown, string>[]>(
    def: readonly [...T],
  ): QueryResult<FieldsFromComponents<T>>
  (def: QueryDef): QueryResult
}

interface QueryHooks<Fields = Record<string, unknown>> {
  onAdd?:    (e: EntityView<Fields>) => void
  onRemove?: (e: EntityView<Fields>) => void
  // Requires a change-detection query (OnAdded/OnRemoved/OnChanged/OnChangedResource
  // somewhere in the tree). Fires at the reactive phase for every entity
  // currently in the query result after that tick's mutations are coalesced.
  onChange?: (e: EntityView<Fields>) => void
}
```

### Events

```ts
function defineEvent<T>(name: string, options?: EventDefOptions): EventType<T>

// The O-39 payload check world.action / bridge.act apply, without emitting or
// stepping: null when valid (always null for a schema-less event), else a
// reason fragment. A rejected action reports
// `invalid payload for "<name>": <fragment>`. Shallow: payload must be a
// non-null, non-array object; own keys not declared are rejected (names only
// inherited from Object.prototype, e.g. toString, count as undeclared);
// declared keys (all optional) must match their kind / enum options;
// 'unknown' accepts anything.
function validateEventPayload(type: EventType<unknown>, payload: unknown): string | null

interface EventDefOptions {
  // Payload field schema (component FieldSchema vocabulary). World.action /
  // bridge.act validate payloads against it (O-39).
  readonly schema?:      ComponentSchema
  // Free text: what the command does. Surfaced by describeEvent/describe().
  readonly description?: string
}

interface EventDescriptor {
  readonly name:         string
  readonly fields:       Readonly<Record<string, FieldSchema>>
  readonly fieldsSource: 'schema' | 'none'
  readonly description?: string
}

// `EventType<T>` is identity-keyed: the bus dispatches on a per-instance
// symbol stored on the type object, not on `name`. Two `defineEvent('Same')`
// calls produce distinct types whose payload buckets, subscribers, and views
// never collide. `name` is an opaque label for diagnostics — duplicates are
// permitted (F-8), but a name two known types share is ambiguous to
// world.lookupEvent / bridge.act(name, …). Keep agent-facing command names
// unique; world.register(Cmd) asserts it.
interface EventType<T> {
  readonly name: string
}

interface EventView {
  of<T>(type: EventType<T>): readonly T[]
  emit<T>(type: EventType<T>, payload: T): void
}
```

Pre-validate a command (a form, an editor, an agent harness) with the same
check `action()` uses, so the two never drift:

```ts doctest name=validate-event-payload
import { strict as assert } from 'node:assert'
import { createWorld, defineEvent, validateEventPayload } from '@domecs/core'

const Move = defineEvent<{ dx: number; mode?: 'walk' | 'run' }>('Move', {
  schema: { fields: { dx: { kind: 'number' }, mode: { kind: 'enum', options: ['walk', 'run'] } } },
})

assert.equal(validateEventPayload(Move, { dx: 2, mode: 'run' }), null)
const why = validateEventPayload(Move, { dx: 2, dz: 1 })
assert.match(why!, /unknown field "dz"/)

const world = createWorld({ headless: true })
const result = world.action(Move, { dx: 2, dz: 1 } as never)
assert.equal(result.accepted, false)
assert.equal(result.reason, `invalid payload for "Move": ${why}`)
```

**Inter-entity references.** Components carrying foreign-entity ids
(`tableId: Entity | null`, `customerId: Entity | null`) become dangling on
despawn. The canonical cleanup pattern uses `signals.entityDespawned`
(SPEC §2.10 despawn ordering rule) plus `world.iterEntitiesWith`:

```ts
world.signals.entityDespawned.subscribe((dead) => {
  for (const { id, value } of world.iterEntitiesWith(Table)) {
    if (value.customerId === dead) value.customerId = null
    if (value.waiterId === dead)   value.waiterId   = null
  }
})
```

The signal fires *after* the entity is reclaimed, so subscribers see a
consistent world; one global listener replaces per-system null-guards.

An event emitted *during* a tick is buffered and becomes readable at the
**next** tick's step-1 flush — a consumer event-system sees a producer's
event on the following `stepOnce`, never the same one:

```ts doctest name=event-tick-delay
import { strict as assert } from 'node:assert'
import { createWorld, defineEvent } from '@domecs/core'

const w = createWorld()
const Hit = defineEvent<{ dmg: number }>('Hit')

const seen: number[] = []
// Producer emits Hit during its tick; events are buffered for the next tick.
w.system('emit-hit', { schedule: 'once' }, (ctx) => {
  ctx.events.emit(Hit, { dmg: 7 })
})
// Consumer runs when Hit fired and reads the payload.
w.system('read-hits', { schedule: 'event', triggers: [Hit] }, (ctx) => {
  for (const e of ctx.events.of(Hit)) seen.push(e.dmg)
})

w.stepOnce() // tick 1: producer emits (buffered); consumer has not seen it yet
assert.deepEqual(seen, [])
w.stepOnce() // tick 2: step-1 flush delivers Hit to the consumer
assert.deepEqual(seen, [7])
```

Events in flight between two ticks travel with a snapshot only when it is
taken with `{ pendingEvents: true }` (O-90). Restore resolves each name with
`world.lookupEvent`, so the restoring world must know the type —
`register` it in setup (or subscribe, or name it in `triggers`). Payloads
must be plain data and each pending type's name unique among the known
event types; anything else throws `TypeError` at `snapshot()`.
`world.pendingEvents()` shows the queue without consuming it:

```ts doctest name=pending-events-fork
import { strict as assert } from 'node:assert'
import { createWorld, defineComponent, defineEvent, entry, hashSnapshot, type World } from '@domecs/core'

const Score = defineComponent<{ n: number }>('PeScore', { defaults: { n: 0 } })
const Goal = defineEvent<{ points: number }>('PeGoal')

function build(): World {
  const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
  w.register(Goal) // a fork must know every event type that can be in flight
  w.system('kick', {}, (ctx) => {
    if (ctx.time.tick === 3) ctx.events.emit(Goal, { points: 2 })
  })
  w.system('score', { schedule: 'event', triggers: [Goal] }, (ctx) => {
    for (const id of ctx.world.listEntities([Score])) {
      for (const g of ctx.events.of(Goal)) ctx.world.getComponent(id, Score)!.n += g.points
      ctx.world.markChanged(id, Score)
    }
  })
  return w
}

const live = build()
live.spawn([entry(Score, { n: 0 })])
live.stepOnce()
live.stepOnce()
live.stepOnce() // tick 3 emits Goal; it is delivered at tick 4
assert.deepEqual(live.pendingEvents().map((e) => e.payload), [{ points: 2 }])

const snap = live.snapshot({ pendingEvents: true })
assert.deepEqual(snap.pendingEvents, [{ event: 'PeGoal', payload: { points: 2 } }])
assert.equal(live.snapshot().pendingEvents, undefined) // default: not recorded

const fork = build()
fork.restore(snap)
live.stepOnce()
fork.stepOnce()
const strict = (w: World) => hashSnapshot(w.snapshot({ pendingEvents: true }), { includeChanges: true })
assert.equal(strict(fork), strict(live)) // both delivered the Goal
```

### Time

```ts
interface TimeState {
  tick:             number   // integer, monotonic
  elapsed:          number   // seconds since start
  delta:            number   // seconds this tick
  scaledDelta:      number   // ms-quantized; per-tick rounded from the
                             // engine's unquantized cumulative scaled-time
                             // total (drift-free). See SPEC §2.7.
  scale:            number   // 0 = paused
  fixedStep:        number   // seconds per fixed tick; the fixed-step driver
                             // advances against the unquantized cumulative
                             // total, so an N-Hz system fires exactly N
                             // times per N*fixedStep seconds at any
                             // fixedStep — including 1/60.
  fixedAccumulator: number   // remainder of unquantized scaled time
}
```

### Snapshot

```ts
// SNAPSHOT_VERSION === 3. v2 added `resources` (SPEC §2.11); v3 (2.1) added
// `rngRoot`, `rngStreams` and `pendingEvents`. Every 2.1 snapshot is v3 (2.0
// engines reject it); restore() accepts any version <= 3. @domecs/persist
// ships built-in 1→2 and 2→3 migrations so v1 and v2 saves load transparently.
const SNAPSHOT_VERSION = 3

interface WorldSnapshot {
  readonly version:  number
  readonly seed:     readonly [number, number, number, number]   // shared stream (world.rand)
  // The root seed own streams derive from (the createWorld seed); never
  // advances. Written by every 2.1 snapshot; restore() adopts it (absent in
  // a v2 snapshot → the world's own createWorld root). (v3)
  readonly rngRoot?: RngState
  // Every own stream the world has created, by key (rng: 'own' systems;
  // entries outlive their systems). Omitted while there is none; an explicit
  // undefined counts as absent (the reseed recipe). (v3)
  readonly rngStreams?: Readonly<Record<string, RngState>> | undefined
  readonly tick:     number
  // Cumulative unquantized scaled seconds. restore() re-derives time.elapsed,
  // the fixed-step count, and fixedAccumulator from it, so fixed systems keep
  // the live cadence (O-40). Absent in older snapshots → clock starts at 0.
  readonly scaledTime?: number
  // Fixed steps due but not yet run (a tickStart hook paused after time
  // advanced); omitted when 0. restore() keeps them owed (O-40).
  readonly fixedBacklog?: number
  // The fixedStep the backlog is counted in; present with it. A world
  // restored with another fixedStep re-counts the owed time in its own steps.
  readonly fixedStep?: number
  readonly entities: ReadonlyArray<{
    id:         Entity
    components: Record<string, unknown>
  }>
  // Entity-id cursor; restore() resumes id assignment from it (O-38).
  readonly nextId?: number
  // name → deep-cloned value. Omitted entirely when no resource has a value.
  // restore() clears live resources first, so an absent map falls back to
  // resource defaults. (v2+)
  readonly resources?: Record<string, unknown>
  // Change marks some system had not seen yet, in the order they were made,
  // and how many of them each such system had seen (O-42). restore()
  // re-issues them so those systems report them at their next run. Omitted
  // when every system has seen every mark.
  readonly changes?: ChangesSnapshot
  // Undelivered events in bus order, as plain-data copies (O-90). Present
  // only with snapshot({ pendingEvents: true }) and something in flight.
  // `payload` is absent for an undefined payload (a void event).
  readonly pendingEvents?: ReadonlyArray<SnapshotPendingEvent>
  readonly meta?: Record<string, unknown>
}

interface SnapshotPendingEvent {
  readonly event: string        // the event type's name (resolved with lookupEvent)
  readonly payload?: JsonValue
}

// The initial state of own stream `key` under `root` (SPEC §2.8): FNV-1a-32 of
// "domecs:stream:" + key, splitmix32 per root word, 8 warm-up draws. Pinned by
// a golden test; part of the snapshot contract.
function deriveStream(root: RngState, key: string): RngState

interface ChangesSnapshot {
  readonly marks: ReadonlyArray<
    | readonly ['added' | 'changed' | 'removed', string, Entity]  // kind, component, entity
    | readonly ['resource', string]                               // resource name
  >
  readonly seen: Readonly<Record<string, number>>  // system name → marks already seen
}

interface SnapshotOptions {
  // Drop entities whose serializable bag is empty once transient components
  // are excluded. Default false (every alive entity is recorded).
  readonly pruneEmptyEntities?: boolean
  // Record undelivered events in `pendingEvents`. Default false (2.0
  // behaviour: restore abandons the queue). Forks, keyframes and checkpoints
  // opt in.
  readonly pendingEvents?: boolean
}
```

### Per-system RNG streams

`world.rand` is one shared stream, so one random-drawing system changes
every other system's draws. A system registered with `rng: 'own'` gets its
own stream as `ctx.rand` (SPEC §2.8, O-77): keyed by its cursor key (rules:
`rule:<name>`), derived from the world's root seed with `deriveStream`, kept
when the system is removed (re-registering resumes it) and carried in the
snapshot (`rngStreams`; `rngRoot` is in every snapshot). A restored world
re-derives, from the restored root, the stream of every own-stream system the
snapshot has no entry for. Reseeding a snapshot is data-only:
`{ ...snap, seed: s, rngRoot: s, rngStreams: undefined }`.

```ts doctest name=rng-own-streams
import { strict as assert } from 'node:assert'
import { createWorld, createRng, defineComponent, deriveStream, entry, seedToState, type World } from '@domecs/core'

const Roll = defineComponent<{ v: number }>('RsRoll', { defaults: { v: 0 } })

function build(withNoise: boolean): { w: World; id: number } {
  const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
  const id = w.spawn([entry(Roll, { v: 0 })])
  if (withNoise) w.system('noise', { rng: 'own' }, (ctx) => void ctx.rand.uniform())
  w.system('roll', { rng: 'own' }, (ctx) => {
    w.getComponent(id, Roll)!.v = ctx.rand.uniform()
    w.markChanged(id, Roll)
  })
  return { w, id }
}

const a = build(true)
const b = build(false)
for (let i = 0; i < 3; i++) {
  a.w.stepOnce()
  b.w.stepOnce()
}
// 'roll' draws the same values whether or not 'noise' exists
assert.equal(a.w.getComponent(a.id, Roll)!.v, b.w.getComponent(b.id, Roll)!.v)
const stream = createRng(deriveStream(seedToState([1, 2, 3, 4]), 'roll'))
stream.uniform()
stream.uniform()
assert.equal(b.w.getComponent(b.id, Roll)!.v, stream.uniform())

const snap = a.w.snapshot()
assert.equal(snap.version, 3)
assert.deepEqual(Object.keys(snap.rngStreams!), ['noise', 'roll'])
assert.deepEqual(snap.rngRoot, seedToState([1, 2, 3, 4]))
assert.equal(a.w.describe().systems.find((s) => s.name === 'roll')!.rng, 'own')
```

### Determinism tools

Equality between worlds is by **canonical hash** (O-11; SPEC §7.1
"Canonical form", §8). `JSON.stringify(snapshot())` is not an equality test:
component key order follows archetype insertion order, and it writes `-0` as
`0`.

```ts
/** Canonical JSON of plain data: sorted keys (UTF-16 code unit), JSON value
 *  semantics, `-0` written as `-0`. NaN/±Infinity, BigInt and cycles throw
 *  TypeError naming the path ("entities[3].components.Body.vx"). */
function canonicalJson(value: unknown): string

interface CanonicalOptions {
  readonly includeChanges?: boolean  // add `changes` (strict restore-equivalence key)
  readonly includeMeta?: boolean     // add `meta`
}
/** Canonical JSON of the simulation state: every top-level field except
 *  `version`, `meta` and `changes` (unless the options add them). */
function canonicalSnapshot(snap: WorldSnapshot, options?: CanonicalOptions): string
/** FNV-1a-64 of canonicalSnapshot's UTF-8 bytes: 16 lowercase hex chars. */
function hashSnapshot(snap: WorldSnapshot, options?: CanonicalOptions): string
/** Entity id (ascending) → hash of that record's canonical `components`. */
function hashEntities(snap: WorldSnapshot): Map<Entity, string>
/** FNV-1a-64 of canonicalJson(value) — metric results, act logs, doc versions. */
function hashValue(value: unknown): string
const HASH_ALGORITHM: 'fnv1a64'
```

- **Strict vs default.** Every restore-equivalence check — fork vs live,
  checkpoints, keyframe verification — uses
  `hashSnapshot(snap, { includeChanges: true })`: `changes` decides what
  change-gated systems do next. The default hash (no `changes`) is for cache
  keys and UI.
- **Keyframes.** Serialize with `canonicalJson`, not `JSON.stringify`, so a
  `-0` survives the round trip; `JSON.parse(canonicalJson(snap))` restores
  to a world that continues exactly like one restored from `snap`.
  `@domecs/persist` `save()` still writes `JSON.stringify` (follow-up).
- The hash is not cryptographic. All five functions are pure and identical
  across runs and JS engines.

```ts doctest name=determinism-hash
import { strict as assert } from 'node:assert'
import {
  canonicalJson,
  createWorld,
  defineComponent,
  entry,
  hashEntities,
  hashSnapshot,
  type World,
  type WorldSnapshot,
} from '@domecs/core'

const Pos = defineComponent<{ x: number }>('DtPos', { defaults: { x: 0 } })
const Vel = defineComponent<{ vx: number }>('DtVel', { defaults: { vx: 0 } })

function build(): World {
  const w = createWorld({ headless: true, seed: [1, 2, 3, 4], fixedStep: 1 / 60 })
  w.system('move', { schedule: 'fixed', query: [Pos, Vel] }, ({ entities }) => {
    for (const e of entities) {
      const p = w.getComponent(e.id, Pos)!
      const v = w.getComponent(e.id, Vel)!
      p.x += v.vx
      if (p.x > 5 || p.x < -5) v.vx = -v.vx
      w.markChanged(e.id, Pos)
    }
  })
  return w
}

// Same state, different component-add order: JSON.stringify differs, the hash does not.
const a = build()
a.addComponent(a.spawn([entry(Pos, { x: 0 })]), Vel, { vx: 1 })
const b = build()
b.addComponent(b.spawn([entry(Vel, { vx: 1 })]), Pos, { x: 0 })
assert.notEqual(JSON.stringify(a.snapshot()), JSON.stringify(b.snapshot()))
assert.equal(hashSnapshot(a.snapshot()), hashSnapshot(b.snapshot()))

// Fork from a canonical keyframe; compare strict hashes while both run.
const keyframe = canonicalJson(a.snapshot())
const fork = build()
fork.restore(JSON.parse(keyframe) as WorldSnapshot)
for (let i = 0; i < 120; i++) {
  a.step(1 / 60)
  fork.step(1 / 60)
}
const strict = { includeChanges: true }
assert.equal(hashSnapshot(fork.snapshot(), strict), hashSnapshot(a.snapshot(), strict))

// hashEntities points at the entity that diverged.
const [id] = fork.listEntities([Pos])
fork.getComponent(id!, Pos)!.x += 0.5
fork.markChanged(id!, Pos)
const live = hashEntities(a.snapshot())
const forked = hashEntities(fork.snapshot())
assert.deepEqual([...live.keys()].filter((e) => live.get(e) !== forked.get(e)), [id])

// -0 survives canonicalJson; JSON.stringify drops the sign.
assert.equal(canonicalJson({ vx: -0 }), '{"vx":-0}')
assert.equal(JSON.stringify({ vx: -0 }), '{"vx":0}')
```

### Deterministic math

`Math.sin` and `Math.cos` are implementation-approximated under ECMA-262, and
engine builds disagree by up to 1 ulp (O-75; SPEC §8). `dmath` returns the
same bits on every engine: `sin` and `cos` are a straight-line port of musl
libm (generic C, non-FMA, < 1 ulp from the true result; ±0, ±∞, NaN and
subnormals per C99 Annex F; huge arguments reduced exactly). `sqrt` is
`Math.sqrt`, which IEEE-754 already makes correctly rounded. From 2.2,
`atan2` and `hypot` are musl ports too (< 1 ulp; specials as C99 Annex F,
which `Math.atan2` and two-argument `Math.hypot` share), and `pow` is a port
of fdlibm `e_pow.c` whose special values are ECMAScript `**`'s:
`(±1) ** ±Infinity` and `1 ** NaN` are `NaN` (C99 says 1). `pow` is < 1 ulp
except where fdlibm itself is weak — `|1 - x| <= 2^-20` with `|y| > 2^31`,
relative error up to about 2^-43 (the same bits as fdlibm's C, as Java's
`StrictMath.pow`).

```ts
const dmath: Readonly<{
  sin(x: number): number
  cos(x: number): number
  sqrt(x: number): number   // = Math.sqrt
  atan2(y: number, x: number): number   // 2.2
  hypot(x: number, y: number): number   // 2.2 (two arguments)
  pow(x: number, y: number): number     // 2.2
}>
```

- Authoritative systems call `dmath.sin`/`dmath.cos`, never `Math.sin`/
  `Math.cos` (or any other platform transcendental). The arithmetic
  operators, `Math.sqrt`, `Math.floor`, `Math.round`, `Math.abs`,
  `Math.min` and `Math.max` are exact and need no wrapper.
- `@domecs/rules` evaluates `sin()`/`cos()` with `dmath`, and from 2.2
  `atan2()`/`hypot()`/`pow()`, so rule outputs are bit-reproducible with no
  author action.
- `tan`, `atan`, `exp` and `log` are added on demand.

```ts doctest name=deterministic-math
import { strict as assert } from 'node:assert'
import { createWorld, defineComponent, dmath, entry, hashSnapshot } from '@domecs/core'

const Orbit = defineComponent<{ angle: number; x: number; y: number }>('DmOrbit', {
  defaults: { angle: 0, x: 0, y: 0 },
})

function run(): string {
  const w = createWorld({ headless: true, seed: [1, 2, 3, 4], fixedStep: 1 / 60 })
  w.system('orbit', { schedule: 'fixed', query: [Orbit] }, ({ entities }) => {
    for (const e of entities) {
      const o = w.getComponent(e.id, Orbit)!
      o.angle += 0.05
      o.x = 10 * dmath.cos(o.angle) // not Math.cos: identical bits in Node, Electron, browsers
      o.y = 10 * dmath.sin(o.angle)
      w.markChanged(e.id, Orbit)
    }
  })
  w.spawn([entry(Orbit, { angle: 0, x: 10, y: 0 })])
  for (let i = 0; i < 600; i++) w.step(1 / 60)
  return hashSnapshot(w.snapshot(), { includeChanges: true })
}

assert.equal(run(), run())
assert.equal(dmath.sin(Math.PI / 2), 1)
assert.equal(dmath.cos(Math.PI), -1)
assert.ok(Object.is(dmath.sin(-0), -0))
assert.equal(dmath.sqrt(2), Math.sqrt(2))
assert.equal(dmath.atan2(1, 1), Math.PI / 4)
assert.equal(dmath.hypot(3, 4), 5)
assert.equal(dmath.pow(2, 10), 1024)
assert.ok(Number.isNaN(dmath.pow(1, Infinity))) // as 1 ** Infinity
```

### Spatial grid

`createSpatialGrid(cellSize)` is a pure, world-free uniform grid over 2D
points keyed by entity id (2.2; O-8; SPEC §2.12). Results equal a
brute-force scan and never depend on `cellSize`, insertion order or cell
order: cell size is a performance setting only. The grid is derived state
and never enters a snapshot. For an index bound to a world's position
component, use `createSpatialHash` from `@domecs/scene`.

```ts
function createSpatialGrid(cellSize: number): SpatialGrid   // RangeError unless finite and > 0

interface SpatialGrid {
  readonly cellSize: number
  readonly size: number
  clear(): void
  set(id: Entity, x: number, y: number): void   // insert or move; non-finite → not indexed (id removed)
  delete(id: Entity): void
  position(id: Entity): { readonly x: number; readonly y: number } | undefined
  within(x: number, y: number, r: number, accept?: (id: Entity) => boolean): Entity[]   // distance² <= r², ascending id
  nearest(x: number, y: number, options?: { maxDistance?: number; accept?: (id: Entity) => boolean }): Entity | undefined   // ties → lowest id
  pairs(r: number, accept?: (a: Entity, b: Entity) => boolean): Array<[Entity, Entity]>   // a < b, sorted by (a, b)
}
```

- Distance is `dx * dx + dy * dy` (`dx = px - x`) compared with `r * r`
  (`maxDistance * maxDistance`), inclusive. A negative or NaN radius matches
  nothing.
- `accept` should be pure. `within` and `pairs` call it in output order on
  the matches; `nearest` may call it in any order, any number of times.
- `nearest` expands rings of cells and stops on a conservative bound, so
  rounding can only make it visit more cells. A query far from every point
  (or a radius much larger than the cell size) falls back to a scan.
- Pick a cell size near the typical query radius; about one point per cell
  is a good start.

```ts doctest name=spatial-grid
import { strict as assert } from 'node:assert'
import { createSpatialGrid } from '@domecs/core'

const points: Array<[number, number, number]> = [
  [1, 0, 0],
  [2, 3, 4],
  [3, -3, 4],
  [4, 1, 0],
  [5, 100, 100],
]
const results = [0.5, 2, 64].map((cellSize) => {
  const grid = createSpatialGrid(cellSize)
  for (const [id, x, y] of points) grid.set(id, x, y)
  grid.set(6, Number.NaN, 0) // not indexed
  return JSON.stringify([
    grid.size,
    grid.within(0, 0, 5),                     // [1, 2, 3, 4]: distance 5 is inclusive
    grid.within(0, 0, 5, (id) => id % 2 === 0), // [2, 4]
    grid.nearest(0, 4),                       // 2 and 3 tie at distance 3 → lowest id
    grid.nearest(0, 0, { accept: (id) => id !== 1 }),
    grid.nearest(50, 50, { maxDistance: 10 }),
    grid.pairs(5),
  ])
})
// the cell size never changes a result
assert.equal(new Set(results).size, 1)
assert.equal(
  results[0],
  JSON.stringify([5, [1, 2, 3, 4], [2, 4], 2, 4, undefined, [[1, 2], [1, 3], [1, 4], [2, 4]]]),
)
```

### Build identity

Every package exports `BUILD_ID: string` (ED-15). It is `'dev'` in source and
workspace builds; `scripts/pack-for-studio.mjs` stamps the packed
`dist/build-id.js` with `'<version>+g<sha7>[-dirty]'`; a published build
carries the plain version. Hosts record it next to their runtime identity, so
two packs of the same version stay distinguishable.

```ts
import { BUILD_ID } from '@domecs/core'   // also @domecs/dom, input, inspector, persist, rules, scene
```

### Plugin

```ts
interface Plugin<O = void> {
  readonly name:      string
  readonly version?:  string               // informational; surfaced in diagnostics
  readonly depends?:  readonly string[]
  readonly provides?: readonly string[]
  // `install` participates in the Result contract (BETTER_ERRORS Phase 1):
  // success carries an optional PluginHandle, failure a DomecsError that the
  // registry quarantines (provided capabilities are unwound, world keeps
  // running). A throw is normalized to { kind: 'plugin_install_failed', … }.
  install(world: World, options: O): Result<PluginHandle | void, DomecsError>
}

// O-57: heartbeat is true on a step(dt <= 0) heartbeat (SPEC §4.0): hooks
// and render run, no system does — publish one-tick data, don't consume it.
interface TickInfo { readonly heartbeat: boolean }

interface PluginHandle {
  teardown?:    () => void
  onTickStart?: (world: World, info: TickInfo) => void
  onTickEnd?:   (world: World, info: TickInfo) => void
  onRender?:    (world: World, info: TickInfo) => void
  onSnapshot?:  (snap: WorldSnapshot) => WorldSnapshot
  onRestore?:   (snap: WorldSnapshot) => WorldSnapshot
}

// Preferred authoring path. `install` may return a bare PluginHandle, void,
// or a Result; definePlugin auto-wraps bare/void in ok() and passes an
// explicit Result through. Writing plugins this way keeps a bare-handle
// return valid without hand-rolling ok()/err().
interface PluginSpec<O = void> {
  readonly name:      string
  readonly version?:  string
  readonly depends?:  readonly string[]
  readonly provides?: readonly string[]
  install(world: World, options: O):
    PluginHandle | void | Result<PluginHandle | void, DomecsError>
}
function definePlugin<O = void>(spec: PluginSpec<O>): Plugin<O>

interface Capability<K extends string> {
  readonly name: K
  // each provider augments this interface with its capability surface
}
```

**Capability surface convention (worked example).** `Capability<K>` is a marker; the provider exposes methods by **declaration merging** (TypeScript module augmentation) against the `Capability<K>` for its key. This keeps capability surfaces strongly typed at the consumer without a runtime registry of method signatures.

```ts
// ── in @domecs/physics ──────────────────────────────────────────────
declare module '@domecs/core' {
  interface Capability<K> {
    // only augments the K = 'spatial-index' instantiation
    query: K extends 'spatial-index'
      ? (bounds: { x: number; y: number; w: number; h: number }) => Entity[]
      : never
    nearest: K extends 'spatial-index'
      ? (x: number, y: number, radius: number) => Entity[]
      : never
  }
}

export const physicsPlugin = definePlugin({
  name: '@domecs/physics',
  provides: ['spatial-index'],
  install(world) {
    const index = new Quadtree(/* ... */)
    const cap = world.capability('spatial-index')
    ;(cap as any).query   = (b) => index.query(b)
    ;(cap as any).nearest = (x, y, r) => index.nearest(x, y, r)
    // No explicit Result needed — definePlugin wraps the void return as ok().
  },
})

// ── in consumer code (e.g., @domecs/pathfinding) ────────────────────
const hits = world.capability('spatial-index').query({ x: 0, y: 0, w: 64, h: 64 })
//    ^? Entity[]  — the augmentation makes this fully typed
```

Rules: (1) one provider per capability name — `provides: ['spatial-index']` from two plugins is a registration error (§9.3). (2) Consumers list the key in `depends` and should not call `capability(name)` at `install` time before the provider has run; the plugin DAG (§9.2) guarantees provider order when `depends` is declared. (3) The augmentation lives in the provider package, not in application code — third-party capabilities stay self-contained.

**Result-based error handling.** `world.use` returns a `Result`: a plugin that
installs cleanly yields `Ok`, while a plugin whose `install` throws is
quarantined and surfaced as an `Err` carrying a `DomecsError` you can hand to
`describeError` for a human-readable, fix-oriented message. (A duplicate plugin
*name* is a programmer error and throws — it is not an `Err`.)

```ts doctest name=result-error-handling
import { strict as assert } from 'node:assert'
import { createWorld, definePlugin, describeError, isErr, isOk } from '@domecs/core'

const w = createWorld()

// Happy path: a plugin that installs cleanly → Ok.
const good = definePlugin({ name: 'good', install: () => {} })
assert.ok(isOk(w.use(good)))

// Error path: a plugin whose install throws → use() returns an Err carrying a
// DomecsError you can describe for a human-readable, fix-oriented message.
const bad = definePlugin({
  name: 'bad',
  install: () => {
    throw new Error('boom')
  },
})
const result = w.use(bad)
assert.ok(isErr(result))
if (isErr(result)) {
  const described = describeError(result.error)
  assert.equal(typeof described, 'string')
  assert.ok(described.length > 0)
}
```

### Agent bridge (WS-3)

Thin facade over `World` — no new runtime semantics. One control loop
(`reset → observe → act → step → snapshot`) shared by agents and UIs.

```ts
function createAgentBridge(world: World, opts?: AgentBridgeOptions): AgentBridge

interface AgentBridgeOptions {
  // Snapshot used by reset(). Omitted → captured from `world` at
  // construction time (after any setup the caller already performed).
  baseline?: WorldSnapshot
}

interface AgentObservation {
  readonly tick:        number
  readonly scale:       number
  readonly entityCount: number
  readonly manifest:    WorldManifest   // = world.describe()
}

interface AgentBridge {
  readonly world: World                // escape hatch for setup/queries
  reset(): void                        // restore baseline (see notes below)
  captureBaseline(): void              // re-capture baseline from current state
  observe(): AgentObservation
  act<T>(type: EventType<T>, payload: T, opts?: ActionOptions): ActionResult
  // Name-based act for JSON callers (MCP, HTTP, act logs): resolves through
  // world.lookupEvent, then exactly like act(type, …).
  act(name: string, payload: unknown, opts?: ActionOptions): ActionResult
  step(dt?: number): void              // omit dt → stepOnce; positive dt → step(dt)
  snapshot(options?: SnapshotOptions): WorldSnapshot
}
```

Notes:
- `reset()` does **not** restore `time.scale` or input state (the snapshot
  does not carry them); restore those explicitly at episode boundaries if
  episodes touch either. Entity-id assignment is stable across `reset()`
  (the snapshot carries the id cursor, O-38) and pending events from the
  abandoned episode are discarded by `restore()` (the baseline is a
  default snapshot, which carries no pending events).
- `step(0)` / negative dt is the F-6 heartbeat (no systems run), not the
  same as `step()` — guard computed dt values that can round to 0.
- `act()` validates the payload when the event declares a `schema`
  (unknown fields / wrong-typed fields / out-of-enum values →
  `{ accepted: false, reason }`, no tick consumed). Schema-less events are
  unvalidated — declare schemas on agent-facing commands (O-39).
- `act(name, …)` resolves the name through `world.lookupEvent`. An unknown
  name, or one two distinct known event types share, returns
  `{ accepted: false, consumedTurn: false, reason, events: [] }` with no emit
  and no tick. `world.register` the command events at setup so they resolve
  before anything emits them.

```ts doctest name=agent-act-by-name
import { strict as assert } from 'node:assert'
import { createAgentBridge, createWorld, defineComponent, defineEvent, entry } from '@domecs/core'

const Health = defineComponent<{ hp: number }>('Health', { defaults: { hp: 10 } })
const Damage = defineEvent<{ amount: number }>('Damage', {
  description: 'Remove hit points from the player',
  schema: { fields: { amount: { kind: 'number', description: 'HP to remove' } } },
})

const world = createWorld({ headless: true, seed: [1, 2, 3, 4] })
const id = world.spawn([entry(Health, { hp: 10 })])
world.system('damage', { schedule: 'event', triggers: [Damage], meta: { owner: 'combat' } }, (ctx) => {
  for (const d of ctx.events.of(Damage)) {
    ctx.world.getComponent(id, Health)!.hp -= d.amount
    ctx.world.markChanged(id, Health)
  }
})
assert.equal(world.register(Damage).ok, true)       // asserts the name is unique
assert.equal(world.lookupEvent('Damage'), Damage)
assert.deepEqual(world.eventTypes().map((t) => t.name), ['Damage'])
assert.equal(world.describeEvent(Damage).description, 'Remove hit points from the player')
const sys = world.describe().systems.find((s) => s.name === 'damage')!
assert.deepEqual(sys.meta, { owner: 'combat' })
assert.deepEqual(sys.components, [])

const bridge = createAgentBridge(world)
assert.equal(bridge.act('Damage', { amount: 3 }).accepted, true)
assert.equal(world.getComponent(id, Health)!.hp, 7)
// Schema rejection works the same through the name path (O-39).
assert.equal(bridge.act('Damage', { amout: 3 }).accepted, false)
// Unknown name: rejected, no tick.
const tick = world.time.tick
const miss = bridge.act('Damag', { amount: 3 })
assert.equal(miss.accepted, false)
assert.equal(miss.consumedTurn, false)
assert.equal(world.time.tick, tick)
// A second, distinct "Damage" type cannot register under the taken name.
const r = world.register(defineEvent('Damage'))
assert.deepEqual(r, { ok: false, error: { kind: 'name_conflict', registry: 'event', name: 'Damage' } })
```

### Act logs and replay

A recorder writes down what entered a world from outside — commands, the dt
and scale of every step, the input systems saw — so a fresh world built by the
same setup and restored from the same base replays to the same strict hashes
(harness spec §7.1, SPEC §7.5). The log is plain JSON; store it with
`canonicalJson` so a `-0` in a payload keeps its sign.

```ts
function createRecorder(world: World, options?: { readonly hashEvery?: number }): Recorder
function replay(world: World, log: ActLog, options?: ReplayOptions):
  Result<{ readonly ticks: number; readonly hash: string }, ReplayError>
function encodeInput(input: InputSnapshot): JsonInput   // Sets -> sorted arrays
function decodeInput(json: JsonInput): InputSnapshot

interface Recorder {
  readonly active: boolean
  peek(): ActLog                 // the log so far (a copy)
  stop(): ActLog                 // stop recording; later calls return the same log
}

interface ActLog {
  readonly format: 'domecs-actlog'
  readonly version: 1
  readonly startTick: number
  readonly fixedStep: number
  readonly startScale: number    // time.scale when recording started
  readonly resumeScale?: number  // startScale 0 only: the scale resume() returned to
  readonly baseHash: string      // strict hash (pendingEvents included) at start
  readonly frames: readonly ActLogFrame[]
  readonly checkpoints?: ReadonlyArray<{ tick: number; hash: string }>   // hashEvery
  readonly gaps?: ReadonlyArray<{ tick: number; reason: ActLogGapReason }>
}
interface ActLogFrame {          // one stepOnce() or step(dt > 0); heartbeats are not frames
  readonly tick: number          // time.tick before the step
  readonly dt: number | null     // null = stepOnce()
  readonly scale?: number        // entry scale, when it changed since the previous frame ended
  readonly hookScale?: number    // scale a tickStart hook set during this step
  readonly acts?: readonly ActRecord[]       // emitted before the step's event flush
  readonly startActs?: readonly ActRecord[]  // emitted by signals.tickStart subscribers this step
  readonly endActs?: readonly ActRecord[]    // emitted after the systems (render, onTickEnd, tickEnd)
  readonly input?: JsonInput     // when it changed (always on the first frame)
}
interface ActRecord {
  readonly event: string         // replay resolves it with world.lookupEvent
  readonly payload?: JsonValue   // absent for an undefined payload
  readonly via: 'emit' | 'action'  // only 'action' acts are schema-checked on replay
}
type ActLogGapReason = 'out_of_tick_mutation' | 'unserializable_payload' | 'restore'

interface ReplayOptions {
  readonly base?: WorldSnapshot  // restore first (take it with { pendingEvents: true })
  readonly toTick?: number       // stop after the frame that ends at this tick
  readonly verify?: boolean      // compare checkpoints (default true)
  readonly onFrame?: (tick: number, world: World) => void
}
type ReplayError =
  | { kind: 'invalid_log'; reason: string }
  | { kind: 'base_mismatch'; expected: string; actual: string }
  | { kind: 'unknown_event'; event: string; tick: number }
  | { kind: 'rejected_payload'; event: string; tick: number; reason: string }
  | { kind: 'diverged'; tick: number; expected: string; actual: string }
```

What is recorded:
- **Acts:** every emit not made by a system or an `on` handler —
  `world.emit`, `turn`, `action` (`via: 'action'`), and emits from plugin
  hooks and signal subscribers, heartbeats included — in emit order: into
  the next frame's `acts`, or, when made during a step after its event
  flush, into that frame's `startActs` (`signals.tickStart`) or `endActs`
  (render, `onTickEnd`, `signals.tickEnd`), which replay emits at the same
  points. Emits from systems and handlers are reproduced by replay. Acts
  emitted after the last step are not in the log.
- **Frames:** per full step, the caller's dt (so wall-clock `step(dt)`
  replays exactly), the scale on entry, a scale a `tickStart` hook set, and
  `world.input` as the step's systems see it (after plugin `onTickStart` and
  `signals.tickStart`), delta-encoded.
- **Gaps:** a spawn/despawn/add/remove/`markChanged`/`setResource`/
  `markResourceChanged` outside a full tick, a draw on `world.rand` between
  steps, a payload that is not plain data, and `restore()`. Replay past a gap is unverified: the next
  checkpoint reports `diverged`. Route every runtime change through a
  command.

Replay restores `base`, sets `startScale` (and, for a paused start, the
scale `resume()` returns to), checks `baseHash`, then per frame
resolves the acts (an unknown or ambiguous name → `unknown_event`, an
`'action'` payload failing its schema → `rejected_payload`, both before any
emit), sets scale and input, emits, and steps. A malformed log, or one
recorded at another `fixedStep`, is `invalid_log`; nothing throws for a bad
log. The replay world must have the same setup minus every stimulus source
(no input plugin, no hook or subscriber that emits, none that sets the scale
at tick start: their effects are in the log) and no `once` system the source had already run.

```ts doctest name=act-log-replay
import { strict as assert } from 'node:assert'
import {
  createRecorder,
  createWorld,
  decodeInput,
  defineComponent,
  defineEvent,
  entry,
  hashSnapshot,
  replay,
  type ActLog,
  type World,
} from '@domecs/core'

const Pos = defineComponent<{ x: number }>('ArPos', { defaults: { x: 0 } })
const Push = defineEvent<{ dx: number }>('ArPush', { schema: { fields: { dx: { kind: 'number' } } } })

// One setup for the recording world and every replay world.
function build(): World {
  const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
  w.register(Push) // replay resolves acts by name
  w.system('push', { schedule: 'event', triggers: [Push] }, (ctx) => {
    for (const id of ctx.world.listEntities([Pos])) {
      for (const p of ctx.events.of(Push)) ctx.world.getComponent(id, Pos)!.x += p.dx
      ctx.world.markChanged(id, Pos)
    }
  })
  w.system('drift', { query: [Pos] }, (ctx) => {
    for (const e of ctx.entities) {
      e.ArPos!.x += ctx.time.scaledDelta + (ctx.input.keys.has('ArrowRight') ? 1 : 0)
      ctx.world.markChanged(e.id, Pos)
    }
  })
  return w
}
const strict = (w: World) => hashSnapshot(w.snapshot({ pendingEvents: true }), { includeChanges: true })

const live = build()
const id = live.spawn([entry(Pos, { x: 0 })])
const base = live.snapshot({ pendingEvents: true })
const rec = createRecorder(live, { hashEvery: 2 })
live.action(Push, { dx: 5 })                            // recorded via 'action'
live.step(0.016)                                        // a wall-clock dt is recorded as-is
live.setInput(decodeInput({ keys: ['ArrowRight'] }))
live.step(0.021)
live.emit(Push, { dx: -2 })                             // recorded via 'emit'
live.stepOnce()
const log: ActLog = rec.stop()
assert.equal(log.frames.length, 4)
assert.deepEqual(log.frames[0]!.acts, [{ event: 'ArPush', payload: { dx: 5 }, via: 'action' }])
assert.deepEqual(log.frames[2]!.input, { keys: ['ArrowRight'] })
assert.equal(log.gaps, undefined)

// The log is plain JSON: replay the parsed copy on a fresh world.
const parsed = JSON.parse(JSON.stringify(log)) as ActLog
const r = replay(build(), parsed, { base })
if (!r.ok) throw new Error(r.error.kind)
assert.equal(r.value.ticks, 4)
assert.equal(r.value.hash, strict(live))

// A direct write is a gap; replay past it reports where it diverged.
const base2 = live.snapshot({ pendingEvents: true })
const rec2 = createRecorder(live, { hashEvery: 1 })
live.stepOnce()
live.getComponent(id, Pos)!.x = 100
live.markChanged(id, Pos)
live.stepOnce()
const log2 = rec2.stop()
assert.deepEqual(log2.gaps, [{ tick: 5, reason: 'out_of_tick_mutation' }])
const r2 = replay(build(), log2, { base: base2 })
assert.equal(r2.ok, false)
if (!r2.ok) assert.deepEqual([r2.error.kind, (r2.error as { tick: number }).tick], ['diverged', 6])

assert.equal(replay(build(), { ...log, version: 2 } as unknown as ActLog).ok, false) // invalid_log, no throw
```

---

## `@domecs/input`

```ts
function createInputPlugin(options?: InputPluginOptions): Plugin

interface InputPluginOptions {
  keyTarget?: Document | HTMLElement      // default: document when present
  pointerTarget?: Document | HTMLElement  // default: document when present
  wheelTarget?: Document | HTMLElement    // default: pointerTarget
  clearOnBlur?: boolean                   // default true
  textInputSelector?: string              // default 'input,textarea,[contenteditable="true"]'
  pollGamepads?: boolean                  // default true when navigator.getGamepads exists
  preventDefaultKeys?: boolean            // default false
}

interface InputSnapshot {
  readonly keys:       ReadonlySet<string>         // W3C KeyboardEvent.code
  readonly keyDelta:   { pressed: ReadonlySet<string>; released: ReadonlySet<string> }
  readonly mods:       Readonly<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }>
  readonly pointer:    PointerSnapshot
  readonly gamepads:   readonly GamepadSnapshot[]
  readonly focus:      { activeTag: string; consumesKeys: boolean }
}

interface PointerSnapshot {
  x: number; y: number        // raw DOM client coordinates in v1.0
  buttons: number
  delta: { x: number; y: number }
  wheel: number
  entered: readonly Entity[]   // reserved for future hit-tested enter tracking; empty in v1.0
}

interface GamepadSnapshot {
  index: number
  axes: readonly number[]
  buttons: readonly { pressed: boolean; value: number }[]
}
```

Importing `@domecs/input` is safe without browser globals. Installing
`createInputPlugin()` in Node registers no DOM listeners, skips gamepad polling,
and publishes empty snapshots on tick.

The defaults are exported as the frozen `DEFAULT_INPUT_OPTIONS` record;
caller options merge over them exactly as the plugin applies them:

```ts doctest name=input-defaults
import { strict as assert } from 'node:assert'
import { DEFAULT_INPUT_OPTIONS } from '@domecs/input'

// The static defaults are machine-readable.
assert.equal(DEFAULT_INPUT_OPTIONS.clearOnBlur, true)
assert.equal(DEFAULT_INPUT_OPTIONS.preventDefaultKeys, false)

// Overrides merge over the defaults the same way the plugin applies them.
const opts = { ...DEFAULT_INPUT_OPTIONS, preventDefaultKeys: true }
assert.equal(opts.preventDefaultKeys, true) // override wins
assert.equal(opts.clearOnBlur, true)        // untouched default survives
```

---

## `@domecs/dom`

```ts
// Returns a Result. A world can take several mounts on distinct slots
// (O-55); a slot already mounted is err slot_already_mounted.
function mountDOM(world: World, options: MountOptions): Result<MountHandle, MountError>

type MountError =
  | { kind: 'slot_already_mounted'; slot: string }
  | { kind: 'unregistered_slot'; slot: string }
  | { kind: 'plugin_install_failed'; reason: string }
  | { kind: 'invalid_view_query'; slot: string; reason: string }   // temporal node in a view query (O-52)
  | { kind: 'invalid_changed_on'; slot: string; reason: string }   // update with no redraw trigger (O-55)

interface MountOptions {
  readonly slots: Readonly<Record<string, HTMLElement>>   // e.g. { stage: el, hud: el, portal: document.body }
  readonly views: ReadonlyArray<ViewDef>
}

interface MountHandle {
  teardown(): void
}

// ViewDef carries optional typed `Fields` so tuple-form queries thread
// component value types through to `create` / `update` / `destroy`.
//
// `changedOn` semantics (SPEC §5.3 update-gating rule, P-3) — a
// discriminated union, NOT an array:
//   - omitted (default) or `{ mode: 'auto' }`: redraws are gated by
//     `OnChanged(T)` for every `Has(T)` and `Where(T, …)` leaf in `query`
//     not under a `Not`. A view over `[Position, Velocity]` auto-redraws
//     when either component is marked changed. A view with `update` and no
//     such leaf is err invalid_changed_on (O-55).
//   - `{ mode: 'legacy' }`: "redraw every tick". Useful for time-driven
//     animations where the view depends on `time.elapsed` rather than
//     component identity.
//   - `{ mode: 'explicit', types: [Type, ...] }`: explicit gate on exactly
//     those component types. Overrides the auto-derive. An empty list with
//     `update` is err invalid_changed_on.
//
// First paint (O-2): under `auto`/`explicit`, `update` also runs once for
// each newly created node in the commit that mounts it (fresh commit-time
// view; exactly one update even if the entity was also marked changed that
// window). Later commits stay change-gated. `create` gets the entity as it
// is at the commit, with components added since it matched (O-55).
type ChangedOn =
  | { readonly mode: 'auto' }
  | { readonly mode: 'legacy' }
  | { readonly mode: 'explicit'; readonly types: ReadonlyArray<ComponentType<unknown>> }

interface ViewDef<Fields = Record<string, unknown>> {
  slot:         string
  query:        QueryShorthand
  changedOn?:   ChangedOn
  create(entity: EntityView<Fields>): HTMLElement
  update?(el: HTMLElement, entity: EntityView<Fields>): void
  destroy?(el: HTMLElement, entity: EntityView<Fields>): void
}

// defineView has two overloads. The tuple-form `query` triggers typed
// callbacks via `FieldsFromComponents<T>`; combinator forms return the
// unconstrained shape.
function defineView<T extends readonly ComponentType<unknown, string>[]>(
  def: Omit<ViewDef<FieldsFromComponents<T>>, 'query'> & {
    readonly query: readonly [...T]
  },
): ViewDef<FieldsFromComponents<T>>
function defineView(def: ViewDef): ViewDef
```

Importing `@domecs/dom` is safe without browser globals. `mountDOM` requires
caller-provided slot elements for views; it never discovers `document` on
module load.

`ChangedOn` is a discriminated union with four authoring forms (omitting
`changedOn` is equivalent to `{ mode: 'auto' }`):

```ts doctest name=changedon-modes
import { strict as assert } from 'node:assert'
import type { ChangedOn } from '@domecs/dom'

// 1. Omitted — equivalent to { mode: 'auto' }.
const omitted: ChangedOn | undefined = undefined
assert.equal(omitted, undefined)

// 2. auto — derive OnChanged(T) from every Has(T) leaf in the view query.
const auto: ChangedOn = { mode: 'auto' }
assert.equal(auto.mode, 'auto')

// 3. legacy — redraw every mounted entity every tick.
const legacy: ChangedOn = { mode: 'legacy' }
assert.equal(legacy.mode, 'legacy')

// 4. explicit — gate redraws on exactly the listed component types.
const explicit: ChangedOn = { mode: 'explicit', types: [] }
assert.equal(explicit.mode, 'explicit')
assert.deepEqual(explicit.mode === 'explicit' ? explicit.types : null, [])
```

---

## `@domecs/persist`

There is no `createPersistence` facade — persistence is a set of
`Result`-typed free functions over a `Storage`. The free functions are the
one canonical path. Every operation returns a `Result<..., DomecsError>`;
`save`/`load` never throw on expected I/O or migration failures.

`Storage` is a slot-keyed text store; a missing slot reads as `ok(null)`,
not an error. `createMemoryStorage` ships an in-memory adapter;
`createLocalStorageStorage` ships a browser `localStorage` adapter that
namespaces slots under `prefix` (default `'domecs:'`), resolves the backing
store lazily from `globalThis` (safe to import in headless/Node hosts), and
maps missing-storage / privacy-mode / quota throws to `persist_io`.

```ts
interface Storage {
  read(slot: string):                Result<string | null, DomecsError>
  write(slot: string, data: string): Result<void, DomecsError>
  remove(slot: string):              Result<void, DomecsError>
  list():                            Result<readonly string[], DomecsError>
}

function createMemoryStorage(initial?: Readonly<Record<string, string>>): Storage
function createLocalStorageStorage(prefix?: string): Storage
```

**Save / load.** `save` captures `world.snapshot()`, stamps `meta.savedAt`,
serializes to JSON, and writes to `slot`. `load` reads `slot`, parses it,
migrates the envelope to `targetVersion` (default `SNAPSHOT_VERSION`, 2)
before calling `world.restore`.

```ts
function save(world: World, storage: Storage, slot: string, opts?: SaveOptions): Result<void, DomecsError>
function load(world: World, storage: Storage, slot: string, opts?: LoadOptions): Result<void, DomecsError>
// Boot-friendly: missing slot → ok(false); loaded → ok(true); real failures → err (O-28).
function loadIfPresent(world: World, storage: Storage, slot: string, opts?: LoadOptions): Result<boolean, DomecsError>

interface SaveOptions {
  meta?:    Record<string, unknown>   // merged into snapshot envelope meta (caller keys win)
  savedAt?: number                    // override stamped ms-epoch timestamp; default Date.now()
}

interface LoadOptions {
  targetVersion?: number    // default SNAPSHOT_VERSION (2)
  // Caller migration chain, overlaid on BUILTIN_MIGRATIONS (caller keys win).
  // Default = just the built-ins, so a legacy v1 save upgrades transparently.
  migrations?: MigrationMap
}

// Plugin: strips entities with an empty serializable component bag from every
// world.snapshot() envelope via onSnapshot — the declarative way to get
// pruneEmptyEntities on the persisted save() path. Install once per world.
// Runs on every snapshot(), history included; an entity others refer to by
// id (a scene Parent group) needs a persistent component of its own (O-61).
function pruneTransientOnlyEntities(): Plugin
```

**Migration.** A `Migration` is a single-step `N → N+1` transform; `migrate`
walks the chain to `targetVersion`. `BUILTIN_MIGRATIONS` is the framework
floor (the 1→2 resources bump, SPEC §7.1/§2.11); `withBuiltinMigrations`
overlays user steps on top (user keys win).

```ts
// A single-step migration: version N → N+1. Returning err halts the chain.
type Migration    = (snap: WorldSnapshot) => Result<WorldSnapshot, MigrationFailedError>
type MigrationMap = ReadonlyMap<number, Migration>   // keyed by source version

function migrate(snap: WorldSnapshot, targetVersion: number, migrations: MigrationMap): Result<WorldSnapshot, MigrationFailedError>

const BUILTIN_MIGRATIONS: MigrationMap
function withBuiltinMigrations(user?: MigrationMap): MigrationMap
```

**Snapshot history (undo/redo).** `createSnapshotHistory` is an in-memory
undo/redo ring over `WorldSnapshot`s; `diffSnapshots` diffs two snapshots —
entity-level by default, field-level with `{ fields: true }` — and
`firstDivergence` finds the first difference in canonical order.

```ts
function createSnapshotHistory(world: World, opts?: SnapshotHistoryOptions): SnapshotHistory

interface SnapshotHistoryOptions {
  limit?:          number    // max checkpoints retained (ring); default 50, must be >= 1
  captureInitial?: boolean   // snapshot current state as baseline at creation; default true
}

interface SnapshotHistory {
  push():   void                              // snapshot world, append as new current checkpoint
  undo():   boolean                           // restore previous; false at oldest
  redo():   boolean                           // restore next; false at newest
                                              // (a restore that throws puts the cursor back)
  canUndo(): boolean
  canRedo(): boolean
  clear():  void
  readonly length: number                     // checkpoints retained
  readonly index:  number                     // cursor; -1 when empty
  snapshots(): readonly WorldSnapshot[]        // oldest-first
  current():   WorldSnapshot | undefined
  toJSON():    string
  load(json: string): Result<void, DomecsError>
}

function diffSnapshots(prev: WorldSnapshot, next: WorldSnapshot, options?: SnapshotDiffOptions): SnapshotDiff

interface SnapshotDiffOptions {
  readonly fields?: boolean                 // report components/fields/resources; default false
  readonly components?: readonly string[]   // restrict field reporting to these components
  readonly epsilon?: number                 // numbers within epsilon are equal; default 0 (exact, -0 ≠ 0)
  readonly limit?: number                   // stop after this many field changes; default 10_000, Infinity = none
}

interface SnapshotDiff {
  readonly addedEntities:   readonly Entity[]
  readonly removedEntities: readonly Entity[]
  readonly changedEntities: readonly Entity[]  // compared as data: key order ignored
  // fields: true only ↓ (ascending entity id, sorted component name, sorted key)
  readonly componentsAdded?:   ReadonlyArray<{ entity: Entity; component: string }>
  readonly componentsRemoved?: ReadonlyArray<{ entity: Entity; component: string }>
  readonly fieldChanges?:      readonly FieldChange[]
  readonly resourceChanges?:   readonly ResourceChange[]  // a resource on one side only: path ""
  readonly truncated?:         boolean                    // limit cut reporting short
}

interface FieldChange {
  readonly entity: Entity
  readonly component: string
  readonly path: string                     // "x", "inv.items[2].qty", '["a-b"]'; "" = whole value
  readonly before: JsonValue | undefined    // undefined = absent
  readonly after:  JsonValue | undefined
}
interface ResourceChange { readonly resource: string; readonly path: string; readonly before: JsonValue | undefined; readonly after: JsonValue | undefined }

/** First difference: state (seed, tick, scaledTime, nextId, rngRoot, rngStreams,
 *  fixedBacklog, pendingEvents), then the lowest entity id, then resources. null when equal.
 *  version, meta and changes are not compared. */
function firstDivergence(a: WorldSnapshot, b: WorldSnapshot): Divergence | null

type Divergence =
  | { where: 'state'; key: 'seed' | 'tick' | 'scaledTime' | 'nextId' | 'rngRoot' | 'rngStreams' | 'fixedBacklog' | 'pendingEvents' }
  | { where: 'entity'; entity: Entity; change: 'added' | 'removed' | FieldChange }
  | { where: 'resource'; change: ResourceChange }
```

Arrays compare element-wise; a length change is reported as added (`before:
undefined`) or removed (`after: undefined`) tail elements. `changedEntities`
switched from `JSON.stringify` to data comparison in 2.1, so key-order-only
differences are no longer reported (**behaviour change**, narrowing).

```ts doctest name=diff-fields
import { strict as assert } from 'node:assert'
import { createWorld, defineComponent, entry } from '@domecs/core'
import { diffSnapshots, firstDivergence } from '@domecs/persist'

const Body = defineComponent<{ x: number; inv: number[] }>('DfBody', { defaults: { x: 0, inv: [] } })
const w = createWorld({ headless: true })
const a = w.spawn([entry(Body, { x: 1, inv: [1, 2] })])
const b = w.spawn([entry(Body, { x: 2, inv: [] })])
const before = w.snapshot()
w.getComponent(b, Body)!.x = 5
w.getComponent(b, Body)!.inv.push(9)
w.markChanged(b, Body)
const after = w.snapshot()

const d = diffSnapshots(before, after, { fields: true })
assert.deepEqual(d.changedEntities, [b])
assert.deepEqual(d.fieldChanges, [
  { entity: b, component: 'DfBody', path: 'inv[0]', before: undefined, after: 9 },
  { entity: b, component: 'DfBody', path: 'x', before: 2, after: 5 },
])
assert.deepEqual(firstDivergence(before, after), {
  where: 'entity',
  entity: b,
  change: { entity: b, component: 'DfBody', path: 'inv[0]', before: undefined, after: 9 },
})
assert.equal(firstDivergence(before, before), null)
assert.ok(a < b)
```

---

## `@domecs/inspector`

```ts
function createInspector(opts?: InspectorOptions): InspectorBundle

interface InspectorOptions {
  bufferSize?: number          // ring-buffer capacity for fault/state entries; default 1024
  recordStateChanges?: boolean // interleave component-change events into the timeline; default false
  timelineBufferSize?: number  // max timeline entries; defaults to bufferSize, only used when recordStateChanges is true
}

interface InspectorBundle {
  readonly plugin: Plugin<void>  // pass to world.use(...)
  readonly view:   InspectorView // live view; filter calls return immutable snapshot views
  clear(): void                  // drop all recorded entries (both buckets and the timeline)
}

// Immutable, filter-composable view. Each filter returns a fresh view backed by
// the captured snapshot — the live buffer keeps growing, a captured view stays put.
interface InspectorView {
  readonly entries:      readonly InspectorEntry[]
  readonly systemic:     readonly InspectorEntry[]  // entries with no entity (systemic faults)
  readonly entityScoped: readonly InspectorEntry[]  // entries carrying an entity
  readonly timeline:     readonly TimelineEvent[]   // empty unless recordStateChanges
  bySource(systemId: SystemId): InspectorView
  byKind(kind: string): InspectorView
  byTick(tick: number): InspectorView
  byTickRange(from: number, to: number): InspectorView
  recoverableOnly(): InspectorView
  onlyFaulted(): InspectorView                       // keep only entity-scoped entries
  hideFaulted(): InspectorView                       // keep only systemic entries
  entriesFor(entity: Entity): readonly InspectorEntry[]
  export(): InspectorSnapshot                        // point-in-time serializable copy
}

// One normalized record. Systemic and entity-scoped faults share this shape;
// `entity` discriminates (absent ⇒ systemic).
interface InspectorEntry {
  readonly kind:        string      // fault kind (e.g. 'event_handler_threw')
  readonly systemId:    SystemId
  readonly tick:        number
  readonly wallclock:   number      // Date.now() at capture
  readonly recoverable: boolean
  readonly entity?:     Entity       // absent ⇒ systemic fault
  readonly component?:  ComponentId
  readonly detail?:     JsonValue
}

type TimelineEventKind =
  | 'fault' | 'spawn' | 'despawn' | 'componentAdded' | 'componentRemoved'

// Replay-timeline event. Only recorded when recordStateChanges is true (faults
// are always recorded; structural events are interleaved when enabled).
interface TimelineEvent {
  readonly eventKind:  TimelineEventKind
  readonly tick:       number
  readonly wallclock:  number
  readonly entity:     Entity         // always present — renderable per-entity without a join
  readonly component?: ComponentId
  readonly fault?:     InspectorEntry  // set only when eventKind === 'fault'
}

// Point-in-time, structurally-cloneable copy of an InspectorView — safe to hand
// to an agent or persist. Plain arrays, unlike the live view's growing buffers.
interface InspectorSnapshot {
  readonly entries:      InspectorEntry[]
  readonly systemic:     InspectorEntry[]
  readonly entityScoped: InspectorEntry[]
  readonly timeline:     TimelineEvent[]
}
```

---

## `@domecs/scene`

Hierarchy (`Parent`, `setParent`, `childrenOf`, `ancestorsOf`, `rootsOf`,
`despawnTree`, `installHierarchy`) and `composeTransforms` are documented in
the package README. This section covers the spatial index.

### Spatial index

`createSpatialHash(world, options)` indexes one position component over the
core grid (2.2; O-8; SPEC §2.12).

```ts
function createSpatialHash(world: World, options: SpatialHashOptions): SpatialIndex   // RangeError on a bad cellSize

interface SpatialHashOptions {
  readonly component: ComponentType<any>
  readonly x?: string          // default 'x'
  readonly y?: string          // default 'y'
  readonly cellSize: number    // performance only; never changes results
}

interface SpatialIndex {
  refresh(): void   // rebuild from the component's current values (O(n), ascending id)
  within(x: number, y: number, r: number, filter?: readonly ComponentType<any>[]): Entity[]
  nearest(x: number, y: number, options?: { maxDistance?: number; filter?: readonly ComponentType<any>[]; exclude?: Entity }): Entity | undefined
  pairs(r: number, a: ComponentType<any>, b: ComponentType<any>): Array<[Entity, Entity]>
  dispose(): void   // later calls throw
}
```

- Positions are those read at the last `refresh()`; the index refreshes
  once when created. Call `refresh()` once per step before querying, for
  example at the start of the system that queries. A field that is not a
  finite number is not indexed.
- `filter` lists components the entity must **all** hold. It is read live
  (`world.has`) at query time, so tag changes need no refresh.
- `pairs(r, a, b)`: the first element holds `a`, the second `b`. For
  `a !== b` every such ordered pair is listed (an entity with both tags can
  appear on either side); for `a === b`, first < second. Sorted by
  `(first, second)`.
- Never snapshotted; building or querying an index leaves `hashSnapshot`
  unchanged. After `restore()`, call `refresh()`.

```ts doctest name=spatial-index
import { strict as assert } from 'node:assert'
import { createWorld, defineComponent, entry, hashSnapshot } from '@domecs/core'
import { createSpatialHash } from '@domecs/scene'

const Pos = defineComponent<{ x: number; y: number }>('SiPos', { defaults: { x: 0, y: 0 } })
const Prey = defineComponent<{ alert: boolean }>('SiPrey', { defaults: { alert: false } })
const Hunter = defineComponent<{ hunger: number }>('SiHunter', { defaults: { hunger: 0 } })

const world = createWorld({ headless: true, seed: [1, 2, 3, 4] })
const rabbit = world.spawn([entry(Pos, { x: 0, y: 0 }), entry(Prey, { alert: false })])
const fox = world.spawn([entry(Pos, { x: 3, y: 4 }), entry(Hunter, { hunger: 5 })])
const deer = world.spawn([entry(Pos, { x: 40, y: 0 }), entry(Prey, { alert: false })])

const before = hashSnapshot(world.snapshot(), { includeChanges: true })
const index = createSpatialHash(world, { component: Pos, cellSize: 8 })

world.system('spot', { schedule: 'tick', query: [Hunter, Pos] }, ({ entities }) => {
  index.refresh() // positions as of this step
  for (const h of entities) {
    const at = world.getComponent(h.id, Pos)!
    const prey = index.nearest(at.x, at.y, { filter: [Prey], maxDistance: 10 })
    if (prey === undefined) continue
    world.getComponent(prey, Prey)!.alert = true
    world.markChanged(prey, Prey)
  }
})

assert.deepEqual(index.within(0, 0, 5), [rabbit, fox])
assert.deepEqual(index.within(0, 0, 100, [Prey]), [rabbit, deer])
assert.equal(index.nearest(0, 0, { exclude: rabbit }), fox)
assert.deepEqual(index.pairs(5, Hunter, Prey), [[fox, rabbit]])
assert.equal(hashSnapshot(world.snapshot(), { includeChanges: true }), before) // derived state

world.stepOnce()
assert.equal(world.getComponent(rabbit, Prey)!.alert, true)
assert.equal(world.getComponent(deer, Prey)!.alert, false)

// moves show after refresh()
world.getComponent(deer, Pos)!.x = 2
world.markChanged(deer, Pos)
index.refresh()
assert.deepEqual(index.within(0, 0, 5, [Prey]), [rabbit, deer])
```

---

## `@domecs/rules`

Data-defined rules (`RuleDef`: `query`, `without`, `when`, `actions`)
compiled and installed as systems named `rule:<name>`. The language is
specified in SPEC Appendix A (tutorial: the package README); this section
covers installation, ordering and the 2.2 cross-entity forms.

```ts
function installRules(
  world: World,
  defs: RuleDef[],
  resolve: (name: string) => ComponentType<any> | undefined,
  options?: InstallRulesOptions,
): RulesHandle   // throws on an unknown `order` or `rng`, or an `orderBase` that is not finite or exceeds ±2^51

interface InstallRulesOptions {
  // 'registration' (default, 2.0 behaviour): rules tie-break by registration
  // index, so update() moves every rule after the equal-priority systems
  // registered before it.
  // 'stable': rule i of the de-duplicated defs registers with
  // `order: orderBase + i`; its run position depends only on
  // (priority, defs order). A def that fails to compile keeps its index.
  readonly order?: 'registration' | 'stable'
  readonly orderBase?: number   // first order key in 'stable' mode; default 1; |orderBase| <= 2^51
  // Stream mode for every rule without its own RuleDef.rng (2.1). 'shared'
  // (default): random() draws world.rand. 'own': each rule draws its own
  // stream, keyed rule:<name> (SPEC §2.8), so editing one rule never changes
  // another's draws, and update() re-registration resumes the stream.
  readonly rng?: 'shared' | 'own'
  // Position source for nearest / countWithin / distanceTo (2.2); required
  // if any rule uses them. Throws unless { component, x?, y?, cellSize? }
  // with non-empty names and a finite cellSize > 0 (default 32).
  readonly spatial?: SpatialOption
}

interface SpatialOption {
  readonly component: string   // the position component
  readonly x?: string          // default 'x'
  readonly y?: string          // default 'y'
  readonly cellSize?: number   // grid cell size: performance only, results never depend on it
}

// RuleDef gains (2.1): rng?: 'shared' | 'own' — overrides the install default
// for that rule; any other value is a RuleError on field 'rng'.
// RuleDef gains (2.2): without?: string[] — components that exclude an entity
// (And(...Has(query), ...Not(Has(without)))); an unknown name is a RuleError
// on field { without: i }.

// compileRule gains an optional third argument (2.2):
function compileRule(def: RuleDef, resolve: (name: string) => ComponentType<any> | undefined,
  options?: { spatial?: SpatialOption }): { rule: CompiledRule; errors: [] } | { rule: null; errors: RuleError[] }

interface RulesHandle {
  update(defs: RuleDef[]): Map<string, RuleError[]>   // replace the rule set
  uninstall(): void
}

interface RuleError {
  rule: string
  position: number        // offset within the part named by `field`, or -1
  message: string
  field?: RuleDefPath     // set on every error from compileRule / update() (2.1)
}

// Which part of a RuleDef an error is about. Later minors add members:
// keep a default branch.
type RuleDefPath =
  | 'name' | 'schedule' | 'priority' | 'rng' | 'when'
  | { readonly query: number }
  | { readonly without: number }                      // 2.2
  | { readonly action: number; readonly part: 'set' | 'expr' }
```

**Ordering.** Systems run by (priority, `order`, registration index) — SPEC
§3. In `'stable'` mode an equal-priority system left at the default `order`
0 runs before every rule, and rules run in defs order however many times
`update()` ran, so a live world and a fresh world built from the current
defs and restored from the live snapshot stay hash-equal. Use one stable
handle per world, or give each its own `orderBase` range. Keep rule
priorities strictly between −100 (commands, input) and 100 (derived
transforms such as `composeTransforms({ priority: 100 })`); the full band
table is in SPEC §3.

```ts doctest name=rules-stable-order
import { strict as assert } from 'node:assert'
import { createWorld, defineComponent, entry, hashSnapshot } from '@domecs/core'
import { installRules, type RuleDef } from '@domecs/rules'

const P = defineComponent<{ x: number }>('RoP', { defaults: { x: 0 } })
const W = defineComponent<{ x: number }>('RoW', { defaults: { x: 0 } })
const defs: RuleDef[] = [
  { name: 'inc', schedule: 'tick', query: ['RoP'], actions: [{ set: 'RoP.x', expr: 'RoP.x + 1' }] },
]

function build(order: 'registration' | 'stable', update: boolean): string {
  const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
  w.spawn([entry(P, { x: 0 }), entry(W, { x: 0 })])
  const rules = installRules(w, defs, (n) => (n === 'RoP' ? P : undefined), { order })
  w.system('copy', { query: [P, W] }, ({ entities }) => {
    for (const e of entities) {
      w.getComponent(e.id, W)!.x = w.getComponent(e.id, P)!.x
      w.markChanged(e.id, W)
    }
  })
  if (update) rules.update(defs) // re-registers every rule
  for (let i = 0; i < 5; i++) w.stepOnce()
  return hashSnapshot(w.snapshot(), { includeChanges: true })
}

// 'registration': a no-op update() moves the rule after `copy`.
assert.notEqual(build('registration', true), build('registration', false))
// 'stable': position is a function of the defs, not of update() history.
assert.equal(build('stable', true), build('stable', false))
// order is validated at registration.
assert.throws(() => createWorld({ headless: true }).system('s', { order: NaN }, () => {}), /order/)
```

**Cross-entity forms (2.2; SPEC Appendix A).** Selectors `self`,
`first(S)`, `nearest(S[, d])`, `entity(n)` read another entity's fields
(`first(Player).Pos.x`, `nearest(Coin).id`); `has([e,] C)`, `count(S)`,
`exists(S)`, `sum`/`avg`/`minOf`/`maxOf(S, C.f)`, `countWithin(S, r[, e])`
and `distanceTo(e)` work over sets (a set `S` is the holders of component
`S`). `a ?? b` takes `b` when `a` has no value (a missing field, an empty
selector, a dead `entity(n)`, an empty `avg`); type errors still fault.
New functions: `sqrt pow atan2 hypot sign round ceil lerp distance` (`pow`,
`atan2`, `hypot` via `dmath`), and the identifier `tick`. Reads are live and
entities run in ascending id, so an entity sees the writes lower ids made in
the same run. `self`, `tick`, `other`, `event` and `pointer` are reserved
words, and `walkComponentRefs(ast, visit)` visits every component name
(reads, sets, `has` targets) for tools that rename components.

```ts doctest name=rules-cross-entity
import { strict as assert } from 'node:assert'
import { createWorld, defineComponent, entry } from '@domecs/core'
import { installRules, parseExpression, walkComponentRefs, type RuleDef } from '@domecs/rules'

const Pos = defineComponent<{ x: number; y: number }>('XrPos', { defaults: { x: 0, y: 0 } })
const Player = defineComponent<Record<string, never>>('XrPlayer', { defaults: {} })
const Enemy = defineComponent<{ near: number }>('XrEnemy', { defaults: { near: 0 } })
const types = new Map([Pos, Player, Enemy].map((t) => [t.name, t]))

const defs: RuleDef[] = [
  {
    // Enemies close 10% of the gap to the player each tick and count the
    // other enemies within 5 units.
    name: 'chase', schedule: 'tick', query: ['XrEnemy', 'XrPos'], without: ['XrPlayer'],
    actions: [
      { set: 'XrPos.x', expr: 'XrPos.x + (first(XrPlayer).XrPos.x - XrPos.x) * 0.1 ?? XrPos.x' },
      { set: 'XrEnemy.near', expr: 'countWithin(XrEnemy, 5)' },
    ],
  },
]
const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
const errors = installRules(w, [], (n) => types.get(n), { spatial: { component: 'XrPos' } }).update(defs)
assert.equal(errors.size, 0)
w.spawn([entry(Player, {}), entry(Pos, { x: 100, y: 0 })])
const a = w.spawn([entry(Enemy, { near: 0 }), entry(Pos, { x: 0, y: 0 })])
w.spawn([entry(Enemy, { near: 0 }), entry(Pos, { x: 3, y: 4 })])
w.stepOnce()
assert.equal(w.getComponent(a, Pos)!.x, 10)
assert.equal(w.getComponent(a, Enemy)!.near, 1) // the other enemy, 5 away (inclusive)

// Spatial forms need the spatial option: otherwise the rule does not compile.
const bad = installRules(createWorld({ headless: true }), defs, (n) => types.get(n))
assert.deepEqual(bad.update(defs).get('chase')![0]!.field, { action: 1, part: 'expr' })

// Every component name, with its role:
const parsed = parseExpression('first(XrPlayer).XrPos.x - XrPos.x')
assert.ok('ast' in parsed)
const seen: string[] = []
walkComponentRefs(parsed.ast, (c, f, _pos, role) => seen.push(`${role}:${c}${f ? '.' + f : ''}`))
assert.deepEqual(seen, ['set:XrPlayer', 'member:XrPos.x', 'self:XrPos.x'])
```

**World expressions (2.2; §5.3).** `compileWorldExpression(source, resolve,
options?)` → `{ expression: WorldExpression, errors: [] }` or
`{ expression: null, errors: RuleError[] }` compiles an expression with no
evaluated entity (a metric or probe). Bare `Component.field`, `self`,
`has(C)`, `countWithin(S, r)` without a centre, `distanceTo`, `nearest`, `dt`
and `random()` are compile errors at their position (`rule: '<expr>'`);
read through `first(S)` / `entity(n)` instead. `time` is
`world.time.elapsed`, `tick` is `world.time.tick`. `expression.evaluate(world)`
returns `Result<number | string | boolean, RuleFault>`: it is read-only (no
RNG draw, no change windows, no registration of a type no entity holds),
so the strict snapshot hash and `describe().componentCounts` are unchanged,
and a no-value read without `??` or a non-finite result (`0 / 0`) is
`err({ kind: 'rule_eval_failed', rule: '<expr>', message })`.

```ts doctest name=rules-world-expression
import { strict as assert } from 'node:assert'
import { createWorld, defineComponent, entry, hashSnapshot } from '@domecs/core'
import { compileWorldExpression } from '@domecs/rules'

const Pos = defineComponent<{ x: number; y: number }>('WeDocPos', { defaults: { x: 0, y: 0 } })
const Player = defineComponent<Record<string, never>>('WeDocPlayer', { defaults: {} })
const Enemy = defineComponent<{ hp: number }>('WeDocEnemy', { defaults: { hp: 1 } })
const types = new Map([Pos, Player, Enemy].map((t) => [t.name, t]))
const resolve = (n: string) => types.get(n)

const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
w.spawn([entry(Player, {}), entry(Pos, { x: 0, y: 0 })])
w.spawn([entry(Enemy, { hp: 3 }), entry(Pos, { x: 3, y: 4 })])
w.spawn([entry(Enemy, { hp: 5 }), entry(Pos, { x: 30, y: 0 })])

const near = compileWorldExpression('countWithin(WeDocEnemy, 10, first(WeDocPlayer))', resolve, {
  spatial: { component: 'WeDocPos' },
})
assert.ok(near.expression)
const before = hashSnapshot(w.snapshot({}), { includeChanges: true })
assert.deepEqual(near.expression.evaluate(w), { ok: true, value: 1 })
assert.equal(hashSnapshot(w.snapshot({}), { includeChanges: true }), before) // read-only

const total = compileWorldExpression('sum(WeDocEnemy, WeDocEnemy.hp) + tick', resolve)
assert.deepEqual(total.expression!.evaluate(w), { ok: true, value: 8 })

// No value without ?? is an error value; ?? supplies a fallback.
const missing = compileWorldExpression('first(WeDocEnemy).WeDocPos.z', resolve).expression!
assert.equal(missing.evaluate(w).ok, false)
const fallback = compileWorldExpression('first(WeDocEnemy).WeDocPos.z ?? -1', resolve).expression!
assert.deepEqual(fallback.evaluate(w), { ok: true, value: -1 })

// No evaluated entity, and no randomness: rejected with positions.
const bad = compileWorldExpression('WeDocEnemy.hp + random()', resolve)
assert.equal(bad.expression, null)
assert.deepEqual(bad.errors.map((e) => e.position), [0, 16])
```

**Input in rules (2.2; §5.4).** Rules read the tick's `world.input`:
`key(n)` (held, `keys`), `pressed(n)` / `released(n)` (edges, `keyDelta`),
`mod(n)` (`'ctrl' | 'alt' | 'shift' | 'meta'`) and
`pointer.x|y|buttons|wheel`. The argument is any string expression (`key(Bind.up)`).
`pressed`, `released` and `pointer.wheel` in a `fixed` rule are compile
errors (edges last one render tick), and every input form is a compile error
in a world expression. Input is not part of the snapshot: install the same
`setInput` snapshots before the same steps to reproduce a run.

```ts doctest name=rules-input
import { strict as assert } from 'node:assert'
import { createWorld, defineComponent, entry, type InputSnapshot } from '@domecs/core'
import { compileRule, compileWorldExpression, installRules, type RuleDef } from '@domecs/rules'

const Ship = defineComponent<{ vx: number; shots: number }>('InDocShip', { defaults: { vx: 0, shots: 0 } })
const resolve = (n: string) => (n === 'InDocShip' ? Ship : undefined)

const input = (keys: string[], pressed: string[] = []): InputSnapshot => ({
  keys: new Set(keys),
  keyDelta: { pressed: new Set(pressed), released: new Set() },
  mods: { ctrl: false, alt: false, shift: false, meta: false },
  pointer: { x: 0, y: 0, buttons: 0, delta: { x: 0, y: 0 }, wheel: 0, entered: [] },
  gamepads: [],
  focus: { activeTag: '', consumesKeys: false },
})

const steer: RuleDef = {
  name: 'steer', schedule: 'tick', query: ['InDocShip'],
  actions: [
    { set: 'InDocShip.vx', expr: '(key("ArrowRight") ? 1 : 0) - (key("ArrowLeft") ? 1 : 0)' },
    { set: 'InDocShip.shots', expr: 'InDocShip.shots + (pressed("Space") ? 1 : 0)' },
  ],
}
const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
assert.equal(installRules(w, [], resolve).update([steer]).size, 0)
const ship = w.spawn([entry(Ship, { vx: 0, shots: 0 })])

w.setInput(input(['ArrowRight', 'Space'], ['Space']))
w.stepOnce()
assert.deepEqual(w.getComponent(ship, Ship), { vx: 1, shots: 1 })
w.setInput(input(['Space'])) // still held, no new edge
w.stepOnce()
assert.deepEqual(w.getComponent(ship, Ship), { vx: 0, shots: 1 })

// Edges in a fixed rule, and input in a metric, are compile errors.
const fixed = compileRule({ ...steer, schedule: 'fixed' }, resolve)
assert.deepEqual(fixed.errors.map((e) => e.field), [{ action: 1, part: 'expr' }])
assert.equal(compileWorldExpression('key("Space") ? 1 : 0', resolve).expression, null)
```

---

## Framework integration

v1.0 ships no first-party framework adapters (see SPEC §11).  Integrate from user code by subscribing to `World.signals` and calling `world.markChanged(entity, type)` from systems that mutate components.  `snapshot()` is a plain-data (JSON-oriented) handoff suitable for any framework's external store (see SPEC §7 for the plain-data contract).

---

## Quick-start example (updated)

```ts
import { createWorld, defineComponent, entry } from '@domecs/core'
import { mountDOM, defineView } from '@domecs/dom'
import { createInputPlugin } from '@domecs/input'

const Position = defineComponent<{ x: number; y: number }>('Position')
const Velocity = defineComponent<{ dx: number; dy: number }>('Velocity')

const world = createWorld({ seed: 0xC0FFEE })

world.use(createInputPlugin())
mountDOM(world, {
  slots: { stage: document.getElementById('stage')! },
  views: [
    defineView({
      slot: 'stage',
      // Tuple-form query: `view.Position` is typed.
      // `changedOn` is auto-derived from the query's `Has(T)` leaves,
      // so the view redraws when Position is marked changed and stays
      // silent otherwise (SPEC §5.3, P-3).
      query: [Position] as const,
      create: () => {
        const el = document.createElement('div')
        el.className = 'dot'
        return el
      },
      update: (el, e) => {
        el.style.transform = `translate(${e.Position.x}px, ${e.Position.y}px)`
      },
    }),
  ],
})

world.system('movement', {
  query: [Position, Velocity],
  schedule: 'tick',
}, ({ entities, time }) => {
  for (const e of entities) {
    e.Position.x += e.Velocity.dx * time.scaledDelta
    e.Position.y += e.Velocity.dy * time.scaledDelta
    world.markChanged(e.id, Position)
  }
})

world.spawn([
  entry(Position, { x: 100, y: 100 }),
  entry(Velocity, { dx: 30, dy: 0 }),
])

world.startLoop()
```

Note: `world.markChanged` is explicit — this is the contract, not an adapter gap (SPEC §2.9). v1.0 is proxy-free in every build: there is no `WorldOptions.dev` and no `world.diag` surface. Future diagnostics may warn on **mutation-without-mark** or **mark-without-mutation**, but they must not change `OnChanged(T)` semantics.
