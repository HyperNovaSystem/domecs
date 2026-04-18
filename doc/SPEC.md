# DOMECS — Specification v0.1 (Draft)

**Status:** Draft. Incorporates the critique in `critique.md` and the exemplar requirements in `exemplars.md`. Source of truth until code ships; README supersedes only where marked.

**Scope:** this document specifies the *behavior* of DOMECS. The API surface is in `api.md`.

---

## 0. Design axioms

1. **The model is the game.**  DOMECS optimizes the ergonomics and performance of simulations that live in structured data, not pixel pipelines.
2. **The DOM is the renderer.**  Layout, text, input, accessibility, and scaling are delegated to the browser. The engine does not reimplement them.
3. **Entities are data.**  No classes, no inheritance, no lifecycle methods on entities. Behavior lives in systems.
4. **Determinism is a contract, not a feature.**  Where DOMECS promises determinism, it pays the cost (PRNG, time quantization, iteration order) everywhere.
5. **Pay for what you import.**  The core is usable without the renderer.  The renderer is usable without persistence.  Every subsystem ships as its own entry point.
6. **Worlds are plural.**  `createWorld()` may be called any number of times.  No global mutable state survives between worlds.

---

## 1. Packages and layering

```
domecs                 — core: World, entities, components, queries, systems, events, time
domecs/dom             — DOM renderer: views, mounting, diffing
domecs/input           — input collector: keyboard, pointer, touch, gamepad
@domecs/sprites        — sprite sheet components + frame animation (DOM renderer plugin)
@domecs/persist        — IndexedDB snapshot/restore, autosave, migrations
@domecs/inspector      — devtools panel, entity browser, time-travel scrubber
@domecs/worker         — off-main-thread simulation host (v0.3)
```

### Module dependency DAG

```
domecs (core)
 ├── domecs/input         (depends: core)
 ├── domecs/dom           (depends: core)
 │    ├── @domecs/sprites (depends: core, dom)
 │    └── @domecs/inspector (depends: core, dom; uses core reflection)
 ├── @domecs/persist      (depends: core)
 └── @domecs/worker       (depends: core)
```

No cycles.  Core is renderer-agnostic; the DOM renderer is framework-agnostic.

### Naming

- Display name: **DOMECS**.
- npm name: **`domecs`**. Scoped plugins under **`@domecs/…`**.
- Import: `import { createWorld } from 'domecs'`.

---

## 2. Core model

### 2.1 Entity

An entity is a non-negative integer id.  Ids are never reused within a world's lifetime (monotonic u53).  An entity has no methods; operations go through the world.

### 2.2 Component

A component *type* is defined once via `defineComponent<T>(name, defaults?)`.  Its return value is an opaque `ComponentType<T>` carrying a `Symbol` discriminator and the schema.

A component *instance* is a plain object attached to an entity via `world.addComponent(entity, type, value)`.  Component instances are **mutable in place**; systems write to their fields directly.

Component types are **serializable** by default.  If a schema includes non-clonable fields (functions, Promises, DOM nodes, weak refs), the component must declare itself **transient**, which excludes it from snapshots.

Component instances are **owned by the world**.

**Invariant (I-1 — tick-scoped references).**  A reference obtained from a query result, `world.getComponent`, or any adapter wrapper is valid *only within the tick that produced it*.  Consumers must not stash the reference across tick boundaries; they must copy the data they need, or re-query on the next tick.  This applies equally to vanilla systems, Svelte `$state` proxies, and React `useQuery` results — the framework adapters do not, and cannot, extend the lifetime of a component reference.

Dev builds enforce I-1 at runtime: component objects handed out of a query are wrapped in a proxy that is **poisoned** at tick-end (step 8), so a stale read in the next tick throws with the entity id and component type at the point of misuse.  Production builds skip the proxy for speed; the contract is the same.

### 2.3 World

A world owns: entities, component stores, archetype index, query cache, system scheduler, event buffer, time state, input state, plugins, and a PRNG.

Worlds are independent.  Two worlds never share mutable state.

### 2.4 Query

A query is a composable predicate over component presence and values:

- `Has(T)` — component type present.
- `Not(T)` — component type absent.
- `Or(A, B)` — either.
- `Changed(T)` — mutated this tick.
- `Added(T)` — added this tick.
- `Removed(T)` — removed this tick.
- `Where(T, predicate)` — component value matches predicate.

Queries are **archetype-cached**. A query computes an index the first time it is used; subsequent ticks reuse it. `onAdd` and `onRemove` hooks fire when entity composition changes in a way that enters or exits the query's archetype set.

**Complexity (normative).**  `Has` / `Not` / `Or` / `Added` / `Removed` / `Changed` are satisfied by the archetype cache in O(matching-entities) amortized — the cache tracks set membership, so iteration dominates.  `Where(T, predicate)` is **not** indexed: it runs the predicate against each entity in the matching archetype set every tick, at O(matching-archetype-entities) per tick regardless of how selective the predicate is.  Users who need value-based filtering in hot paths should model the filterable state as a **tag component** (e.g., `Dead`, `Burning`, `Selected`) and add it to the query via `Has` / `Not`, so archetype caching applies.  Reach for `Where` only when the predicate is cheap *and* the matching archetype set is small, or when the query runs off the hot path.

Change-detection filters (`Changed`, `Added`, `Removed`) apply only within a tick and are reset at the start of the next tick (step 0 of the tick order; see §4).

### 2.5 System

A system is a function receiving a `SystemContext`:

```ts
type System = (ctx: SystemContext) => void

interface SystemContext {
  entities: EntityView[]     // query result
  time:     TimeState        // tick-consistent
  input:    InputSnapshot    // tick-consistent
  events:   EventView        // tick-consistent; emit() schedules for next tick
  world:    WorldAPI         // spawn, despawn, component mutation
  rand:     Rng              // seeded per-world PRNG
  state:    unknown          // system-local slot; see SystemDef.state
}
```

Systems are registered with:

```ts
world.system(name, {
  query:     QueryDef,
  schedule:  'tick' | 'fixed' | 'event' | 'once' | 'reactive',
  priority?: number,         // lower runs first; default 0
  rateHz?:   number,         // fixed only
  triggers?: EventType[],    // event only
  reactsTo?: QueryDef,       // reactive only
  enabled?:  () => boolean,
  state?:    unknown,        // system-local; preserved across hot-swap (§9.5)
}, fn)
```

`state` is the system's private slot, readable and writable as `ctx.state` inside `fn`. It is preserved across dev-mode hot-swap (§9.5). It is **not** part of the world snapshot — on `restore()`, systems re-register and `state` resets. Closures over module-scope values are not preserved across hot-swap; swap-durable state must live in `state`.

### 2.6 Events

Events are typed messages.  Emitted events are **buffered** and flushed at step 1 of the next tick.  Event systems see a read-only view of the buffered events that match their `triggers`.

Events never carry live component references; they carry data or entity ids.

An event emitted during an event system's execution is delivered at step 1 of *the next tick* (not the same tick, not the end of the current tick).  This is the rule; it is not a surprise.

### 2.7 Time

```ts
interface TimeState {
  tick:          number    // integer, monotonic
  elapsed:       number    // seconds since world.start()
  delta:         number    // seconds since last tick
  scaledDelta:   number    // delta * scale (quantized to ms)
  scale:         number    // 0 = paused; 1 = real-time
  fixedStep:     number    // for fixed-schedule systems
  fixedAccumulator: number // internal
}
```

`scale = 0` disables `tick` and `fixed` systems; `event` systems still run (so UI responds to pause-menu events).

### 2.8 PRNG

`world.rand` is a seeded PRNG. Default algorithm: **xoshiro128**\*\*. The seed is part of the snapshot. `Math.random` must not be used by any authoritative system — the inspector warns on detection.

### 2.9 Change tracking

`world.markChanged(entity, type)` is the input to `Changed(T)` queries.  It is **explicit**: the core does not auto-detect component mutations.  The contract is the same in dev and prod; the difference is observability.

**Production builds.**  `markChanged` is an O(1) append to a per-archetype dirty ring.  `Changed(T)` reads from the ring at tick start (step 1).  No proxy, no write interception, no per-field version bookkeeping.

**Dev builds.**  The Invariant-I-1 proxy (§2.2) also records writes.  At tick end, before step 8 (poison), the world diffs *recorded mutations* against *recorded marks* and emits two signals:

- **`mutation-without-mark`** (default: `warn`).  A field on a component was written but `markChanged` was not called.  `Changed(T)` will miss this mutation.  Warning payload: `{ entity, type, field, systemName, stackHint }`.  Configurable to `'throw'` for CI, `'off'` for noisy prototyping.
- **`mark-without-mutation`** (default: `off`).  `markChanged` was called but no mutation was recorded on that entity/type.  Emitted as an *info-level hint* for optimizers hunting wasted marks; never on by default because defensive marking is a valid style.

Both signals also increment counters on `world.diag.markChanged` (`mutations`, `marks`, `unmarked`, `overmarked`, plus a bounded ring of recent offenders).  The inspector (§10) surfaces this tab; custom dashboards can read the same surface without scraping the console.

**Configuration** (see `api.md`, `WorldOptions.dev`):

```ts
dev?: {
  markWarn?:    'warn' | 'throw' | 'off'     // default: 'warn' in dev, forced 'off' in prod
  markOveruse?: 'hint' | 'off'               // default: 'off'
}
```

**Invariant (I-2 — explicit marks).**  `Changed(T)` returns exactly the set of entities for which `markChanged(e, T)` was called in the previous tick (after filtering by the query's component set).  It is a faithful report of marks, not a detector of mutations.  Missed marks are a caller bug; the dev-mode diagnostics exist to find them, not to paper over them.

This contract applies uniformly to vanilla, any post-v0.1 framework adapter, and the Worker boundary: an adapter that auto-marks (e.g., via a reactivity framework's own proxy) must still produce `markChanged` calls the core can see — adapters do not get a private fast path.

### 2.10 Signals

`World.signals` fields are `Signal<T>` instances with this contract:

```ts
interface Signal<T> {
  subscribe(fn: (e: T) => void): () => void    // returns unsubscribe
}
```

**Synchronous delivery.**  Subscribers run synchronously within the tick phase that emitted the signal — not queued, not microtask-deferred:

- `entitySpawned` / `entityDespawned` / `componentAdded` / `componentRemoved` fire on the call site of the structural change (inside `spawn`, `despawn`, `addComponent`, `removeComponent`).
- `tickStart` fires inside step 1; `tickEnd` fires inside step 8 (after the Invariant-I-1 proxy is poisoned).

A subscriber that throws propagates to the call site that emitted the signal; the world does not catch.

**Listener-gated.**  A signal with no subscribers does no bookkeeping.  `subscribe` and its returned unsubscribe function are O(1).

**Mutation during delivery.**  Subscribers added or removed during delivery take effect on the *next* emission of that signal.  Re-entrant emission (a subscriber triggers the same signal) delivers synchronously in emission order.

**Payload rule (normative).**  Signal payloads carry only entity ids, component *types*, and plain time data — never component references.  A subscriber that needs component state calls `world.getComponent(entity, Type)` within the same tick phase.  This keeps Invariant I-1 (§2.2) uniform: signals introduce no new reference-lifetime rules, and the dev-mode poisoned proxy does not need to wrap signal payloads.  Component references obtained via `getComponent` inside a subscriber are tick-scoped exactly as they would be inside a system — the step-8 poisoning applies to them without special-casing the signal site.

Corollary: `componentRemoved` delivers *before* the component's bag is released, so a subscriber may still call `getComponent(entity, type)` and receive the outgoing snapshot within that same phase.  After the emitting call site returns, the component is gone.

---

## 3. Scheduling modes

| Mode       | Fires on                                | Sees                                |
|------------|-----------------------------------------|-------------------------------------|
| `once`     | `world.start()` (first tick of world)   | initial input/time                  |
| `fixed`    | every `fixedStep` of scaled time        | integrated fixed delta              |
| `tick`     | every render frame                      | scaled delta                        |
| `event`    | events buffered from previous tick      | event view                          |
| `reactive` | query result changed (debounced to tick)| query delta (added/removed/changed) |

Priorities disambiguate within a mode.
Systems registered with the same priority run in **registration order**.

### Idle suspension

If there are no `tick` or `fixed` systems with non-empty queries, and no events are queued, the RAF loop stops.
It resumes on `world.emit()`, input, or `world.start()`.

### Headless mode

`createWorld({ headless: true })` disables RAF. `world.step(deltaSeconds)` advances one tick manually.
`world.stepN(steps)` advances N ticks. Used by tests, AI search, board game replay, server authority.

### Turn-based mode

Equivalent to headless with a thin driver: `world.turn(action)` emits the action as an event, calls `world.step()`, returns when systems have quiesced.
Roguelike default.

---

## 4. Tick order (normative)

At each tick:

0. **Reset per-tick state.** Clear change-detection flags (Added/Removed/Changed sets).
1. **Flush event buffer from last tick.** Events become readable by event systems.
2. **Collect input.** `InputCollector` snapshots keyboard, pointer, touch, gamepad, focus into `InputSnapshot`.
3. **Run `fixed` systems.** Zero or more steps to catch the accumulator up to scaled time.
4. **Run `tick` systems.** In priority order.
5. **Run `event` systems.** For events buffered in step 1. Events emitted during 3–4 were buffered for *next* tick.
6. **Run `reactive` systems.** For queries that changed in steps 3–5.
7. **Renderer diff and commit.** Views are diffed; DOM mutations batched.
8. **Increment `time.tick`.** Commit change-detection sets for next tick's step 0.

Events emitted in steps 5–6 are buffered for next tick.

---

## 5. Renderer (`domecs/dom`)

### 5.1 Views, not elements

An entity projects **zero-or-more views**. A view is a named slot + a renderer function:

```ts
interface View<T> {
  slot:    string               // 'stage', 'hud', 'portal', 'inspector'...
  target?: HTMLElement          // override root
  create(entity, component): HTMLElement
  update(el, entity, component, prev): void
  destroy(el, entity): void
}
```

A view is **bound to one or more component types**.
The renderer registry maps component types to views.

- Sprite view: one element on the `stage` slot.
- Nameplate view: one element on the `overlay` slot.
- Tooltip view: one element on the `portal` slot, created on hover event, destroyed on leave.

### 5.2 Unrendered entities are the default

An entity only mounts DOM if it matches at least one registered view's query.
An entity with no registered view is invisible and costs nothing.

### 5.3 Mount lifecycle

```
spawn entity
  → query matches view(s)
  → onAdd fires
  → view.create(entity) mounts element into slot
tick
  → component changes
  → view.update(element, entity, prev) on next commit
despawn or component removal
  → onRemove fires
  → view.destroy(element, entity) unmounts
```

Renderer commits are **batched** per slot. One DOM write per element per tick, regardless of how many components changed.

### 5.4 Style contract

Sprites and stage-slot views should mutate only `transform`, `opacity`, `background-position`, and CSS custom properties.
Anything else escapes the compositor and is documented as "slow-path."

### 5.5 Virtualization

Renderers may declare `virtualize: true`.
For such views, the renderer calls a `shouldMount(entity, viewport)` hook before `create()`.
This supports long sortable tables (`domecs/dom` ships a table-list view for this) and large stage viewports.

### 5.6 Portals and layers

Slots are named roots, registered at `mountDOM(world, { slots: {...} })` time. Standard slots:

- `stage` — game viewport.
- `hud` — overlaid on stage, ignores stage transform.
- `portal` — document body-level (tooltips, modals).
- `chrome` — outside the stage entirely (menus, inventory sidebars).

Applications register custom slots as needed.

---

## 6. Input (`domecs/input`)

- Keyboard: normalized to W3C `code` values; modifier state separated.
- Pointer: unified mouse/pen/touch via Pointer Events.
- Gamepad: polled per tick; snapshot includes all connected pads.
- Focus: active element and whether a text input consumes keys (prevents game keybindings from firing when typing in chat).

`InputSnapshot` is immutable within a tick. Systems read; they do not mutate.

Keybinding layer is *not* part of core — it is a plugin that translates `InputSnapshot` to high-level `Action` events.

---

## 7. Persistence (`@domecs/persist`)

### 7.1 Snapshot

```ts
interface WorldSnapshot {
  version:    number
  seed:       [number, number, number, number]  // PRNG state
  tick:       number
  entities:   { id: number; components: Record<string, unknown> }[]
  meta?:      Record<string, unknown>
}
```

`snapshot()` is a **synchronous**, coherent-world-at-tick-T structural clone. It is the explicit-save / export / determinism-test path. No transient components are included. The object is safe to `JSON.stringify` iff all component values are JSON-serializable; otherwise a structured-clone codec applies. At 50k entities the sync walk is O(entities × components) on the main thread — use it for user-initiated saves, not per-tick autosave.

### 7.2 Autosave — eventually consistent

Autosave is **not** a repeated sync `snapshot()`. It is an incremental, eventually-consistent writer:

```
per tick:
  collect dirty archetypes (components with markChanged since last drain)
  → enqueue a delta batch tagged { tick, archetype, entries }
drain:
  writer task [off-tick, microtask or idle]
    → apply batches to IndexedDB in tick order
    → commit partial batches atomically per archetype
```

Consistency guarantees:

- **Per-archetype atomicity.** Within one drained batch, an archetype is written whole or not at all. A partial batch at shutdown is either completed by the next session's writer on restore (if still in the queue) or dropped.
- **No global coherence.** A persisted world may reflect archetype A at tick T and archetype B at tick T+k, for small k bounded by drain latency. Systems that require cross-archetype invariants across a save boundary must either (a) live in one archetype, or (b) use explicit `snapshot()` for that save point.
- **Restore is forward-consistent.** `restore()` replays batches in tick order and discards any trailing partial tick, producing a coherent world at the last fully-drained tick.
- **No tick stall.** Enqueue cost per tick is O(dirty archetypes), not O(entities). The structural clone happens on the writer task, off-tick.

Explicit `snapshot()` remains the way to get a globally coherent world-at-T (manual save, export, determinism tests). Autosave trades global coherence for bounded per-tick cost, and that trade is not user-configurable at v0.1.

### 7.3 Migrations

```ts
createPersistence(world, {
  database: 'my-game',
  version:  3,
  codecs:   {
    Position: {
      read:  (snap, v) => snap.version >= 2 ? v : { x: v.x / 10, y: v.y / 10 },
      write: (v) => v,
    },
  },
})
```

Migrations are per-component, not per-world.
The codec system allows one component schema to evolve without forcing monolithic world-level migration.

### 7.4 Ring buffer (time-travel)

The inspector (§10) consumes a bounded ring buffer of **diff snapshots**: each entry records only the components that changed since the previous snapshot.
Memory is `O(changes)` not `O(entities × snapshots)`.

---

## 8. Determinism contract

DOMECS promises:

- **Given identical inputs, seed, and initial snapshot, the post-tick state is bit-identical across engines that correctly implement IEEE-754 arithmetic.**

This relies on:

- `world.rand` is the only PRNG used in authoritative systems.
- Systems do not read `Date.now()`, `performance.now()`, or wall-clock APIs.
- Iteration order of queries is deterministic (archetype order, then entity id).
- Transcendentals (`Math.sin`, `Math.cos`, `Math.tan`, `Math.exp`, `Math.log`, `Math.pow` with non-integer exponent) are **not** guaranteed bit-identical across JS engines; systems that require determinism must use fixed-point tables (`domecs/math` ships them as a plugin).
- `Map`/`Set` insertion order is preserved; object key order is insertion order for string keys.

The inspector can run an authoritative system in a sandbox and detect violations (PRNG, wall-clock, disallowed trig) by monkey-patching.

---

## 9. Plugins

### 9.1 Shape

```ts
interface Plugin {
  name:     string
  depends?: string[]           // plugin names required
  provides?: string[]          // capability keys exported (spatial index, etc.)
  install(world: World): {
    teardown?:     () => void
    onTickStart?:  (world: World) => void
    onTickEnd?:    (world: World) => void
    onRender?:     (world: World) => void
    onSnapshot?:   (snap: WorldSnapshot) => WorldSnapshot
    onRestore?:    (snap: WorldSnapshot) => WorldSnapshot
  } | void
}
```

### 9.2 Registration

```ts
world.use(plugin, options?)
```

Plugins install in topological order per `depends`.
Cycles throw at registration time.

### 9.3 Capability registry

Plugins expose capabilities on `world.capability(name)`.
Example:
- `@domecs/physics` provides `spatial-index` → `world.capability('spatial-index').query(bounds)`.
- `@domecs/pathfinding` depends on `spatial-index`.

### 9.4 Lifecycle plug points

| Hook        | Fires at                                |
|-------------|------------------------------------------|
| `onTickStart` | Step 0 of tick                        |
| `onTickEnd`   | Step 8 of tick                        |
| `onRender`    | After step 7 commits                  |
| `onSnapshot`  | Before persist writes                 |
| `onRestore`   | After snapshot loads, before resume   |

Plugins registered without any hooks fall back to the degenerate `(world) => teardown?` form.

### 9.5 Hot-swap (dev only)

Dev builds expose `SystemHandle.replaceFn(fn: System): void`. It swaps a system's function in place while preserving:

- the `SystemDef` (query, schedule, priority, rateHz, triggers, reactsTo, enabled)
- the `state` slot (§2.5)
- the subscription set (archetype caches, event-type subscriptions, reactive query membership)

The swap lands at step 0 of the next tick, never mid-tick. Ordering with other tick-boundary work: hot-swap happens before event-buffer flush (step 1), so the replacement `fn` is the one that observes this tick's events.

If the new `fn`'s intent needs a different `SystemDef` (new query shape, changed `reactsTo`, different `schedule`), the swap is refused with an error; the caller must `remove()` the handle and re-register. The seam does not reconcile shape changes.

Production builds omit `replaceFn` entirely (it is not just a no-op — the method is absent so HMR client code tree-shakes in prod). Worker-hosted systems (§12) never accept hot-swap: system functions are closures, and closures are not structured-cloneable.

DOMECS ships no HMR client itself. `replaceFn` is the seam a bundler's HMR glue (or `@domecs/inspector`'s manual-reload control) invokes. The expected dev-loop shape: the bundler re-evaluates the module, hands the new `fn` to `replaceFn`, and the world keeps its entities, components, time, and PRNG state.

---

## 10. Inspector (`@domecs/inspector`)

A plugin.
When installed, it:
- Mounts a side panel (default slot `chrome`, user-overridable).
- Enumerates all `componentTypes()` and renders a per-entity editor.
- Subscribes to the snapshot ring buffer; exposes a scrubber.
- Detects determinism violations (wall-clock reads, `Math.random` calls) via monkey-patching in dev builds.
- Displays archetype set membership per entity, pinpointing composition churn.

The inspector is **not** part of core; production builds omit it.

---

## 11. Framework integration

**v0.1 ships no first-party framework adapters.**  Vanilla is the only supported path, the reference implementation, and the shape the rest of the spec is optimized around.

The integration surface is:

- `World.signals` (listener-gated, see `api.md`) — subscribe from any reactive system to be notified of entity/component/tick events.
- `world.markChanged(entity, type)` — explicit change tracking, the input to `Changed(T)` queries.
- `WorldSnapshot` — structural clone suitable for any store that can hold a plain object.

Any framework (Svelte, React, Solid, Vue, Lit, or vanilla DOM) can layer on top by subscribing to signals and mapping them into its own reactivity model.  Such integrations are **user code**, not core, not blessed, not versioned in lockstep with DOMECS.

### 11.1 Why no adapters in v0.1

- **Scope.**  Two adapters × two reactivity models doubles the surface the spec has to defend.  v0.1 picks one path and proves it.
- **Honesty.**  A Svelte `$state`-wrapped component store is not the same object as a vanilla component instance; systems written against one do not trivially port to the other.  Tiered adapters hid that asymmetry behind a marketing story.
- **Invariant I-1.**  The cross-tick reference rule (§2.2) is uniform for vanilla.  Adapter-wrapped references introduce per-adapter lifetime questions; deferring them lets the invariant stay simple.
- **`markChanged` is the API.**  With no "auto-detect in Svelte" alternative, explicit marking is not an ergonomics regression — it is the contract (see §2.9 for the full change-tracking contract and the dev-mode `mutation-without-mark` / `mark-without-mutation` diagnostics).  This closes the `Changed(T)` correctness question by removing the branch where discipline varies.

### 11.2 What ships after v0.1

Framework adapters are a **post-v0.1 question**, reopened once the core shape has stabilized through at least one exemplar and external users have shown which reactivity mapping is actually needed.  When they ship, they will be separate packages under `@domecs/*` and will honor the same invariants as vanilla — they cannot extend a component reference's lifetime, cannot bypass `markChanged`, and cannot pretend to be free.

---

## 12. Worker host (`@domecs/worker`, v0.3 target)

Design implications locked in at v0.1 so the core stays compatible:

- Component values must be structured-cloneable.
- Systems must not close over DOM references.
- `emit()` and `world.spawn()` work across the Worker boundary via message passing.
- The renderer runs on the main thread; simulation runs in the worker; snapshots are passed by structured clone (or SharedArrayBuffer where available).

v0.1 does not ship Workers but does not block them.

---

## 13. Bundle size

There is no fixed-byte target in this specification.
Each published package measures and publishes its own min+gzip size.

---

## 14. Testing

- Core and persistence must have full feature coverage.
- Every exemplar in `doc/exemplars.md` has a corresponding `examples/` project that CI builds and smoke-tests.
- Determinism is tested by running two worlds in parallel with identical seed+inputs and asserting byte-identical snapshots.
- Renderer is tested via `@testing-library/dom`.

Headless mode (§3) makes system tests fast and framework-free.

---

## 15. Versioning and stability

- v0.x: unstable. APIs may change between minor versions. Breaking changes called out in CHANGELOG.
- v1.0: API freeze for `domecs`, `domecs/dom`, `@domecs/persist`. Other packages may lag.
- Deprecations: minimum two minor releases of warning with a migration guide.

---

## 16. Non-goals

- Twin-stick or bullet-hell action games — DOMECS is the wrong tool.
- 3D — use a real 3D engine; DOMECS may complement it by hosting UI.
- Server-authoritative networking with lockstep — planned via worker + rollback (v1+), not at v0.1.
- A visual DSL or editor as a required tool — DOMECS Studio (exemplar #6) is optional.

---

## 17. Cross-references

- `critique.md` — design flaws in the README proposal and the corrections applied here.
- `exemplars.md` — six applications whose requirements shaped v0.1.
- `api.md` — concrete type and function signatures (next document).
