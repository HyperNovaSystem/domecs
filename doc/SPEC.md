# DOMECS — Specification v0.1 (Draft)

**Status:** Draft. Incorporates the critique in `critique.md` and the exemplar requirements in `exemplars.md`. Source of truth until code ships; README supersedes only where marked.

**Scope:** this document specifies the *behavior* of DOMECS. The API surface is in `api.md`.

---

## 0. Design axioms

0. **Assume AI-assisted usage**  DOMECS assumes developers are AI-augmented and optimizes for that mode.  The core API will be discoverable and ergonomic for introspection and generation by AI+human agents.
1. **The model is the app.**  DOMECS optimizes the ergonomics and performance of simulations that live in structured data, not pixel pipelines.
2. **The DOM is the renderer.**  Layout, text, input, accessibility, and scaling are delegated to the browser. The engine does not reimplement them.
3. **Entities are data.**  No classes, no inheritance, no lifecycle methods on entities. Behavior lives in systems.
4. **Determinism is a contract, not a feature.**  Where DOMECS promises determinism, it pays the cost (PRNG, time quantization, iteration order) everywhere.
5. **Pay for what you import.**  The core is usable without the renderer.  The renderer is usable without persistence.  Every subsystem ships as its own entry point.
6. **Worlds are plural.**  `createWorld()` may be called any number of times.  No global mutable state survives between worlds.

---

## 1. Packages and layering

```
@domecs/core           — core: World, entities, components, queries, systems, events, time
@domecs/dom            — DOM renderer: views, mounting, diffing
@domecs/input          — input collector: keyboard, pointer, touch, gamepad
@domecs/sprites        — sprite sheet components + frame animation (DOM renderer plugin)
@domecs/persist        — IndexedDB snapshot/restore, autosave, migrations
@domecs/inspector      — devtools panel, entity browser, time-travel scrubber
@domecs/worker         — off-main-thread simulation host (v0.3)
```

### Module dependency DAG

```
@domecs/core
 ├── @domecs/input        (depends: core)
 ├── @domecs/dom          (depends: core)
 │    ├── @domecs/sprites (depends: core, dom)
 │    └── @domecs/inspector (depends: core, dom; uses core reflection)
 ├── @domecs/persist      (depends: core)
 └── @domecs/worker       (depends: core)
```

No cycles.  Core is renderer-agnostic; the DOM renderer is framework-agnostic.

### Headless and import-time safety

First-release packages must be safe to import under plain Node with no browser
globals installed. `@domecs/core` is the authoritative headless runtime:
`createWorld({ headless: true })` plus explicit `world.step(dt)` must run
without `window`, `document`, `navigator`, `requestAnimationFrame`, or
`cancelAnimationFrame`. `World.start()` remains browser-only and must throw a
clear error when rAF is unavailable or when the world was created with
`headless: true`.

Browser-adjacent packages may depend on DOM types and caller-provided DOM
objects, but they must not read a live `document` at module evaluation time.
`@domecs/dom` requires explicit slots when mounting; importing it in Node is a
no-op. `@domecs/input` may be installed in Node; with no default DOM targets it
publishes empty input snapshots and registers no event listeners.

### Naming

- Display name: **DOMECS**.
- Official npm scope: **`@domecs`**.
- All first-party runtime packages publish under `@domecs/*`.
- First-release package map: core is **`@domecs/core`**, DOM renderer is
  **`@domecs/dom`**, and input collector is **`@domecs/input`**.
- Import: `import { createWorld } from '@domecs/core'`.

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

v0.1 treats I-1 as a caller contract, not as a proxy-enforced runtime feature. Stale-reference poisoning is deferred until the diagnostics surface is designed, so the current core does not expose a dev/prod split for component wrapper behavior.

### 2.3 World

A world owns: entities, component stores, archetype index, query cache, system scheduler, event buffer, time state, input state, plugins, and a PRNG.

Worlds are independent.  Two worlds never share mutable state.

### 2.4 Query

A query is a composable predicate over component presence and values. Queries are built from two kinds of nodes (normative):

**Component shortcuts** carry a single `ComponentType` and produce a leaf node:

- `Has(T)` — component type present on the entity.
- `Changed(T)` — `markChanged(e, T)` was called in the previous tick.
- `Added(T)` — component type was added in the previous tick.
- `Removed(T)` — component type was removed in the previous tick.
- `Where(T, predicate)` — component is present and `predicate(value)` is true.

**Predicate combinators** carry one or more child `QueryNode`s and compose them:

- `Not(node)` — true when `node` is false. Unary.
- `And(...nodes)` — true when every child is true. N-ary.
- `Or(...nodes)` — true when any child is true. N-ary.

The combinators MUST also accept a bare `ComponentType` as a one-arg shortcut for `Has(T)`, so that `Not(Player) ≡ Not(Has(Player))`, `And(Position, Velocity) ≡ And(Has(Position), Has(Velocity))`, etc. This is purely an ergonomic widening; the produced `QueryNode` is identical in either form.

A node MUST be well-formed: its runtime payload must match its declared `kind`. Engine implementations MUST reject a node whose payload disagrees with its kind (statically via a discriminated union; in dev builds, additionally at runtime). A combinator presented with neither a `QueryNode` nor a `ComponentType` is a contract violation, not a constant-true predicate.

Queries are **archetype-cached**. A query computes an index the first time it is used; subsequent ticks reuse it. `onAdd` and `onRemove` hooks fire when entity composition changes in a way that enters or exits the query's archetype set.

**EntityView shape (normative, P-1).** An `EntityView` exposes exactly the
components currently attached to the entity — it MUST NOT carry keys for
component types the entity does not hold. The engine derives the view from
the entity's *archetype*, not from a sweep of every registered store;
unrelated component types in other entities must not bleed into the view
or contribute to its per-read cost.

**EntityView caching (normative, P-2).** Within a stable archetype the
engine reuses a single `EntityView` object per entity across query reads:
two reads of `query.entities` on consecutive lines, or by two distinct
systems within the same tick, MUST return the same view object instance
for the same entity id. The cached view is invalidated when:

- the entity gains or loses a component (`addComponent` / `removeComponent`
  / `despawn`-induced reclaim), or
- the world is restored from a snapshot.

Component *values* are mutated in place by systems and through
`world.getComponent`, so per-value invalidation is unnecessary: the cached
view holds the same store references the live world does. Callers MUST NOT
rely on view identity *across* archetype changes; that is exactly when the
view is rebuilt.

**EntityView typing (normative, D-2).** Tuple-form queries
(`world.query([Position, Velocity] as const)`) MUST produce a
`QueryResult` whose `EntityView` carries typed component fields keyed by
each component's literal name. Combinator-form queries
(`Has`/`And`/`Or`/`Not`/`Changed`/…) fall back to the unconstrained
`EntityView` shape; callers either narrow at the call site or read
component values through `world.getComponent`, which already carries
typed `T`. Component types that need their literal name preserved by
TypeScript MUST be declared with both type parameters
(`defineComponent<T, 'Name'>('Name')`) — the single-arg form
`defineComponent<T>('Name')` continues to work but widens the `Name`
parameter to `string`, and views built from such types fall back to the
unconstrained `EntityView` shape.

**Complexity (normative).**  `Has` / `Not` / `And` / `Or` / `Added` / `Removed` / `Changed` are satisfied by the archetype cache in O(matching-entities) amortized — the cache tracks set membership, so iteration dominates.  `Where(T, predicate)` is **not** indexed: it runs the predicate against each entity in the matching archetype set every tick, at O(matching-archetype-entities) per tick regardless of how selective the predicate is.  Users who need value-based filtering in hot paths should model the filterable state as a **tag component** (e.g., `Dead`, `Burning`, `Selected`) and add it to the query via `Has` / `Not`, so archetype caching applies.  Reach for `Where` only when the predicate is cheap *and* the matching archetype set is small, or when the query runs off the hot path.

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

**Between-tick mutations.** Component mutations and `markChanged` calls made *outside* a running system (e.g. from input callbacks or signal handlers between `step()` calls) are buffered and become visible to systems at the *next* tick — see §2.9 buffer-and-swap rule. Reactive systems thus observe both in-tick and between-tick marks uniformly, separated only by tick boundaries.

### 2.6 Events

Events are typed messages.  Emitted events are **buffered** and flushed at step 1 of the next tick.  Event systems see a read-only view of the buffered events that match their `triggers`.

Events never carry live component references; they carry data or entity ids.

An event emitted during an event system's execution is delivered at step 1 of *the next tick* (not the same tick, not the end of the current tick).  This is the rule; it is not a surprise.

### 2.7 Time

```ts
interface TimeState {
  tick:          number    // integer, monotonic
  elapsed:       number    // seconds since world.start() (ms-quantized)
  delta:         number    // seconds since last tick (raw, unquantized)
  scaledDelta:   number    // ms-quantized; see drift-free rule below
  scale:         number    // 0 = paused; 1 = real-time
  fixedStep:     number    // for fixed-schedule systems
  fixedAccumulator: number // internal; remainder of unquantized scaled time
}
```

`scale = 0` disables `tick` and `fixed` systems; `event` systems still run (so UI responds to pause-menu events).

**Scale-control rule (normative, D-3).** `world.setScale(0)` is observationally
equivalent to `world.pause()`: scale falls to 0 and `tick` / `fixed` systems
halt. `world.setScale(x > 0)` always updates the engine's stored
*pre-pause scale*, so a subsequent `world.resume()` restores the most recent
positive scale — regardless of whether the world is currently paused. As a
corollary, `setScale(x > 0)` on a paused world resumes to `x` without a
separate `resume()` call. Negative and non-finite scales (NaN, ±Infinity)
MUST throw. This collapses the previous footgun where `setScale(0)` outside
of `pause`/`resume` silently corrupted the pre-pause target.

**Drift-free quantization rule (normative).** `scaledDelta` is ms-quantized so that the snapshot wire format and replay reproduce per-frame values exactly across machines. The quantization, however, MUST NOT entangle the fixed-step scheduler (§3 / §4 step 3): per-frame ms rounding accumulates ~2 % drift per second at non-ms-exact `fixedStep` values such as `1/60`. The implementation MUST therefore:

1. Maintain an internal cumulative *unquantized* scaled-time total.
2. Derive each tick's `scaledDelta` from the difference between the cumulative total's ms-rounded value and the previous tick's ms-rounded value (so per-tick `scaledDelta` is ms-aligned, but the running total is exact).
3. Drive the fixed-step accumulator off the unquantized cumulative total (so the count of fixed steps fired in any time window equals `floor(cumulative / fixedStep)`, with no rounding drift).

Result: `scaledDelta` keeps its §7 wire-format guarantee, and a `fixed` system at `rateHz = baseHz` fires exactly `N` times in `N * fixedStep` seconds of scaled time — at any `fixedStep`, ms-exact or not.

**Positive-floor rule (normative, F-6).** When `step(dt)` is called with a positive wall-clock `dt` and the world is not paused (`time.scale !== 0`), the per-tick ms-quantized dt MUST NOT be zero — it MUST be raised to a minimum of 1 ms (i.e. `scaledDelta >= 1e-3`). Without this, sub-ms wall-clock frames (common on high-refresh monitors) produce `scaledDelta = 0`, which yields `NaN` in any controller that divides by dt (PIDs, rate estimators, first-order smoothing filters). The floor applies only to the per-tick *published* value: the internal cumulative unquantized total is unchanged, so §2.7's drift-free guarantee still holds across any window that contains at least one normally-sized frame. The floor is bypassed when the caller explicitly requests a no-op heartbeat (§4 step 0 exception below) — a positive dt is the signal that real time elapsed.

### 2.8 PRNG

`world.rand` is a seeded PRNG. Default algorithm: **xoshiro128**\*\*. The seed is part of the snapshot. `Math.random` must not be used by any authoritative system — the inspector warns on detection.

### 2.9 Change tracking

`world.markChanged(entity, type)` is the input to `Changed(T)` queries. It is **explicit**: the core does not auto-detect component mutations. In v0.1 the path is proxy-free in every build: `markChanged` records the entity/type pair for the next tick's change filters, with no write interception, no per-field version bookkeeping, no `WorldOptions.dev`, and no `world.diag` surface.

Post-v0.1 diagnostics may warn about mutation-without-mark or mark-without-mutation patterns through a plugin or inspector surface, but those warnings must not change `Changed(T)` semantics. Missed marks remain caller bugs; extra defensive marks remain legal.

**Invariant (I-2 — explicit marks).**  `Changed(T)` returns exactly the set of entities for which `markChanged(e, T)` was called in the previous tick (after filtering by the query's component set).  It is a faithful report of marks, not a detector of mutations.  Missed marks are a caller bug; future diagnostics may help find them, but the core does not paper over them.

This contract applies uniformly to vanilla, any post-v0.1 framework adapter, and the Worker boundary: an adapter that auto-marks (e.g., via a reactivity framework's own proxy) must still produce `markChanged` calls the core can see — adapters do not get a private fast path.

**Buffer-and-swap rule (normative).** `markChanged`, `addComponent`, `removeComponent`, and `despawn` may be called *outside* a running system — between `step()` calls, from signal handlers, from input callbacks, from plugin lifecycle hooks. Such between-tick writes MUST be captured into a *pending* set distinct from the live tick set, and promoted into the live set at step 0 of the next tick. This is symmetric with the event buffer (§2.6): both sources land in pending storage between ticks and are made visible at the start of the next tick.

The implementation maintains an `inTick` flag for the duration of steps 1–8: writes during a tick land in the live set (visible to step 6 reactive systems within the same tick); writes outside a tick land in the pending set (visible to next tick's step 6). Step 0 first clears the live set, then drains pending into it. As a corollary, a between-tick `markChanged` call and a step-3-system `markChanged` call are observationally indistinguishable to a reactive system one tick later — only the timing of the surrounding `step()` call separates them.

### 2.10 Signals

`World.signals` fields are `Signal<T>` instances with this contract:

```ts
interface Signal<T> {
  subscribe(fn: (e: T) => void): () => void    // returns unsubscribe
}
```

**Synchronous delivery.**  Subscribers run synchronously within the tick phase that emitted the signal — not queued, not microtask-deferred:

- `entitySpawned` / `entityDespawned` / `componentAdded` / `componentRemoved` fire on the call site of the structural change (inside `spawn`, `despawn`, `addComponent`, `removeComponent`).
- `tickStart` fires inside step 1; `tickEnd` fires inside step 8 after tick-end bookkeeping.

A subscriber that throws propagates to the call site that emitted the signal; the world does not catch.

**Listener-gated.**  A signal with no subscribers does no bookkeeping.  `subscribe` and its returned unsubscribe function are O(1).

**Mutation during delivery.**  Subscribers added or removed during delivery take effect on the *next* emission of that signal.  Re-entrant emission (a subscriber triggers the same signal) delivers synchronously in emission order.

**Payload rule (normative).**  Signal payloads carry only entity ids, component *types*, and plain time data — never component references.  A subscriber that needs component state calls `world.getComponent(entity, Type)` within the same tick phase.  This keeps Invariant I-1 (§2.2) uniform: signals introduce no new reference-lifetime rules, and signal payloads need no component wrappers.  Component references obtained via `getComponent` inside a subscriber are tick-scoped exactly as they would be inside a system.

Corollary: `componentRemoved` delivers *before* the component's bag is released, so a subscriber may still call `getComponent(entity, type)` and receive the outgoing snapshot within that same phase.  After the emitting call site returns, the component is gone.

**Despawn ordering rule (normative, F-9).** `entityDespawned` MUST fire *after* the engine has reclaimed the entity: by the time a subscriber runs, `world.has(id, T)` returns `false` for every component, the entity is no longer alive, and `getComponent(id, T)` returns `undefined`. Subscribers thus receive a clean reverse-index opportunity — the canonical pattern for inter-entity references is to register one `signals.entityDespawned` listener that scrubs every component holding the dying id as a foreign key. The order within a single `despawn` call is fixed: `componentRemoved` (per type, with bag still readable) → store/archetype reclaim → `entityDespawned`. A subscriber that calls `world.despawn` re-entrantly is well-defined; ordering of nested despawns is the call order of the subscribers.

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

### Fixed-rate rule (normative)

All `fixed` systems share the **single** world-level accumulator driven by `TimeState.fixedStep` (§2.7). `SystemDef.rateHz` does **not** give a system its own accumulator; it is a **subsampling divisor** over the shared fixed step.

Concretely, let `baseHz = 1 / fixedStep` (e.g., 60 for a 16.667 ms step). A system's `rateHz` must satisfy `baseHz % rateHz === 0` — the divisor `d = baseHz / rateHz` must be a positive integer. The system runs on every `d`-th fixed step. Omitting `rateHz` is equivalent to `rateHz = baseHz` (runs every fixed step).

Non-divisor rates are **rejected at `world.system(...)` registration time** with a thrown error. This preserves the single-accumulator determinism story (§8): the tick order in step 3 is fully determined by `fixedStep`, and every `fixed` system's firing schedule is fixed integer-deterministic against that one accumulator.

The accumulator MUST follow the §2.7 drift-free rule: it advances against the unquantized cumulative scaled-time total, not against the per-tick ms-quantized `scaledDelta`. This guarantees that an `N`-Hz system fires exactly `N` times in `N * fixedStep` seconds at every `fixedStep`, ms-exact or not (e.g., `1/60`).

Rationale: multiple independent accumulators would multiply the state that snapshot/restore (§7) must preserve and would open ordering questions when two systems' steps fall on the same frame. One accumulator + integer divisors keeps the model single-threaded and replayable.

### Idle suspension

If there are no enabled `tick`/`fixed` systems that require continuous
frames, no unfired `once` systems, no pending component work, and no queued
events, the RAF loop sleeps.
It resumes on external `world.emit()`, structural component mutations /
`markChanged`, input activity through `@domecs/input`, `resume()`, an
explicit `world.start()`, or a call to `world.requestTick()`.

**External wake API (normative, D-4).** External event sources that mutate
world state from outside a tick — input plugins, WebSocket feeds, custom
drivers — MUST rouse the idle loop by calling `world.requestTick()`. The
call is a no-op when the realtime driver is not running, when `idle: false`,
or when already inside a tick. `requestTick` is the *only* supported wake
path; reaching into engine-private members (such as the deprecated
`world.__wake` alias, kept for one release cycle only) is not contractual.

### Headless mode

`createWorld({ headless: true })` disables the realtime driver. `world.start()`
MUST throw even if the host environment exposes `requestAnimationFrame`;
`world.step(deltaSeconds)` advances one tick manually.
`world.stepN(steps)` advances N ticks. Used by tests, AI search, board game replay, server authority.

### Turn-based mode

Equivalent to headless with a thin driver: `world.turn(action)` emits the action as an event, calls `world.step()`, returns when systems have quiesced.
Roguelike default.

---

## 4. Tick order (normative)

### 4.0 `step(dt)` heartbeat exception (F-6, normative)

An **explicit** call of `step(0)` (or any non-positive `dt`) is a *heartbeat*, not a tick. The implementation MUST:

1. Leave `time.tick`, `time.elapsed`, and all change-detection buffers (live and pending) unchanged.
2. Set `time.delta = 0` and `time.scaledDelta = 0`.
3. Skip steps 3–6 entirely — no `fixed`, `tick`, `event`, or `reactive` systems run.
4. Still fire plugin `onTickStart`, `onRender`, `onTickEnd`, and the `tickStart`/`tickEnd` signals, in the same order as a normal tick, so UIs can paint initial state and input plugins can republish input snapshots.

A heartbeat is idempotent: any number of consecutive `step(0)` calls leave the world state identical to the moment the first one was invoked. Change-detection buffers marked via external `markChanged` calls *before* a heartbeat are preserved and promoted normally by the next positive `step(dt)`.

**Legacy carve-out.** A no-argument `step()` call (`dt === undefined`) is *not* a heartbeat — it advances a tick with `time.delta = 0` for backwards compatibility with turn-based exemplars. Turn-based callers should use `turn(event, payload)` (which invokes `step()` internally) rather than passing literal zero. Code that wants explicit "do nothing now but keep the UI alive" behavior MUST pass `0` explicitly.

### 4.1 Normal tick order

For each `step(dt)` with `dt > 0` (or `step()` with no argument — see §4.0):

0. **Reset per-tick state.** Clear the live Added/Removed/Changed sets, then drain pending between-tick writes into them (per §2.9 buffer-and-swap rule). After this step, the live sets contain exactly the structural changes / `markChanged` calls that occurred since the previous tick's step 0, regardless of whether they came from systems or external callers.
1. **Flush event buffer from last tick.** Events become readable by event systems.
2. **Collect input.** `InputCollector` snapshots keyboard, pointer, touch, gamepad, focus into `InputSnapshot`.
3. **Run `fixed` systems.** Zero or more steps to catch the accumulator up to scaled time.
4. **Run `tick` systems.** In priority order.
5. **Run `event` systems.** For events buffered in step 1. Events emitted during 3–4 were buffered for *next* tick.
6. **Run `reactive` systems.** For queries that changed in steps 3–5. Debouncing rule (normative): multiple component mutations within one tick that hit the same reactive system's `reactsTo` query **coalesce into one invocation** with a combined delta (the union of added/removed/changed entity sets observed across steps 3–5). A reactive system sees each entity at most once per tick. If a reactive system's execution mutates state that would re-trigger a reactive system earlier in priority order within this same step 6, the re-trigger is **deferred to the next tick's step 6** — the tick does not iterate to a fixed point. This matches the event-buffering rule in §2.6.

   **`reactsTo` contract (F-5, normative).** A reactive system's `reactsTo` query MUST contain at least one change-detection node (`Added`, `Removed`, or `Changed`), optionally composed with `Has` / `Not` / `And` / `Or` / `Where` as filters. A `reactsTo` query composed entirely of structural predicates (e.g. `Has(Player)`) is a contract violation and engine implementations MUST reject it at `world.system(...)` registration time with a thrown error. Rationale: reactive semantics are edge-triggered ("fire when the query result changes"); a structural-only query has no tick-scoped edge, so the only well-defined behavior would be level-triggered ("fire every tick while non-empty"), which is what `tick` + `enabled: () => q.size > 0` already expresses. The change-detection requirement makes the fire-on-change contract intrinsic to the query rather than dependent on user convention.
7. **Renderer diff and commit.** Views are diffed; DOM mutations batched.
8. **Increment `time.tick`.** Commit change-detection sets for next tick's step 0.

Events emitted in steps 5–6 are buffered for next tick.

---

## 5. Renderer (`@domecs/dom`)

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

**Update gating rule (normative, P-3).** A view's `update` callback is gated
by a per-view set of *redraw triggers*:

1. If `ViewDef.changedOn` is **omitted** (default), the renderer derives
   the set from every `Has(T)` leaf in the view's `query` — explicitly
   negated branches (`Not(...)`) are excluded. A view over
   `[Position, Velocity]` thus auto-redraws when either component is
   marked changed.
2. If `ViewDef.changedOn` is an **explicit empty array** (`changedOn: []`),
   the renderer falls back to the legacy "redraw every tick" behaviour.
   Useful for time-driven animations whose view depends on `time.elapsed`
   rather than component identity.
3. If `ViewDef.changedOn` is an **explicit non-empty array**, redraws are
   gated on exactly that set, ignoring whatever the query implies. Used
   for finer-grained narrowing.

`onAdd` (initial mount) and `onRemove` (final unmount) are not subject to
this gate; `create` and `destroy` always fire regardless of `changedOn`.

### 5.4 Style contract

Sprites and stage-slot views should mutate only `transform`, `opacity`, `background-position`, and CSS custom properties.
Anything else escapes the compositor and is documented as "slow-path."

### 5.5 Virtualization

Renderers may declare `virtualize: true`.
For such views, the renderer calls a `shouldMount(entity, viewport)` hook before `create()`.
This supports long sortable tables (`@domecs/dom` ships a table-list view for this) and large stage viewports.

### 5.6 Portals and layers

Slots are named roots, registered at `mountDOM(world, { slots: {...} })` time. Standard slots:

- `stage` — app viewport.
- `hud` — overlaid on stage, ignores stage transform.
- `portal` — document body-level (tooltips, modals).
- `chrome` — outside the stage entirely (menus, inventory sidebars).

Applications register custom slots as needed.

**Slot-collision policy (normative).** Slot *mounting* (via `mountDOM({ slots: {...} })`) is exclusive: attempting to mount a second root to an already-mounted slot name **throws** at `mountDOM` call time. View *registration*, by contrast, is additive: any number of views from any number of plugins may target the same slot name, and the renderer **appends** elements into that slot in registration order. This is the same rule as §5.1's entity→zero-or-more-views — multiple views per slot are already legal; §5.6 makes it explicit that cross-plugin overlap is not a conflict. Ordering within a slot is registration order; plugins that care about z-order should stack layers via named sub-slots (e.g., `chrome:menu`, `chrome:toasts`) rather than racing against each other on a shared slot.

---

## 6. Input (`@domecs/input`)

- Keyboard: normalized to W3C `code` values; modifier state separated.
- Pointer: unified mouse/pen/touch via Pointer Events.
- Gamepad: polled per tick; snapshot includes all connected pads.
- Focus: active element and whether a text input consumes keys (prevents app keybindings from firing when typing in chat).

`InputSnapshot` is immutable within a tick. Systems read; they do not mutate.

v0.1 pointer coordinates are raw DOM event client coordinates. Target-relative normalization, hit-tested entity enter/leave tracking, and higher-level action mapping are deferred to the next input milestone or app-level plugins.

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

`restore(snap)` is a trusted authored-snapshot path in v0.1. Restore rehydrates name-keyed component bags and depends on user code to register matching `ComponentType` objects before those components are queried or mutated. The snapshot does not carry rich schema metadata or component signals, and restore does not run `ComponentOptions.validate`; strict validation, unknown-component reporting, and metadata-backed restore belong to the future persistence/reflection work.

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
  database: 'my-domecs-app',
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
- Transcendentals (`Math.sin`, `Math.cos`, `Math.tan`, `Math.exp`, `Math.log`, `Math.pow` with non-integer exponent) are **not** guaranteed bit-identical across JS engines; systems that require determinism must use fixed-point tables (`@domecs/math` ships them as a plugin).
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

Source/dev builds expose `SystemHandle.replaceFn(fn: System): void`. It swaps a system's function in place while preserving:

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
- **`markChanged` is the API.**  With no "auto-detect in Svelte" alternative, explicit marking is not an ergonomics regression — it is the contract (see §2.9 for the full change-tracking contract).  This closes the `Changed(T)` correctness question by removing the branch where discipline varies.

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
- Every exemplar in `doc/exemplars.md` has a corresponding `example/` project or `HyperNovaSystem` app repository that CI builds and smoke-tests.
- Workspace examples validate source interop through `workspace:*`; release validation must also stage clean app copies against packed/published `@domecs/*` packages and run their normal `test` and static `build` scripts.
- Determinism is tested by running two worlds in parallel with identical seed+inputs and asserting byte-identical snapshots.
- Renderer is tested via `@testing-library/dom`.

Headless mode (§3) makes system tests fast and framework-free.

---

## 15. Versioning and stability

- v0.x: unstable. APIs may change between minor versions. Breaking changes called out in CHANGELOG.
- v1.0: API freeze for `@domecs/core`, `@domecs/dom`, `@domecs/persist`. Other packages may lag.
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
