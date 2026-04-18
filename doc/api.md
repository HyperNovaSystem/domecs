# DOMECS — API Reference (Draft v0.1)

Concrete type and function signatures for the public API described in `SPEC.md`. Anything not listed here is internal and may change without notice.

---

## `domecs` (core)

### `createWorld`

```ts
function createWorld(options?: WorldOptions): World

interface WorldOptions {
  seed?:      number | [number, number, number, number]
  headless?:  boolean      // no RAF loop; world.step() drives ticks
  fixedStep?: number       // seconds; default 1/60
  idle?:      boolean      // default true; suspend RAF when no work
  dev?:       DevOptions
}

// Dev-only diagnostics; stripped at prod build time.
interface DevOptions {
  // Emit on mutation-without-markChanged. Default 'warn' in dev, forced
  // 'off' in prod. 'throw' is the CI setting.
  markWarn?:    'warn' | 'throw' | 'off'

  // Emit an info-level hint when markChanged is called but no mutation
  // was recorded on that entity/type this tick. Off by default — flip on
  // when profiling. Never fires in prod.
  markOveruse?: 'hint' | 'off'
}
```

### `defineComponent`

```ts
function defineComponent<T>(
  name:    string,
  options?: ComponentOptions<T>
): ComponentType<T>

interface ComponentOptions<T> {
  defaults?:  Partial<T>
  transient?: boolean        // excluded from snapshots; default false
  validate?:  (value: T) => true | string
}

interface ComponentType<T> {
  readonly name:   string
  readonly __tag:  unique symbol
  create(value?: Partial<T>): T
}
```

### `World`

```ts
interface World {
  // lifecycle
  start():  void
  stop():   void
  step(dt?: number):  void     // headless or manual
  stepN(n: number):   void

  // entities
  spawn(components?: ComponentBag): Entity
  despawn(entity: Entity): void
  has(entity: Entity, type: ComponentType<unknown>): boolean

  // components
  addComponent<T>(entity: Entity, type: ComponentType<T>, value: T): void
  removeComponent(entity: Entity, type: ComponentType<unknown>): void
  getComponent<T>(entity: Entity, type: ComponentType<T>): T | undefined
  markChanged<T>(entity: Entity, type: ComponentType<T>): void

  // Dev-only diagnostics surface. In prod, diag.markChanged.* counters
  // remain addressable but stay at zero. See SPEC §2.9.
  readonly diag: {
    markChanged: {
      mutations:   number               // writes observed by the I-1 proxy this tick
      marks:       number               // markChanged calls this tick
      unmarked:    number               // mutations without a corresponding mark
      overmarked:  number               // marks without a corresponding mutation
      recent(): ReadonlyArray<{
        kind:   'unmarked' | 'overmarked'
        entity: Entity
        type:   string                  // ComponentType name
        field?: string                  // for 'unmarked'
        tick:   number
      }>
    }
  }

  // systems
  system(name: string, def: SystemDef, fn: System): SystemHandle

  // queries
  query(def: QueryDef): QueryResult
  observe(def: QueryDef, hooks: QueryHooks): () => void

  // events
  emit<T>(type: EventType<T>, payload: T): void
  on<T>(type: EventType<T>, fn: (e: T) => void): () => void

  // time
  readonly time:  Readonly<TimeState>
  setScale(scale: number): void
  pause():  void
  resume(): void

  // random
  readonly rand: Rng

  // plugins
  use(plugin: Plugin, options?: unknown): () => void
  capability<K extends string>(name: K): Capability<K>

  // reflection
  componentTypes(): ComponentType<unknown>[]
  archetype(entity: Entity): ComponentType<unknown>[]

  // snapshots
  snapshot(): WorldSnapshot
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

// Observation channel returned from `World.signals`. Subscribers fire
// synchronously in the tick phase that emitted the signal (see SPEC §2.10).
interface Signal<T> {
  subscribe(fn: (e: T) => void): () => void   // returns unsubscribe
}

type ComponentBag = Record<string, unknown>
// runtime-typed via the ComponentType's `name` as the bag key

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
  entities: EntityView[]
  time:     TimeState
  input:    InputSnapshot
  events:   EventView
  world:    WorldAPI
  rand:     Rng
  state:    unknown                        // system-local; read SystemDef.state
}

interface EntityView {
  readonly id: Entity
  readonly [componentName: string]: unknown  // typed via module augmentation
}

interface SystemHandle {
  name:     string
  enabled:  boolean
  enable():  void
  disable(): void
  remove():  void
  replaceFn?(fn: System): void   // dev builds only; SPEC §9.5. Absent in prod.
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
  | { kind: 'not';      child: QueryNode }
  | { kind: 'and';      children: QueryNode[] }
  | { kind: 'or';       children: QueryNode[] }

// Component shortcuts: take a ComponentType, produce a leaf node.
function Has<T>(t: ComponentType<T>): QueryNode
function Changed<T>(t: ComponentType<T>): QueryNode
function Added<T>(t: ComponentType<T>): QueryNode
function Removed<T>(t: ComponentType<T>): QueryNode
function Where<T>(t: ComponentType<T>, p: (v: T) => boolean): QueryNode

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

interface QueryResult {
  readonly entities: EntityView[]
  readonly size:     number
  onAdd(fn: (e: EntityView) => void): () => void
  onRemove(fn: (e: EntityView) => void): () => void
}

interface QueryHooks {
  onAdd?:    (e: EntityView) => void
  onRemove?: (e: EntityView) => void
  onChange?: (e: EntityView) => void
}
```

### Events

```ts
function defineEvent<T>(name: string): EventType<T>

interface EventType<T> {
  readonly name: string
  readonly __tag: unique symbol
}

interface EventView {
  of<T>(type: EventType<T>): readonly T[]
  emit<T>(type: EventType<T>, payload: T): void
}
```

### Time

```ts
interface TimeState {
  tick:             number   // integer, monotonic
  elapsed:          number   // seconds since start
  delta:            number   // seconds this tick
  scaledDelta:      number   // delta * scale, quantized to ms
  scale:            number   // 0 = paused
  fixedStep:        number   // seconds per fixed tick
  fixedAccumulator: number
}
```

### Snapshot

```ts
interface WorldSnapshot {
  readonly version:  number
  readonly seed:     readonly [number, number, number, number]
  readonly tick:     number
  readonly entities: ReadonlyArray<{
    id:         Entity
    components: Record<string, unknown>
  }>
  readonly meta?: Record<string, unknown>
}
```

### Plugin

```ts
interface Plugin {
  name:      string
  depends?:  readonly string[]
  provides?: readonly string[]
  install(world: World, options?: unknown): PluginHandle | void
}

interface PluginHandle {
  teardown?:    () => void
  onTickStart?: (world: World) => void
  onTickEnd?:   (world: World) => void
  onRender?:    (world: World) => void
  onSnapshot?:  (snap: WorldSnapshot) => WorldSnapshot
  onRestore?:   (snap: WorldSnapshot) => WorldSnapshot
}

interface Capability<K extends string> {
  readonly name: K
  // each provider augments this interface with its capability surface
}
```

**Capability surface convention (worked example).** `Capability<K>` is a marker; the provider exposes methods by **declaration merging** (TypeScript module augmentation) against the `Capability<K>` for its key. This keeps capability surfaces strongly typed at the consumer without a runtime registry of method signatures.

```ts
// ── in @domecs/physics ──────────────────────────────────────────────
declare module 'domecs' {
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

export const physicsPlugin: Plugin = {
  name: '@domecs/physics',
  provides: ['spatial-index'],
  install(world) {
    const index = new Quadtree(/* ... */)
    const cap = world.capability('spatial-index')
    ;(cap as any).query   = (b) => index.query(b)
    ;(cap as any).nearest = (x, y, r) => index.nearest(x, y, r)
  },
}

// ── in consumer code (e.g., @domecs/pathfinding) ────────────────────
const hits = world.capability('spatial-index').query({ x: 0, y: 0, w: 64, h: 64 })
//    ^? Entity[]  — the augmentation makes this fully typed
```

Rules: (1) one provider per capability name — `provides: ['spatial-index']` from two plugins is a registration error (§9.3). (2) Consumers list the key in `depends` (or `peerDepends`) and should not call `capability(name)` at `install` time before the provider has run; the plugin DAG (§9.2) guarantees provider order when `depends` is declared. (3) The augmentation lives in the provider package, not in application code — third-party capabilities stay self-contained.

---

## `domecs/input`

```ts
function createInput(world: World, options?: InputOptions): Plugin

interface InputOptions {
  target?: HTMLElement        // default: document
  gamepad?: boolean           // default: true
  preventDefault?: (e: Event) => boolean
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
  x: number; y: number
  buttons: number
  delta: { x: number; y: number }
  wheel: number
  entered: readonly Entity[]   // entities under pointer this tick
}

interface GamepadSnapshot {
  index: number
  axes: readonly number[]
  buttons: readonly { pressed: boolean; value: number }[]
}
```

---

## `domecs/dom`

```ts
function mountDOM(world: World, options: DomOptions): Plugin

interface DomOptions {
  slots: Record<string, HTMLElement>     // e.g. { stage: el, hud: el, portal: document.body }
  views: Record<string, ViewDefinition<unknown>>
}

interface ViewDefinition<T> {
  slot:         string
  query?:       QueryDef                  // default: Has(associatedComponent)
  virtualize?:  boolean
  shouldMount?: (entity: EntityView, viewport: Viewport) => boolean
  create(entity: EntityView): HTMLElement
  update(el: HTMLElement, entity: EntityView, prev: EntityView | null): void
  destroy?(el: HTMLElement, entity: EntityView): void
}

interface Viewport {
  rect: DOMRect
  scroll: { x: number; y: number }
}

// sugar: define a view bound to a single component
function defineView<T>(
  component: ComponentType<T>,
  def: Omit<ViewDefinition<T>, 'query'>
): ViewDefinition<T>
```

---

## `@domecs/sprites`

```ts
const Sprite = defineComponent<{
  sheet:     string
  frame:     number
  flipX?:    boolean
  flipY?:    boolean
  tintRgb?:  [number, number, number]
}>('Sprite')

const Animation = defineComponent<{
  clip:      string
  time:      number            // seconds into clip
  speed?:    number            // default 1
  loop?:     boolean           // default true
  paused?:   boolean
}>('Animation')

function createSpritesPlugin(options: {
  sheets: Record<string, SpriteSheetDef>
  clips?: Record<string, AnimationClip>
}): Plugin

interface SpriteSheetDef {
  url:      string
  frameW:   number
  frameH:   number
  cols:     number
  rows:     number
}

interface AnimationClip {
  sheet:    string
  frames:   number[]
  frameMs:  number
}
```

---

## `@domecs/persist`

```ts
function createPersistence(world: World, options: PersistOptions): Persistence

interface PersistOptions {
  database:  string
  version:   number
  codecs?:   Record<string, ComponentCodec<unknown>>
  autosave?: { everyMs?: number; everyTicks?: number; slot?: string }
}

interface ComponentCodec<T> {
  read:  (snapVersion: number, value: unknown) => T
  write: (value: T) => unknown
}

interface Persistence {
  save(slot: string): Promise<void>
  load(slot: string): Promise<void>
  list():             Promise<SaveSlot[]>
  remove(slot: string): Promise<void>
  export(slot: string): Promise<string>   // JSON string
  import(json: string, slot: string): Promise<void>
  autosave(options?: AutosaveOptions): () => void

  // time travel
  ringBuffer(options?: { size?: number; everyTicks?: number }): RingBuffer
}

interface RingBuffer {
  snapshots(): readonly WorldSnapshot[]
  scrubTo(tick: number): void
  clear(): void
}

interface SaveSlot {
  name:      string
  savedAt:   number
  tick:      number
  thumbnail?: string
}
```

---

## `@domecs/inspector`

```ts
function createInspector(options?: InspectorOptions): Plugin

interface InspectorOptions {
  slot?:     string                // default: 'chrome'
  hotkey?:   string                // default: 'F1'
  detect?:   {
    wallClock?: boolean            // default true in dev
    mathRandom?: boolean           // default true in dev
  }
}
```

---

## Framework integration

v0.1 ships no first-party framework adapters (see SPEC §11).  Integrate from user code by subscribing to `World.signals` and calling `world.markChanged(entity, type)` from systems that mutate components.  `snapshot()` is a structurally-cloneable handoff suitable for any framework's external store.

---

## Quick-start example (updated)

```ts
import { createWorld, defineComponent, Has } from 'domecs'
import { mountDOM, defineView } from 'domecs/dom'
import { createInput } from 'domecs/input'
import { Sprite, createSpritesPlugin } from '@domecs/sprites'

const Position = defineComponent<{ x: number; y: number }>('Position')
const Velocity = defineComponent<{ dx: number; dy: number }>('Velocity')

const world = createWorld({ seed: 0xC0FFEE })

world.use(createInput(world))
world.use(createSpritesPlugin({
  sheets: { hero: { url: '/hero.png', frameW: 16, frameH: 16, cols: 8, rows: 4 } },
}))
world.use(mountDOM(world, {
  slots: { stage: document.getElementById('stage')! },
  views: {
    sprite: defineView(Sprite, {
      slot: 'stage',
      create: () => {
        const el = document.createElement('div')
        el.className = 'sprite'
        return el
      },
      update: (el, e) => {
        el.style.transform = `translate(${e.Position.x}px, ${e.Position.y}px)`
        el.style.backgroundPosition = `-${e.Sprite.frame * 16}px 0`
      },
    }),
  },
}))

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

world.spawn({
  Position: { x: 100, y: 100 },
  Velocity: { dx: 30, dy: 0 },
  Sprite:   { sheet: 'hero', frame: 0 },
})

world.start()
```

Note: `world.markChanged` is explicit — this is the contract, not an adapter gap (SPEC §2.9). Prod is proxy-free: `markChanged` is an O(1) ring append. Dev builds piggyback on the I-1 proxy to warn on **mutation-without-mark** (default `'warn'`, configurable to `'throw'` for CI or `'off'` for prototyping) and can optionally hint on **mark-without-mutation** for optimizers (`dev: { markOveruse: 'hint' }`). Counters and a recent-offenders ring live at `world.diag.markChanged` for the inspector or custom dashboards.
