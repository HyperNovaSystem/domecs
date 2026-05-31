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
  headless?:  boolean      // default false; start() throws, world.step() drives ticks; no browser globals required
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
world.resource(Score)             // → 10 (materializes default on first read)
world.markResourceChanged(Score)  // mark without replacing (in-place mutation)
```

Reactive systems observe resource edges via `ChangedResource(R)` in `reactsTo`
(see Query builder below and SPEC §4 step 6). Resources are part of
`snapshot()` / `restore()` (Snapshot below).

### `World`

```ts
interface World {
  // lifecycle
  //
  // `start(options?)` installs an rAF-driven loop that computes wall-clock
  // dt, clamps it, and pipes each frame into `step(dt)`. Returns a disposer
  // that calls `stop()`. Calling `start()` on an already-running world is a
  // no-op (returns the disposer) and also wakes a sleeping idle loop. In
  // environments without `requestAnimationFrame` it throws — use `step(dt)`
  // instead. Worlds created with `{ headless: true }` also throw even if rAF
  // exists in the host environment.
  //
  // When `WorldOptions.idle !== false`, the driver sleeps when no always-on
  // frame work remains (no enabled `tick`/`fixed`/unfired `once` systems, no
  // pending component work, no queued events). It wakes on external
  // `world.emit(...)`, structural component mutations / `markChanged`,
  // `@domecs/input` activity, `resume()`, or an explicit `start()`.
  //
  // `step(dt)` semantics:
  //   - `step(dt)` with `dt > 0`: normal tick advance.
  //   - `step(0)` — F-6 heartbeat: no tick advance, no system execution,
  //     no change-detection buffer swap. Plugin hooks + tickStart/tickEnd
  //     signals + onRender still fire so UIs can paint initial state and
  //     input plugins can republish snapshots between turns. Use this to
  //     prime the world before `start()` or to poll between turns in a
  //     turn-based game.
  //   - `step()` (no arg): legacy "advance one tick with dt=0". Preserved
  //     for `turn()` and turn-based exemplars. Not a heartbeat.
  //   - `step(dt)` with `0 < dt < 1 ms`: dt is floored at 1 ms of
  //     scaled time so PID derivative consumers never see `scaledDelta=0`.
  //     See SPEC §2.7.
  start(options?: StartOptions): () => void
  stop():   void
  step(dt?: number):  void     // see rules above
  stepN(n: number, dt?: number): void

  // Turn-based action: emit an event and advance one tick.
  turn<T>(type: EventType<T>, payload: T, dt?: number): void

  // Turn-based command with a structured result (#17). Like turn(), but
  // returns { accepted, consumedTurn, reason?, events, snapshot? }. `events`
  // are the events emitted during the action's tick (downstream effects; the
  // action event itself was consumed at step 1). The verdict comes from
  // opts.resolve (default { accepted: true, consumedTurn: true }; an omitted
  // consumedTurn mirrors accepted). action always advances one tick;
  // consumedTurn is a reported value, not engine-enforced. SPEC §3.
  action<T>(type: EventType<T>, payload: T, opts?: ActionOptions): ActionResult

  // entities
  spawn(components?: ComponentBag): Entity
  despawn(entity: Entity): void
  has(entity: Entity, type: ComponentType<unknown>): boolean

  // components
  addComponent<T>(entity: Entity, type: ComponentType<T>, value: T): void
  removeComponent(entity: Entity, type: ComponentType<unknown>): void
  getComponent<T>(entity: Entity, type: ComponentType<T>): T | undefined
  // May be called inside or outside a running system. Between-tick calls are
  // buffered and promoted into the live change-detection set at the next
  // step()'s step 0 — symmetric with event buffering. See SPEC §2.9.
  // v1.0 has no proxy-backed dev diagnostics surface: no WorldOptions.dev and
  // no world.diag. Missed marks are caller bugs; future tooling may warn.
  markChanged<T>(entity: Entity, type: ComponentType<T>): void

  // resources (SPEC §2.11). Same buffer-and-swap discipline as markChanged.
  // resource() returns undefined only when there is no value and no default;
  // a default is materialized (validated, stored) on first read. setResource
  // validates + stores + marks changed; markResourceChanged marks without
  // replacing (for in-place mutation). Both wake an idle driver.
  resource<T>(type: ResourceType<T>): T | undefined
  setResource<T>(type: ResourceType<T>, value: T): void
  markResourceChanged<T>(type: ResourceType<T>): void

  // systems
  system(name: string, def: SystemDef, fn: System): SystemHandle
  // The live SystemHandle for a registered system by name (built-in or
  // user-registered), or undefined. Flipping its enabled/disable() affects
  // scheduling on the next step — the escape hatch for disabling built-ins
  // like the fault consolidator (CONSOLIDATE_FAULTS_NAME).
  getSystem(name: string): SystemHandle | undefined

  // queries
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

  // plugins
  use(plugin: Plugin, options?: unknown): () => void
  capability<K extends string>(name: K): Capability<K>

  // reflection
  componentTypes(): ComponentType<unknown>[]
  // Iterate every live entity carrying `type`, paired with its value. Same
  // semantics as `world.query(Has(type))` + per-entity `getComponent`, with
  // less ceremony at the call-site (F-10).
  entitiesWith<T>(type: ComponentType<T>): Iterable<{ id: Entity; value: T }>
  archetype(entity: Entity): ComponentType<unknown>[]
  // Reflect a component's name/transient/defaults/field-schema (#14). Works on
  // any ComponentType without prior registration; enumerate via componentTypes().
  describeComponent(type: ComponentType<unknown>): ComponentDescriptor

  // snapshots
  // options.pruneEmptyEntities (default false): drop entities whose
  // serializable bag is empty once transient components are excluded —
  // transient-only and bare spawn() entities. Persist's
  // pruneTransientOnlyEntities() plugin applies this on the no-arg save() path.
  snapshot(options?: SnapshotOptions): WorldSnapshot
  // Trusted authored-snapshot restore. Rehydrates name-keyed component bags;
  // strict schema validation and unknown-component tooling are future work.
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
  }
}

type Entity = number

// Options for `World.start`. The rAF driver is intentionally thin:
// compute wall-clock dt, clamp it, pipe it to step(dt). Consumers that
// need custom scheduling keep using `step()` directly.
interface StartOptions {
  dtClampMs?:    number   // default 100
  pauseOnHidden?: boolean // default true
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
  dt?:       number                      // forwarded to step(); omit for a turn-based advance
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
  priority?: number
  rateHz?:   number                        // fixed only
  triggers?: EventType<unknown>[]          // event only
  reactsTo?: QueryDef                      // reactive only
  enabled?:  () => boolean
  state?:    unknown                       // system-local; preserved across dev-mode hot-swap (SPEC §9.5)
}

type System = (ctx: SystemContext) => void

interface SystemContext {
  // For `tick`/`fixed`/`once` systems: the `query` result. For `reactive`
  // systems with only `reactsTo` and no explicit `query`: the `reactsTo`
  // change delta for this tick (an explicit `query` takes precedence). Empty
  // when neither is declared.
  entities: EntityView[]
  time:     TimeState
  input:    InputSnapshot
  events:   EventView
  world:    WorldAPI
  rand:     Rng
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
function Changed<T>(t: ComponentType<T>): QueryNode
function Added<T>(t: ComponentType<T>): QueryNode
function Removed<T>(t: ComponentType<T>): QueryNode
function Where<T>(t: ComponentType<T>, p: (v: T) => boolean): QueryNode

// Resource change-detection node (SPEC §2.11): fires when resource R changed
// in the previous tick. Structurally neutral — matches every entity on a
// change tick, none otherwise — so And(Has(T), ChangedResource(R)) yields the
// T entities only on R-change ticks; a bare ChangedResource(R) is a
// world-level edge a reactive system reacts to even in an empty world.
// Counts as a change-detection node for the reactsTo contract (SPEC §4 step 6).
function ChangedResource<T>(r: ResourceType<T>): QueryNode

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
  // Requires a change-detection query (Added/Removed/Changed/ChangedResource
  // somewhere in the tree). Fires at the reactive phase for every entity
  // currently in the query result after that tick's mutations are coalesced.
  onChange?: (e: EntityView<Fields>) => void
}
```

### Events

```ts
function defineEvent<T>(name: string): EventType<T>

// `EventType<T>` is identity-keyed: the bus dispatches on a per-instance
// symbol stored on the type object, not on `name`. Two `defineEvent('Same')`
// calls produce distinct types whose payload buckets, subscribers, and views
// never collide. `name` is an opaque label for diagnostics — duplicates are
// permitted. (F-8.)
interface EventType<T> {
  readonly name: string
}

interface EventView {
  of<T>(type: EventType<T>): readonly T[]
  emit<T>(type: EventType<T>, payload: T): void
}
```

**Inter-entity references.** Components carrying foreign-entity ids
(`tableId: Entity | null`, `customerId: Entity | null`) become dangling on
despawn. The canonical cleanup pattern uses `signals.entityDespawned`
(SPEC §2.10 despawn ordering rule) plus `world.entitiesWith`:

```ts
world.signals.entityDespawned.subscribe((dead) => {
  for (const { id, value } of world.entitiesWith(Table)) {
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
// SNAPSHOT_VERSION === 2. v2 added `resources` (SPEC §2.11); @domecs/persist
// ships a built-in 1→2 migration so legacy v1 saves load transparently.
const SNAPSHOT_VERSION = 2

interface WorldSnapshot {
  readonly version:  number
  readonly seed:     readonly [number, number, number, number]
  readonly tick:     number
  readonly entities: ReadonlyArray<{
    id:         Entity
    components: Record<string, unknown>
  }>
  // name → deep-cloned value. Omitted entirely when no resource has a value.
  // restore() clears live resources first, so an absent map falls back to
  // resource defaults. (v2+)
  readonly resources?: Record<string, unknown>
  readonly meta?: Record<string, unknown>
}

interface SnapshotOptions {
  // Drop entities whose serializable bag is empty once transient components
  // are excluded. Default false (every alive entity is recorded).
  readonly pruneEmptyEntities?: boolean
}
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

interface PluginHandle {
  teardown?:    () => void
  onTickStart?: (world: World) => void
  onTickEnd?:   (world: World) => void
  onRender?:    (world: World) => void
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
function mountDOM(world: World, options: MountOptions): MountHandle

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
// `changedOn` semantics (SPEC §5.3 update-gating rule, P-3):
//   - omitted (default): redraws are gated by `Changed(T)` for every
//     `Has(T)` leaf in `query`. A view over `[Position, Velocity]`
//     auto-redraws when either component is marked changed.
//   - `changedOn: []` (explicit empty): legacy "redraw every tick". Useful
//     for time-driven animations where the view depends on `time.elapsed`
//     rather than component identity.
//   - `changedOn: [Type, ...]`: explicit gate. Overrides the auto-derive.
interface ViewDef<Fields = Record<string, unknown>> {
  slot:         string
  query:        QueryShorthand
  changedOn?:   readonly ComponentType<unknown>[]
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
not an error. `createMemoryStorage` ships an in-memory adapter.

```ts
interface Storage {
  read(slot: string):                Result<string | null, DomecsError>
  write(slot: string, data: string): Result<void, DomecsError>
  remove(slot: string):              Result<void, DomecsError>
  list():                            Result<readonly string[], DomecsError>
}

function createMemoryStorage(initial?: Readonly<Record<string, string>>): Storage
```

**Save / load.** `save` captures `world.snapshot()`, stamps `meta.savedAt`,
serializes to JSON, and writes to `slot`. `load` reads `slot`, parses it,
migrates the envelope to `targetVersion` (default `SNAPSHOT_VERSION`, 2)
before calling `world.restore`.

```ts
function save(world: World, storage: Storage, slot: string, opts?: SaveOptions): Result<void, DomecsError>
function load(world: World, storage: Storage, slot: string, opts?: LoadOptions): Result<void, DomecsError>

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
undo/redo ring over `WorldSnapshot`s; `diffSnapshots` is an entity-level diff
between two snapshots.

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

function diffSnapshots(prev: WorldSnapshot, next: WorldSnapshot): SnapshotDiff

interface SnapshotDiff {
  readonly addedEntities:   readonly Entity[]
  readonly removedEntities: readonly Entity[]
  readonly changedEntities: readonly Entity[]
}
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

## Framework integration

v1.0 ships no first-party framework adapters (see SPEC §11).  Integrate from user code by subscribing to `World.signals` and calling `world.markChanged(entity, type)` from systems that mutate components.  `snapshot()` is a structurally-cloneable handoff suitable for any framework's external store.

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

world.start()
```

Note: `world.markChanged` is explicit — this is the contract, not an adapter gap (SPEC §2.9). v1.0 is proxy-free in every build: there is no `WorldOptions.dev` and no `world.diag` surface. Future diagnostics may warn on **mutation-without-mark** or **mark-without-mutation**, but they must not change `Changed(T)` semantics.
