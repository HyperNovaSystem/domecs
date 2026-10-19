# DOMECS — Specification v1.0

**Status:** v1.0 — final/authoritative. Code has shipped: seven `@domecs/*` packages (`core`, `dom`, `input`, `persist`, `inspector`, `scene`, `rules`) are published at 2.0.0; `@domecs/sprites` and `@domecs/worker` are planned and do not exist yet (the once-planned `@domecs/math` is superseded by `dmath` in `@domecs/core`, 2.1). Incorporates the design critique (formerly `critique.md`, removed — see git history) and the exemplar requirements in `exemplars.md`. References to "v0.1" below are retained as historical context describing the feature set this specification originally locked in; the README supersedes only where marked.

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

Shipped (1.0.0; `scene` and `rules` since 2.0.0):

```
@domecs/core           — core: World, entities, components, queries, systems, events, time
@domecs/dom            — DOM renderer: views, mounting, diffing
@domecs/input          — input collector: keyboard, pointer, touch, gamepad
@domecs/persist        — snapshot save/load over a Storage interface, migrations, schema I/O
@domecs/inspector      — headless fault/timeline recorder (see §10)
@domecs/scene          — Parent component, hierarchy queries, transform composition, world-bound spatial index (2.2), contact events (2.3)
@domecs/rules          — data-defined expression language and rule interpreter (Appendix A)
```

Planned (do not exist yet):

```
@domecs/sprites        — sprite sheet components + frame animation (DOM renderer plugin)
@domecs/worker         — off-main-thread simulation host
```

Deterministic math is not a separate package: `@domecs/core` exports `dmath` (2.1; §8). The `@domecs/math` package earlier drafts planned will not ship.

The spatial grid is split the same way (2.2; §2.12): the pure, world-free `createSpatialGrid` lives in `@domecs/core`, so `@domecs/rules` can build on it without depending on `@domecs/scene`; the world-bound `createSpatialHash` lives in `@domecs/scene`.

### Module dependency DAG

```
@domecs/core
 ├── @domecs/input        (depends: core)
 ├── @domecs/dom          (depends: core)
 │    └── @domecs/sprites (planned; depends: core, dom)
 ├── @domecs/inspector    (depends: core; uses core reflection)
 ├── @domecs/persist      (depends: core)
 ├── @domecs/scene        (depends: core)
 ├── @domecs/rules        (depends: core)
 └── @domecs/worker       (planned; depends: core)
```

No cycles.  Core is renderer-agnostic; the DOM renderer is framework-agnostic.

### Headless and import-time safety

First-release packages must be safe to import under plain Node with no browser
globals installed. `@domecs/core` is the authoritative headless runtime:
`createWorld({ headless: true })` plus explicit `world.step(dt)` must run
without `window`, `document`, `navigator`, `requestAnimationFrame`, or
`cancelAnimationFrame`. `World.startLoop()` remains browser-only and must throw a
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

**Defaults are per entity (O-44, normative).** `create()` copies the declared `defaults` for each instance: arrays and plain objects are cloned recursively, so no two entities share a nested default. Other objects in `defaults` (class instances, `Map`s, functions) are kept by reference. Values the caller passes are taken as given (O-34).

**Reflection (#14).** A component type MAY carry an optional `schema` — a
field-name → `FieldSchema` map (`kind` plus widget hints: numeric range/step,
enum `options`, label, readonly). `world.describeComponent(type)` returns a
`ComponentDescriptor` with the component's name, transient flag, a cloned
`defaults`, and a resolved `fields` map: the explicit schema when declared
(`fieldsSource: 'schema'`), otherwise inferred from `defaults` by runtime
`typeof` (`'defaults'`), otherwise empty (`'none'`). This lets dev tools render
edit widgets from the world alone, with no per-app schema registry. Reflection
is descriptive only — it does not validate or constrain component values. A
`FieldSchema` MAY carry a free-text `description` (units, what 0 means) for
humans and agents; `@domecs/persist` round-trips it.

**Invariant (I-1 — tick-scoped references).**  A reference obtained from a query result, `world.getComponent`, or any adapter wrapper is valid *only within the tick that produced it*.  Consumers must not stash the reference across tick boundaries; they must copy the data they need, or re-query on the next tick.  This applies equally to vanilla systems, Svelte `$state` proxies, and React `useQuery` results — the framework adapters do not, and cannot, extend the lifetime of a component reference.

v0.1 treats I-1 as a caller contract, not as a proxy-enforced runtime feature. Stale-reference poisoning is deferred until the diagnostics surface is designed, so the current core does not expose a dev/prod split for component wrapper behavior.

### 2.3 World

A world owns: entities, component stores, archetype index, query cache, system scheduler, event buffer, time state, input state, plugins, and a PRNG.

Worlds are independent.  Two worlds never share mutable state.

**Registry and name lookup (§4.5 of the harness spec; O-30, O-78).** A world
keeps three name-keyed registries — components, events, resources — each its
own namespace. A type enters its registry implicitly on first use (a component
store access, an emit / `on` / event-system trigger, a resource access) or
eagerly through `world.register(...types)`, so reflection lists it before
anything uses it. `register` is idempotent, all-or-nothing, and returns
`err({ kind: 'name_conflict', registry, name })` (never throws) when a name is
already held by a different type object of the same kind, or by another
argument of the same call; it throws `TypeError` only for a value that is not a
type. It touches nothing the snapshot carries (no resource default is
materialized), and registries persist across `restore()`.

`lookupComponent(name)` / `lookupResource(name)` return the registered type or
`undefined`. `lookupEvent(name)` returns `undefined` both for an unknown name
and for an ambiguous one (two distinct known event types share it, §2.6).
`componentTypes()`, `eventTypes()` and `resourceTypes()` list each registry in
first-seen order.

**Manifest.** `world.describe()` is the single machine-readable description of
the live world: `components`, `resources`, `events` (descriptors, including an
event's `description`), `systems`, `plugins`, `capabilities`,
`snapshotVersion`, and the live counts `entityCount`, `componentCounts`,
`archetypes`. Each `systems` entry is `{ name, schedule, enabled, priority,
order, components, meta? }`: `components` is the sorted, de-duplicated list of
component names every leaf of the system's `query` / `reactsTo` names (`Not`
branches included, resource leaves excluded), computed once at registration;
`meta` is the system's `SystemDef.meta`, cloned at registration and again per
call. `describe()` stays O(systems + types).

### 2.4 Query

A query is a composable predicate over component presence and values. Queries are built from two kinds of nodes (normative):

**Component shortcuts** carry a single `ComponentType` and produce a leaf node:

- `Has(T)` — component type present on the entity.
- `OnChanged(T)` — `markChanged(e, T)` was called within the reader's change window (§2.9).
- `OnAdded(T)` — component type was added within the reader's change window.
- `OnRemoved(T)` — component type was removed within the reader's change window.
- `Where(T, predicate)` — component is present and `predicate(value)` is true.

**Resource change-detection node** carries a single `ResourceType` (see §2.11) and produces a leaf node:

- `OnChangedResource(R)` — the world-level resource `R` was changed (via `setResource`/`markResourceChanged`) within the reader's change window. Structurally neutral: it matches *every* entity when `R` changed in the window and *no* entity otherwise, so `And(Has(T), OnChangedResource(R))` yields the `T` entities only on ticks where `R` changed, while a bare `OnChangedResource(R)` is a world-level edge that a reactive system can react to even in an empty world (see §4 step 6). It is a change-detection node for the `reactsTo` contract.

**Predicate combinators** carry one or more child `QueryNode`s and compose them:

- `Not(node)` — true when `node` is false. Unary. Evaluated per entity (O-74): `Not(Where(T, p))` matches an entity that lacks `T` or whose `T` fails `p`, and `Not(OnAdded(T))` an entity whose `T` was not added in the window (or that lacks `T`); candidate selection by archetype MUST NOT drop such entities.
- `And(...nodes)` — true when every child is true. N-ary.
- `Or(...nodes)` — true when any child is true. N-ary.

The combinators MUST also accept a bare `ComponentType` as a one-arg shortcut for `Has(T)`, so that `Not(Player) ≡ Not(Has(Player))`, `And(Position, Velocity) ≡ And(Has(Position), Has(Velocity))`, etc. This is purely an ergonomic widening; the produced `QueryNode` is identical in either form.

A node MUST be well-formed: its runtime payload must match its declared `kind`. Engine implementations MUST reject a node whose payload disagrees with its kind (statically via a discriminated union; in dev builds, additionally at runtime). A combinator presented with neither a `QueryNode` nor a `ComponentType` is a contract violation, not a constant-true predicate.

Queries are **archetype-cached**. A query computes an index the first time it is used; subsequent ticks reuse it. `onAdd` and `onRemove` hooks fire when entity composition changes in a way that enters or exits the query's archetype set.

**One-shot selectors (normative).** `world.query(def)` returns a *live*
`QueryResult` that the engine registers and keeps up to date until
`dispose()`; reading `.entities.length` for a one-off count and dropping the
result leaks a registered query. For ad-hoc reads the engine MUST provide
leak-free one-shot selectors that evaluate the current world without
registering anything: `countEntities(def) → number`, `listEntities(def) →
Entity[]`, and `selectViews(def) → EntityView[]` (the latter carrying typed fields
for the tuple shorthand, as `query()` does). One-shot selectors accept the
structural node set (`Has`/`Not`/`And`/`Or`/`Where`) and MUST reject reactive
nodes (`OnAdded`/`OnChanged`/`OnRemoved`/`OnChangedResource`), whose per-tick deltas are
only defined for a registered query or reactive system.

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
(`Has`/`And`/`Or`/`Not`/`OnChanged`/…) fall back to the unconstrained
`EntityView` shape; callers either narrow at the call site or read
component values through `world.getComponent`, which already carries
typed `T`. Component types that need their literal name preserved by
TypeScript MUST be declared with both type parameters
(`defineComponent<T, 'Name'>('Name')`) — the single-arg form
`defineComponent<T>('Name')` continues to work but widens the `Name`
parameter to `string`, and views built from such types fall back to the
unconstrained `EntityView` shape.

**Complexity (normative).**  `Has` / `Not` / `And` / `Or` / `OnAdded` / `OnRemoved` / `OnChanged` are satisfied by the archetype cache in O(matching-entities) amortized — the cache tracks set membership, so iteration dominates.  `Where(T, predicate)` is **not** indexed: it runs the predicate against each entity in the matching archetype set every tick, at O(matching-archetype-entities) per tick regardless of how selective the predicate is.  Users who need value-based filtering in hot paths should model the filterable state as a **tag component** (e.g., `Dead`, `Burning`, `Selected`) and add it to the query via `Has` / `Not`, so archetype caching applies.  Reach for `Where` only when the predicate is cheap *and* the matching archetype set is small, or when the query runs off the hot path.

Change-detection filters (`OnChanged`, `OnAdded`, `OnRemoved`, `OnChangedResource`) report the marks in their reader's change window (§2.9). Nothing is reset at tick boundaries. A query that every match must satisfy through one `OnAdded(T)`/`OnChanged(T)` leaf (the leaf itself, or a child of an `And`) reads the marks of `T` in its window rather than every holder of `T` when the window holds at most a quarter as many marks as the query has structural members (O-54) — an idle or lightly changed frame costs what changed, not the world's size.

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
  rand:     Rng              // world.rand, or the system's own stream (rng: 'own', §2.8)
  state:    unknown          // system-local slot; see SystemDef.state
}
```

Systems are registered with:

```ts
world.system(name, {
  query:     QueryDef,
  schedule:  'tick' | 'fixed' | 'event' | 'once' | 'reactive',
  priority?: number,         // lower runs first; default 0
  order?:    number,         // tie-break within a priority; default 0, finite (§3)
  rateHz?:   number,         // fixed only
  triggers?: EventType[],    // event only
  reactsTo?: QueryDef,       // reactive only
  enabled?:  () => boolean,
  state?:    unknown,        // system-local; preserved across hot-swap (§9.5)
  meta?:     JsonValue,      // annotation for tools; cloned, surfaced in describe()
  rng?:      'shared' | 'own', // which stream ctx.rand is; default 'shared' (§2.8)
}, fn)
```

`rng` picks the generator `ctx.rand` is: `'shared'` (default) is `world.rand`;
`'own'` is the system's own stream (§2.8). `describe().systems[i].rng` reports
it. Any other value makes `world.system()` throw before anything is registered.

`meta` is a JSON-safe annotation the runtime never reads; `describe().systems`
reports a clone of it. `@domecs/rules` sets `{ rule: name }` on each rule's
system. A `meta` JSON cannot carry (a function, `undefined`, a non-finite
number, a class instance, a cycle) makes `world.system()` throw `TypeError`
before anything is registered.

`state` is the system's private slot, readable and writable as `ctx.state` inside `fn`. It is preserved across dev-mode hot-swap (§9.5). It is **not** part of the world snapshot — on `restore()`, systems re-register and `state` resets. Closures over module-scope values are not preserved across hot-swap; swap-durable state must live in `state`.

**Between-tick mutations.** Component mutations and `markChanged` calls made *outside* a running system (e.g. from input callbacks or signal handlers between `step()` calls) are buffered and become visible to systems at the *next* tick — see §2.9 buffer-and-swap rule. Reactive systems thus observe both in-tick and between-tick marks uniformly, separated only by tick boundaries.

### 2.6 Events

Events are typed messages.  Emitted events are **buffered** and flushed at step 1 of the next tick.  Event systems see a read-only view of the buffered events that match their `triggers`.

Events never carry live component references; they carry data or entity ids.

**Event names.** Event identity is the type object (F-8): two
`defineEvent('X')` calls make distinct types that coexist on the bus without
colliding. The name is a label, and a name two known types share is
*ambiguous*: `world.lookupEvent('X')` returns `undefined`, and
`bridge.act('X', …)` is rejected without emitting or ticking. An agent-facing
command name MUST be unique within a world; `world.register(Cmd)` asserts it
(`name_conflict` otherwise) and makes the command known before first use. An
event MAY carry a free-text `description` (`defineEvent(name, { description })`),
surfaced by `describeEvent` and `describe().events`.

An event emitted during an event system's execution is delivered at step 1 of *the next tick* (not the same tick, not the end of the current tick).  This is the rule; it is not a surprise.

**Pending events (§7.1).** The undelivered queue is readable with `world.pendingEvents()` — `{ type, payload }` pairs in bus order (by first emit of each type, then payload order within a type), a fresh array that consumes nothing. A snapshot taken with `{ pendingEvents: true }` carries the queue, so a fork taken between the emit at tick N and its delivery at tick N+1 sees the same deliveries as the live world. Restoring such a snapshot resolves every event name through `world.lookupEvent`: a world that restores snapshots with events in flight must know those types — `register` them in setup, or subscribe to them, or name them as an event system's `triggers`.

### 2.7 Time

```ts
interface TimeState {
  tick:          number    // integer, monotonic
  elapsed:       number    // scaled simulation seconds (ms-quantized); survives restore (§7.1)
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

Because `elapsed`, the fixed-step count, and `fixedAccumulator` are all functions of that cumulative total, the snapshot carries only the total (`scaledTime`, §7.1) and `restore()` re-derives the rest (O-40).

**Positive-floor rule (normative, F-6).** When `step(dt)` is called with a positive wall-clock `dt` and the world is not paused (`time.scale !== 0`), the per-tick ms-quantized dt MUST NOT be zero — it MUST be raised to a minimum of 1 ms (i.e. `scaledDelta >= 1e-3`). Without this, sub-ms wall-clock frames (common on high-refresh monitors) produce `scaledDelta = 0`, which yields `NaN` in any controller that divides by dt (PIDs, rate estimators, first-order smoothing filters). The floor applies only to the per-tick *published* value: the internal cumulative unquantized total is unchanged, so §2.7's drift-free guarantee still holds across any window that contains at least one normally-sized frame. The floor is bypassed when the caller explicitly requests a no-op heartbeat (§4 step 0 exception below) — a positive dt is the signal that real time elapsed.

### 2.8 PRNG

`world.rand` is a seeded PRNG. Default algorithm: **xoshiro128**\*\*. The seed is part of the snapshot. `Math.random` must not be used by any authoritative system — the inspector warns on detection.

**Per-system streams (2.1, O-77, normative).** `world.rand` is the **shared** stream: every system that draws from it changes what every later draw returns, so adding, removing or editing one random-drawing system reshuffles all the others. A system registered with `rng: 'own'` instead receives its own stream as `ctx.rand`:

- **Root.** The world's root seed state is `seedToState(options.seed ?? 0)`, fixed at `createWorld`; it never advances. `restore()` adopts a snapshot's `rngRoot` (a v2 snapshot, which has none, restores onto the world's own `createWorld` root, whatever it restored before), so systems registered after a restore derive the streams the source world would.
- **Key.** The stream key is fixed at registration: the lowest of `name`, `name#1`, `name#2`, … that no live own-stream system holds. With no earlier same-named system removed, that is the system's cursor key (§7.1: its name, or `name#k` for the k-th live system sharing it); removing a system and re-registering it while a same-named one stays live (two rules handles sharing a rule name, each `update()`) resumes the key it left. Rules are keyed `rule:<name>`.
- **Derivation.** `deriveStream(root, key)` (exported from `@domecs/core`): `h` = FNV-1a-32 over the UTF-16 code units of `"domecs:stream:" + key`; word `i` of the state is the first `splitmix32` output seeded with `root[i] XOR rotl(h, 8·i)`; an all-zero state is fixed up as `seedToState` does; then 8 outputs are discarded as warm-up. The function is pinned by a golden test and is part of the snapshot contract: changing it requires a `SNAPSHOT_VERSION` bump.
- **Lifetime is by key.** The world keeps every own stream it has created, by key. A system registering under key *k* resumes the stream if one exists (a removed system's stream is kept), otherwise it derives it from the root. `RulesHandle.update()` removes and re-registers every rule, and the streams survive that, so a live world and a fresh fork stay equal. The map grows by the number of distinct own-stream keys ever used (renaming a rule leaves an orphan entry, which round-trips).
- **Snapshot.** `snapshot()` writes `rngRoot` always and `rngStreams` (every entry) once a stream exists (§7.1). `restore()` replaces the map with `rngStreams` (absent: empty), rewinding live generators in place so captured `ctx.rand` handles follow (O-46), then re-derives from the restored root the stream of every registered own-stream system whose key is missing and adds it to the map. Reseeding is data-only: `{ ...snap, seed: s, rngRoot: s, rngStreams: undefined }` restores into a world whose shared stream and every own stream derive from `s`.
- **Scope.** Adding, removing or editing system A does not change own-stream system B's draws. B's own draws still depend on how many entities it visits (one stream per system; per-entity streams are out of scope). An own-stream system that calls `world.rand` directly still draws the shared stream: use `ctx.rand`.

### 2.9 Change tracking

`world.markChanged(entity, type)` is the input to `OnChanged(T)` queries. It is **explicit**: the core does not auto-detect component mutations. In v0.1 the path is proxy-free in every build: `markChanged` records the entity/type pair for the next tick's change filters, with no write interception, no per-field version bookkeeping, no `WorldOptions.dev`, and no `world.diag` surface.

Post-v0.1 diagnostics may warn about mutation-without-mark or mark-without-mutation patterns through a plugin or inspector surface, but those warnings must not change `OnChanged(T)` semantics. Missed marks remain caller bugs; extra defensive marks remain legal.

**Invariant (I-2 — explicit marks).**  `OnChanged(T)` returns exactly the set of entities for which `markChanged(e, T)` was called within the reader's change window (after filtering by the query's component set).  It is a faithful report of marks, not a detector of mutations.  Missed marks are a caller bug; future diagnostics may help find them, but the core does not paper over them.

This contract applies uniformly to vanilla, any post-v0.1 framework adapter, and the Worker boundary: an adapter that auto-marks (e.g., via a reactivity framework's own proxy) must still produce `markChanged` calls the core can see — adapters do not get a private fast path.

**Change windows (O-42, normative).** Every mark — `markChanged`, a component add or removal, `despawn`, `setResource`/`markResourceChanged` — is recorded in one order, whenever it is made: inside a system, in a plugin hook or signal handler, during render or `tickEnd`, or between `step()` calls. A change-detection filter reports the marks in its reader's *change window*:

- **A system's `query` and `reactsTo`:** every mark since the system's previous run ended, up to the moment this run starts. Marks made while the system runs — its own writes and anything they trigger synchronously — fall after the window and are not reported back to it. A system that does not run (disabled, a `tick`/`fixed` system while paused, a sub-rate `fixed` system between its steps, an `event` system with no matching event) keeps accumulating and sees everything at its next run. A reactive system whose `reactsTo` is checked and comes up empty counts as having run. A newly registered system's window starts at the end of the last completed tick.
- **Any other live query** (`world.query(...)` read by a plugin hook, a renderer, or user code): every mark since the last tick in which it was read, up to the read. At the end of each tick and each heartbeat (§4.0) its window advances to the point of its last read, so a mark made after that read — later in the tick, in a `tickEnd` handler, or between ticks — is reported at its next read. Reads within one tick are cumulative. A new query's window starts at the end of the last completed tick.

No mark is lost to ordering: a system that runs earlier in a tick than the writer sees the mark at its next run, and a reactive re-trigger (§4.1 step 6) is the same rule. Marks made between ticks are ordinary marks; no separate buffer is needed.

**Retention.** Added and changed marks are dropped when their component is removed. Removal marks outlive the entity and are kept until every reader with an `OnRemoved` filter has seen them — a live query with `OnRemoved` that is never read again keeps them, so dispose queries you no longer read. Snapshots carry the marks a system has not seen yet (§7.1).

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

### 2.11 Resources

A **resource** is a single named value scoped to the world rather than to any entity — the canonical home for game-global state (score, current level, gravity, the active turn's command, config). Resources are declared with `defineResource` and reach for the same name-keyed identity discipline as components (§2.2):

```ts
const Score = defineResource<number>('Score', { default: 0 })
const Config = defineResource<Cfg>('Config', {
  default: () => makeConfig(),          // function = per-world factory, called lazily
  validate: (v) => v.fps > 0 || 'fps must be positive',
})

world.setResource(Score, 10)
world.getResource(Score)       // → 10
world.markResourceChanged(Score)  // mark without replacing (in-place mutation)
```

**Identity and registration (normative).** A `ResourceType` is an opaque token carrying a `name` and a brand. As with components, two distinct resource objects sharing a name are a collision — the engine MUST throw on the second registration. A resource is registered the first time it is read, set, or marked.

**Default materialization (normative).** `defineResource` accepts `default?: T | (() => T)` and `validate?`. A function default is a **per-world factory** called lazily the first time `resource(R)` is read on a world that has not set the value; a non-function default is **deep-cloned per world** (so two worlds never share a mutable default object). `resource(R)` returns `undefined` only when there is no value and no default. `setResource` and a materialized default both run `validate`; a `string` return is thrown as a validation error.

**Change tracking (normative).** Resource changes are marks like component marks (§2.9): `setResource` and `markResourceChanged` record the change whenever they are called, and `OnChangedResource(R)` (§2.4) reports it within each reader's change window. `setResource` replaces the value and marks it changed; `markResourceChanged` marks without replacing, for callers that mutate a resource object in place. Both wake an idle driver (§3 idle suspension) so a resource change cannot be lost to suspension.

**Snapshot (normative).** Resources are part of `world.snapshot()` and `restore()` (§7.1): the snapshot carries a `resources` map of name → deep-cloned value, omitted entirely when no resource has a value. `restore()` clears all live resources first, so restoring a snapshot with no `resources` yields a world whose resources fall back to their defaults. Resource values follow the same JSON-serializability contract as component values.

### 2.12 Spatial queries

2D neighbour queries over points (2.2; O-8). Two layers:

- **`createSpatialGrid(cellSize)`** (`@domecs/core`) — a pure, world-free uniform grid keyed by entity id: `set(id, x, y)` inserts or moves, `delete`, `clear`, `position`, `size`; queries `within(x, y, r, accept?)`, `nearest(x, y, { maxDistance?, accept? }?)` and `pairs(r, accept?)`.
- **`createSpatialHash(world, { component, x?, y?, cellSize })`** (`@domecs/scene`) — a `SpatialIndex` over one position component (fields `x`/`y` by default). `refresh()` rebuilds from the component's current values in ascending id order (`iterEntitiesWith`); the index also refreshes once at creation. Queries take tag filters (`within(x, y, r, filter?)`, `nearest(x, y, { maxDistance?, filter?, exclude? }?)`, `pairs(r, a, b)`); a filter is a list of component types the entity must all hold, read live with `world.has` at query time. `dispose()` drops the index; any later call throws.

**Results (normative).**

- Distance is compared squared, as `dx * dx + dy * dy` with `dx = px - x`, `dy = py - y`, against `r * r`. Every query returns exactly what a brute-force scan over the indexed points with that expression returns. A negative or NaN radius or `maxDistance` matches nothing.
- Results **never depend on `cellSize`**, on insertion order, or on the order cells are visited. Cell size is a performance setting only.
- `within` is sorted by ascending id. `nearest` returns the minimum distance, ties → lowest id. `pairs(r)` (grid) lists unordered pairs `a < b`, sorted by `(a, b)`. `pairs(r, a, b)` (index) lists ordered pairs whose first element holds `a` and second holds `b`: for `a ≠ b` every such pair (an entity holding both tags can appear on either side), for `a == b` first < second; sorted by `(first, second)`.
- A position with a non-finite coordinate (NaN, ±∞), or for the index a field that is not a number, is not indexed (setting one removes the id).
- `accept` callbacks should be pure: `within` and `pairs` call them in output order on the matches; `nearest` may call them in any order and any number of times.

**Cells.** Cell coordinates are `Math.floor(v / cellSize)`: an exact integer, computed deterministically, but the division rounds, so a point within a few ulps of `v` of a cell border can land in the neighbouring cell; the bounds below absorb that. Cell keys pack the integer coordinates by an exact rule (small integer, then a 52-bit integer, then a string), so distinct cells never share a key. A point whose cell coordinate exceeds 2^50 in magnitude (or overflows) is kept on a side list that every query scans. `cellSize` must be finite and > 0 (`RangeError` otherwise).

**`nearest` termination.** Rings of cells expand around the query cell. The search stops only when a conservative lower bound on the distance of every unvisited cell is strictly greater than the best distance found (or than `maxDistance`): for ring `k` the bound is `(k − 1) × cellSize`, reduced by a relative slack of 2^-40 and an absolute slack of `(|x| + |y| + cellSize) × 2^-40`, compared as squared distance, so floating-point rounding can only make the search visit more cells, never fewer. When a ring would need more cell lookups than there are occupied cells, the search scans every point instead (same result by definition). `within` and `pairs` likewise fall back to a scan when the covering block of cells is larger than the occupied grid.

**Derived state (normative).** Grids and indexes are never part of a snapshot (§7.1); building, refreshing or querying one leaves `hashSnapshot` unchanged. After `restore()` rebuild or `refresh()` them from the restored positions. Positions are as of the last `refresh()`; call it once per step before querying (for example at the start of the system that queries).

**Cost** (`bench/` `spatial` workload, informational): `refresh()` targets ≤ 0.1 ms and `nearest` ≤ 2 µs average at 1000 uniformly spread entities. In 2.2 `refresh()` is a full O(n) pass; an incremental refresh from change windows is a follow-up. Out of scope: occupancy layers (`firstAt`/`allAt`/`isBlocked`, the rest of O-8), 3D, AABB/broadphase trees.

**Contacts (2.3; O-85).** `installContacts(options)` (`@domecs/scene`) is a plugin whose system (default `fixed`, priority 150: the contacts band of §3) turns overlaps into `Contact` events for rules:

- **Colliders** are the entities holding the position component (`position.component`, fields `x`/`y` by default) with a finite position, a radius (`radius`: a fixed finite number ≥ 0, or a component field read live that must be a finite number ≥ 0) and at least one tag of `pairs`. Two colliders overlap when `dx * dx + dy * dy <= (ra + rb) * (ra + rb)` (touching counts). Each run rebuilds a `createSpatialGrid` from the live positions; results never depend on `cellSize`.
- **Pairs (normative).** For each tag pair `[A, B]`, a pair `[a, b]` has `a` holding `A` and `b` holding `B`; for `A == B`, `a < b`. An entity holding both tags can appear on either side; a pair found through two tag pairs counts once. The current set is sorted by `(a, b)` and diffed against the `ContactState` resource (`{ pairs }`, sorted), giving `begin` (new), `end` (gone) and, with `stay: true`, `stay` (kept).
- **Emission (normative).** `Contact { a, b, phase }` (a declared schema; `phase` is `'begin' | 'stay' | 'end'`) is emitted with `ctx.events.emit` in phase order `end`, `begin`, `stay`, each sorted by `(a, b)`, so it is delivered next tick (§4.1): rules see it through `on: 'Contact', self: 'event.a', other: 'event.b'` (Appendix A). A despawned entity, or one that lost its tag, radius or finite position, produces its `end` once on the next run.
- **State.** `ContactState` is an ordinary resource, so a snapshot carries it and a restored world continues `begin`/`end` exactly (live == fork); a fork also needs `snapshot({ pendingEvents: true })` (§7.1) for contacts emitted but not yet delivered. The grid is derived state.
- `installContacts` registers `Contact` and `ContactState` by name (install fails when another type holds either name). One contacts plugin per world (capability `domecs-scene:contacts`). Invalid options throw at the call. Out of scope: AABB and polygon shapes, physics response, continuous collision. Cost (`bench/` `contacts` workload, informational): ≤ 0.5 ms per run at 1000 entities × 2 tag pairs.

---

## 3. Scheduling modes

| Mode       | Fires on                                | Sees                                |
|------------|-----------------------------------------|-------------------------------------|
| `once`     | `world.startLoop()` (first tick of world) | initial input/time                |
| `fixed`    | every `fixedStep` of scaled time        | integrated fixed delta              |
| `tick`     | every render frame                      | scaled delta                        |
| `event`    | events buffered from previous tick      | event view                          |
| `reactive` | query result changed (debounced to tick)| query delta (added/removed/changed) or resource change |

**Run order within a mode (normative).** Systems run by the triple **(priority, order, registration index)**, each ascending: `priority` first (default 0), then `order` (default 0), then registration order. `order` must be a finite number; a non-finite or non-number `order` throws at `world.system()`, as an invalid `rateHz` does. With every `order` left at 0 this is the 1.x/2.0 rule: equal priorities run in registration order. `order` lets a library place its systems deterministically regardless of when they were registered or re-registered (O-76): `installRules(world, defs, resolve, { order: 'stable' })` from `@domecs/rules` registers rule *i* of the de-duplicated defs with `order: orderBase + i` (default base 1), so a rule's position is a function of (priority, defs order) only, and every equal-priority system left at order 0 runs before the rules. The default `order: 'registration'` keeps the 2.0 behaviour, where `RulesHandle.update()` re-registers every rule and so moves them after every equal-priority system registered earlier (a 3.0 candidate to flip). Two stable rule handles on one world need disjoint `orderBase` ranges, or their rules tie-break by registration index again. `describe().systems[i]` reports `priority` and `order`.

**Recommended priority bands (convention, not enforced).** A world whose systems keep to these bands has a run order that depends only on what it registers, not on when:

| Band | Priority | Examples |
|---|---|---|
| commands, input | −100 | command handlers, std command systems |
| rules | strictly between −100 and 100 (default 0) | `installRules` |
| derived transforms | 100 | `composeTransforms({ priority: 100 })` |
| contacts | 150 | `installContacts` (`@domecs/scene`, §2.12) |
| derived, render-only | 200 | caches, view state |
| level switching | 1000 | scene-goto systems |

**Schedule changes during a phase (O-43, normative).** Each phase of §4.1 runs the systems that were registered when the phase began. A system removed during the phase does not run later in it, and the systems after it still run. A system registered during the phase first runs at that schedule's next phase: the next fixed sub-step, or the next tick for the other modes. Registration order is a monotonic counter, so systems equal in priority and `order` keep their order after removals.

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
explicit `world.startLoop()`, or a call to `world.requestTick()`.
`restore()` wakes it for one heartbeat frame (§4.0: plugin hooks and render,
no tick), so the restored state is painted without moving the world past
the checkpoint (O-48).

**Unseen marks and idle (O-42, normative).** After a frame the loop also
stays awake while a mark is waiting for a reader that will act on it: an
enabled reactive system whose `reactsTo` would fire, or a live non-system
query that was read during the last tick (a renderer's change gate) and
would report something. A deferred reactive re-trigger (§4.1 step 6) and a
mark made during render or `tickEnd` therefore get their next frame. Marks
no such reader would report do not keep the loop awake.

**A throwing frame (O-45, normative).** If a step run by the driver throws,
the driver still schedules its next frame (subject to the idle rule) before
the error propagates out of the `requestAnimationFrame` callback, where the
host reports it. One throwing system does not stop the loop.

**External wake API (normative, D-4).** External event sources that mutate
world state from outside a tick — input plugins, WebSocket feeds, custom
drivers — MUST rouse the idle loop by calling `world.requestTick()`. The
call is a no-op when the realtime driver is not running, when `idle: false`,
or when already inside a tick. `requestTick` is the *only* supported wake
path; reaching into engine-private members is not contractual.

### Headless mode

`createWorld({ headless: true })` disables the realtime driver. `world.startLoop()`
MUST throw even if the host environment exposes `requestAnimationFrame`;
`world.step(deltaSeconds)` advances one tick manually.
`world.stepN(steps)` advances N ticks. Used by tests, AI search, board game replay, server authority.

### Turn-based mode

Equivalent to headless with a thin driver: `world.turn(action)` emits the action as an event, calls `world.stepOnce()`, returns when systems have quiesced.
Roguelike default.

**Command result (`action`, normative).** `world.action(type, payload, opts?)` is `turn()` with a structured return — `turn()` stays the void fire-and-forget form. It emits the action event, advances one tick (so the action flushes at step 1 and its handlers run in steps 3–6), then returns `{ accepted, consumedTurn, reason?, events, snapshot? }`:

- `events` is the set of events emitted *during* that tick — the command's downstream effects, captured from the buffer that step 1 of the *next* tick would flush. The action event itself was consumed at step 1 and is **not** included. Order is deterministic: by first-emit of each event type, then payload order within a type.
- `accepted` / `consumedTurn` / `reason` come from an optional `opts.resolve({ events, world })` verdict — game policy, which the engine does not interpret. The default verdict is `{ accepted: true, consumedTurn: true }`; when a resolver omits `consumedTurn` it defaults to `accepted` (an accepted command spends the turn, a rejected one does not). `consumedTurn` is a *reported* value for the caller's turn bookkeeping — `action` always advances exactly one tick regardless, because turn-consumption policy can only be decided by systems that run *inside* the tick.
- `snapshot` is attached only when `opts.snapshot` is set (`true` for defaults, or a `SnapshotOptions` object to forward e.g. `pruneEmptyEntities`).
- `opts.dt` is forwarded to `step`; omit it for a turn-based tick advance (as `turn()` does). A non-positive explicit `dt` is a heartbeat (§4.0) and will not process the action.
- **Payload validation (O-39, normative).** When the event type was defined with a `schema`, `action()` validates the payload *before* emitting: a non-object payload, a field not declared in the schema, a wrong-typed declared field, or an out-of-`options` enum value returns `{ accepted: false, consumedTurn: false, reason, events: [] }` — no event is emitted and **no tick advances** (the malformed command never enters the world). Declared fields absent from the payload are treated as optional (`FieldSchema` carries no required-marker). Schema-less events are not validated, and `turn()` / `emit` are never validated — the check is an *action-boundary* contract.

---

## 4. Tick order (normative)

### 4.0 `step(dt)` heartbeat exception (F-6, normative)

An **explicit** call of `step(0)` (or any non-positive `dt`) is a *heartbeat*, not a tick. The implementation MUST:

1. Leave `time.tick`, `time.elapsed`, and every system's change window unchanged.
2. Set `time.delta = 0` and `time.scaledDelta = 0`.
3. Skip steps 3–6 entirely — no `fixed`, `tick`, `event`, or `reactive` systems run.
4. Still fire plugin `onTickStart`, `onRender`, `onTickEnd`, and the `tickStart`/`tickEnd` signals, in the same order as a normal tick, so UIs can paint initial state and input plugins can republish input snapshots. The plugin hooks receive `{ heartbeat: true }` as their second argument (`TickInfo`, O-57); a plugin that hands systems one-tick data MUST NOT consume it on a heartbeat. `@domecs/input` keeps the pending key edges and pointer/wheel deltas for the next tick: a heartbeat's snapshot has current held keys, position and buttons but no edges or deltas, so each edge is seen by exactly one full tick.

A heartbeat is idempotent: any number of consecutive `step(0)` calls leave the world state identical to the moment the first one was invoked. Marks made before a heartbeat stay unseen by systems until their next run. A live query read during the heartbeat's render (a renderer's change gate) has seen what it read: its window advances at the end of the heartbeat (§2.9), so a heartbeat paints between-tick marks once and the next tick does not repaint them.

**Legacy carve-out.** A no-argument `step()` call (`dt === undefined`) is *not* a heartbeat — it advances a tick with `time.delta = 0` for backwards compatibility with turn-based exemplars. Turn-based callers should use `turn(event, payload)` (which invokes `step()` internally) rather than passing literal zero. Code that wants explicit "do nothing now but keep the UI alive" behavior MUST pass `0` explicitly.

### 4.1 Normal tick order

For each `step(dt)` with `dt > 0` (or `step()` with no argument — see §4.0):

0. **Begin the tick.** No change-detection state is reset: each reader's change window (§2.9) carries every mark it has not seen, whether it came from a system, a hook, or an external caller.
1. **Flush event buffer from last tick.** Events become readable by event systems.
2. **Collect input.** `InputCollector` snapshots keyboard, pointer, touch, gamepad, focus into `InputSnapshot`.
3. **Run `fixed` systems.** Zero or more steps to catch the accumulator up to scaled time.
4. **Run `tick` systems.** In priority order.
5. **Run `event` systems.** For events buffered in step 1. Events emitted during 3–4 were buffered for *next* tick.
6. **Run `reactive` systems.** In priority order, each fires when its `reactsTo` has entities in its change window (§2.9). Debouncing rule (normative): all marks in the window that hit the same `reactsTo` **coalesce into one invocation** with a combined delta. A reactive system sees each entity at most once per invocation. If a reactive system's execution mutates state that would re-trigger a reactive system earlier in priority order within this same step 6, the re-trigger is **deferred to the next tick's step 6** — the mark falls in the earlier system's next window; the tick does not iterate to a fixed point. This matches the event-buffering rule in §2.6.

   **`ctx.entities` for reactive systems (normative).** When a reactive system supplies only `reactsTo` (no explicit `query`), its `ctx.entities` MUST be the `reactsTo` change delta for the tick — the same set that triggered the invocation — not the empty array. When an explicit `query` is also supplied it takes precedence and `ctx.entities` reflects that query; authors who want both the trigger and a broader/narrower view use the explicit `query` for iteration and the change itself as the trigger.

   **`reactsTo` contract (F-5, normative).** A reactive system's `reactsTo` query MUST contain at least one change-detection node (`OnAdded`, `OnRemoved`, `OnChanged`, or `OnChangedResource`), optionally composed with `Has` / `Not` / `And` / `Or` / `Where` as filters. A `reactsTo` query composed entirely of structural predicates (e.g. `Has(Player)`) is a contract violation and engine implementations MUST reject it at `world.system(...)` registration time with a thrown error.

   **Resource-gated reactive fire (normative).** A `reactsTo` query whose only change-detection node is `OnChangedResource(R)` and that carries no `Has` leaf is a *world-level* trigger: it fires whenever `R` changed, even in an empty world, with `ctx.entities` empty. When such a query also carries a `Has(T)` leaf (e.g. `And(Has(T), OnChangedResource(R))`) it is entity-scoped and fires with the `T` entities on `R`-change ticks — and does not fire in a world with no `T`, matching the structural semantics of `OnChangedResource` in §2.4. Rationale: reactive semantics are edge-triggered ("fire when the query result changes"); a structural-only query has no tick-scoped edge, so the only well-defined behavior would be level-triggered ("fire every tick while non-empty"), which is what `tick` + `enabled: () => q.size > 0` already expresses. The change-detection requirement makes the fire-on-change contract intrinsic to the query rather than dependent on user convention.

   Implementation note: structurally, `OnChangedResource` is neutral (it constrains *when*, not *which entities*), so the pure-resource form has zero structural members and needs a dedicated fallback path in the scheduler — entity-scoped and world-level resource reactions are evaluated differently. Both forms are pinned by tests (`resources.test.ts`, "ChangedResource — reactive gating"); changes to query evaluation must keep both green.

   ```ts
   // World-level: fires once per Config-change tick, ctx.entities === [].
   world.system('onConfig', { schedule: 'reactive', reactsTo: OnChangedResource(Config) },
     (ctx) => applyConfig(ctx.world.getResource(Config)))

   // Entity-scoped: fires on Config-change ticks with the matching Hud
   // entities; never fires while no entity has Hud.
   world.system('hudRescale', { schedule: 'reactive',
     reactsTo: And(Has(Hud), OnChangedResource(Config)) },
     (ctx) => { for (const e of ctx.entities) rescale(e) })
   ```
7. **Renderer diff and commit.** Views are diffed; DOM mutations batched.
8. **Close the tick.** Plugin `onTickEnd` and `tickEnd` handlers run; then every live query that is not a system's advances its change window to its last read (§2.9). These windows advance even when a step above throws (O-53): a query read before the throw has seen what it read. The rest of the tick's bookkeeping (pruning, restored cursors) happens only when the tick completes.

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

**View membership (O-52, normative).** A view's query defines a standing set: an entity is mounted while it is in the query's result (`query.entities`, which applies `Where` predicates) and unmounted when it leaves, reconciled at each render commit. Temporal nodes (`OnAdded`, `OnRemoved`, `OnChanged`, `OnChangedResource`) are not valid in a view query; `mountDOM` returns `invalid_view_query`. Change-gated redraws use `changedOn`.

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

`ViewDef.changedOn` is a discriminated union
(`{ mode: 'auto' } | { mode: 'legacy' } | { mode: 'explicit'; types: [...] }`):

1. If `ViewDef.changedOn` is **omitted** (default) or `{ mode: 'auto' }`,
   the renderer derives the set from every `Has(T)` and `Where(T, …)` leaf
   in the view's `query` — explicitly negated branches (`Not(...)`) are
   excluded. A view with `update` whose query has no such leaf, or with an
   empty `explicit` list, is rejected with the `invalid_changed_on`
   MountError rather than silently redrawing every tick (O-55). A view
   over `[Position, Velocity]` thus auto-redraws when either component is
   marked changed.
2. If `ViewDef.changedOn` is **`{ mode: 'legacy' }`**, the renderer falls
   back to the legacy "redraw every tick" behaviour. Useful for time-driven
   animations whose view depends on `time.elapsed` rather than component
   identity.
3. If `ViewDef.changedOn` is **`{ mode: 'explicit', types: [Position] }`**,
   redraws are gated on exactly that set, ignoring whatever the query
   implies. Used for finer-grained narrowing.

**First-paint exception (O-2).** Under `auto` / `explicit` gating, `update`
(when provided) runs **once** for each newly created node in the commit that
mounts it, using a fresh commit-time entity view — entities that are spawned
and never marked changed still render, and components added later in the
same commit window are visible to that first paint. An entity that is both
created and marked changed in one window still gets exactly one `update` for
that commit. Subsequent commits stay change-gated. (Under `legacy` the
full-redraw path already covers new nodes.)

`onAdd` (initial mount) and `onRemove` (final unmount) are not subject to
this gate; `create` and `destroy` always fire regardless of `changedOn`.
`create` receives the entity's commit-time view, including components added
after it matched in the same window (O-55); `destroy` receives the last view
the renderer held for it.

**A throwing view callback (O-53, normative).** A `create`, `update` or
`destroy` that throws affects only its own entity. The commit continues with
the remaining entities and views, and the first error is rethrown from the
renderer's `onRender` once the commit is done, so it propagates out of
`step`/`stepOnce` (and `tickEnd` does not fire for that frame). Later frames
are not affected: a failed `destroy` still removes the node; a failed
`update` leaves the node mounted and is not retried until the entity is
marked changed again; a failed `create` leaves the entity unmounted until it
is marked changed on a redraw trigger — for a view without them (no `update`,
or `legacy`), on a component of one of its query's `Has` leaves — when
`create` is retried, or until it leaves and re-enters the view. `MountHandle.teardown()` likewise removes every node
and then rethrows the first `destroy` error. The tick's change windows close
even when the frame throws (§4.1 step 8), so the renderer is not handed the
same marks again.

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

**Slot-collision policy (normative).** Slot *mounting* (via `mountDOM({ slots: {...} })`) is exclusive: attempting to mount a second root to an already-mounted slot name returns `err({ kind: 'slot_already_mounted', slot })` from `mountDOM`. A world may take any number of mounts on distinct slots (O-55). View *registration*, by contrast, is additive: any number of views from any number of plugins may target the same slot name, and the renderer **appends** elements into that slot in registration order. This is the same rule as §5.1's entity→zero-or-more-views — multiple views per slot are already legal; §5.6 makes it explicit that cross-plugin overlap is not a conflict. Ordering within a slot is registration order; plugins that care about z-order should stack layers via named sub-slots (e.g., `chrome:menu`, `chrome:toasts`) rather than racing against each other on a shared slot.

---

## 6. Input (`@domecs/input`)

- Keyboard: normalized to W3C `code` values; modifier state separated.
- Pointer: unified mouse/pen/touch via Pointer Events.
- Gamepad: polled per tick; snapshot includes all connected pads.
- Focus: active element and whether a text input consumes keys (prevents app keybindings from firing when typing in chat).

`InputSnapshot` is immutable within a tick. Systems read; they do not mutate.

v0.1 pointer coordinates are raw DOM event client coordinates, whatever the `pointerTarget`. Target-relative normalization, hit-tested entity enter/leave tracking, and higher-level action mapping are deferred to the next input milestone or app-level plugins. The first move after install sets the position without a delta; under pointer lock the delta is the events' `movementX`/`movementY` (O-59).

`keyDelta` edges are published once per tick (§4.1 step 2). Every `fixed` sub-step of that tick sees the same edges, so a press fires once per sub-step, and a `fixed` system that does not run that tick misses it; edge-triggered input belongs on `tick` systems (O-35, O-59).

Keybinding layer is *not* part of core — it is a plugin that translates `InputSnapshot` to high-level `Action` events.

---

## 7. Persistence (`@domecs/persist`)

### 7.1 Snapshot

```ts
interface WorldSnapshot {
  version:    number                             // current SNAPSHOT_VERSION = 3
  seed:       [number, number, number, number]  // shared PRNG state (world.rand)
  rngRoot?:   [number, number, number, number]  // root seed own streams derive from (v3; §2.8)
  rngStreams?: Record<string, [number, number, number, number]> // own streams by key (v3; §2.8)
  tick:       number
  scaledTime?: number                            // cumulative scaled seconds (O-40); see below
  fixedBacklog?: number                          // fixed steps due but not yet run (O-40)
  fixedStep?:  number                            // step size fixedBacklog counts in; present with it
  entities:   { id: number; components: Record<string, unknown> }[]
  nextId?:    number                             // entity-id cursor (O-38); see below
  resources?: Record<string, unknown>            // name → value; omitted when none (v2+)
  changes?:   ChangesSnapshot                    // marks a system has not seen (O-42); see below
  pendingEvents?: { event: string; payload?: JsonValue }[] // undelivered events, opt-in (O-90); see below
  meta?:      Record<string, unknown>
}
```

`SNAPSHOT_VERSION` is **3**. Version 2 added the optional `resources` map (§2.11). Version 3 (2.1) added the optional `rngRoot` and `rngStreams` (§2.8, O-77) and `pendingEvents` (O-90) fields. **Every snapshot a 2.1 world writes is v3**, whether or not it uses own streams or pending events: `rngRoot` is always written; `rngStreams` is omitted while the world has never created an own stream, and `pendingEvents` while none was recorded (restoring an absent field and an empty one behave identically). 2.0 engines reject v3 snapshots ("newer than this engine supports"). `restore()` accepts any version ≤ 3: a v2 snapshot lacks the v3 fields, so the world uses its own `createWorld` root, re-derives every own stream and abandons its event queue. The `@domecs/persist` loader ships built-in `1 → 2` and `2 → 3` migrations (§7.3), so a legacy v1 save — which simply lacks `resources` — and a 2.0 save load transparently. `canonicalSnapshot` excludes `version`, so the bump alone changes no hash; `rngRoot` is state and is hashed.

**Entity-id cursor (O-38, normative).** `snapshot()` records the world's id cursor as `nextId`; `restore()` sets the cursor to `max(snap.nextId, maxAliveId + 1)`, so ids assigned after a restore match the ids the live world would have assigned even when the highest-id entity was despawned before the snapshot (the old maxAliveId+1 derivation recycled despawned ids, making episode runs incomparable). The field is optional — snapshots from older builds lack it and restore falls back to the derived cursor; the `max()` guard means a corrupt cursor can never re-issue a live id.

**Clock continuity (O-40, normative).** `snapshot()` records the cumulative unquantized scaled time (§2.7's drift-free total) as `scaledTime`, plus `fixedBacklog` — fixed steps that time made due but that have not run — when it is non-zero. The backlog is normally 0 after a completed tick; it is positive when a `tickStart` hook paused the world after time advanced (the live world runs those steps once resumed) or when the snapshot is taken inside the fixed-step loop. `restore()` resumes the total and re-derives `time.elapsed`, the fixed-step count (steps due, less the backlog), and `time.fixedAccumulator` with the same expressions the tick uses, so a restored world's `fixed` systems — including divisor-rate ones — fire on the live world's frames, and `time.elapsed` continues instead of restarting at 0. The count is derived against the *restoring* world's `fixedStep`: a world restored with a different `fixedStep` neither bursts through catch-up steps nor stalls. A backlog is recorded with the `fixedStep` it is counted in; restored under another step, the fixed time the live world had run is re-counted in the restoring world's steps, so the time still owed carries over (to within one step) rather than the number of steps. The fields are optional — snapshots from older builds lack them and restore starts the clock at 0.

**Unseen change marks (O-42, normative).** A mark a system has not seen yet (§2.9) is part of the live world's future: that system reports it at its next run. `snapshot()` records such marks as `changes: { marks, seen }` — `marks` in the order they were made (`[kind, componentName, entityId]` for `added`/`changed`/`removed`, `["resource", name]`), and `seen[systemName]`, how many of them that system had already seen; a system missing from `seen` had seen them all. Only systems whose `query` or `reactsTo` has a change-detection node are recorded. `restore()` re-issues the marks, after every mark the restoring world has issued, and positions each system with that name accordingly — including one registered after the restore and before the next tick ends. Systems not in `seen`, and every other live query, start having seen all of them. The field is omitted when every system has seen every mark; a snapshot without it restores with no marks (the pre-O-42 behavior).

The cursor key is the system's name; when several live systems share a name, the k-th (from 0, in registration order) is keyed `name#k`. A `once` system that has run is not a reader. Removal marks are carried only while a system with an `OnRemoved` filter has not seen them. Restore keeps every carried mark, even one for a component the entity no longer has (a transient component, an entity a prune plugin dropped), so the restored world's next snapshot carries what the live world's would. Cursor keys depend on registration order, including the `__observe_N` systems behind `observe()`; restore into a world that registered the same systems in the same order. The restored world also continues the live one exactly only if its systems run in the same order (§3). A live world whose rules were re-registered by `RulesHandle.update()` runs them in a different order from a fresh world built from the same defs, unless the rules were installed with `{ order: 'stable' }`; with stable rules, the rules' run order no longer depends on when `update()` ran, so a fresh world that registers its other systems the same way and installs the current defs is a valid restore target. A snapshot taken while a system is running records that system's position before the run.

**Validation before any effect (normative).** `restore()` runs the plugin `onRestore` hooks first — they may decode what their `onSnapshot` encoded, so it is the envelope they produce that must be valid — then validates it: the envelope shape (O-41: `seed` four finite numbers, `rngRoot` when present four finite numbers, `rngStreams` when present an object whose every value is four finite numbers, `tick` an integer ≥ 0, `nextId` when present an integer ≥ 0, `resources` when present an object (`null` is invalid for both), and every entity record an object with a unique integer `id` ≥ 0 and an object `components` bag), registered resource values (§2.11), and the clock fields (`scaledTime` a finite number ≥ 0, `fixedBacklog` an integer ≥ 0, `fixedStep` a finite number > 0; `null` is invalid, only an absent field means "older build"). An invalid envelope, or a throwing hook, throws before world state is touched and leaves the pending events as they were (events a hook emitted are dropped). Hooks have run by then, so a hook should not commit plugin state that a failed restore would leave inconsistent.

**What restore continues (O-40).** Given the same systems and plugins, `restore(snapshot())` followed by the same `step`/`action` calls reproduces the live world's future: entities, components, resources, the PRNG state, the tick, the id cursor (O-38), the clock, query iteration order (§8, ascending entity id), and the change marks systems have not seen (O-42). State outside the envelope is not carried:

- Events still pending in the bus — emitted during the last tick (delivered at the next tick's step 1) or between ticks — **unless** the snapshot was taken with `{ pendingEvents: true }` (the pending-events rule below). Without it, restore discards them.
- `time.scale` and pause state — host controls; restore leaves the restoring world's own.
- System `state` and closure variables — keep durable state in components or resources.
- `once` systems: restoring into a fresh world does not mark them as run, so they fire on its first tick.

Continuation is therefore exact when the snapshot is taken between ticks and either carries the pending events (`{ pendingEvents: true }`) or none were in flight. Change marks systems have not seen — including marks from out-of-tick mutations — are carried (`changes`, above); marks a non-system query has not read yet are not. Durable cross-tick history belongs in components or resources (the durable-log pattern), which the snapshot does carry.

`snapshot()` is a **synchronous**, coherent-world-at-tick-T deep copy. It is the explicit-save / export / determinism-test path. No transient components are included. The contract is **plain-data / JSON-oriented**: component and resource values must be plain objects, arrays, and JSON primitives. The clone is a plain recursive walk — there is no structured-clone codec — so `Date`, `Map`, `Set`, functions, and class instances are not meaningfully preserved, and **cyclic values overflow the stack during `snapshot()`** (before `save()`'s `persist_io` error boundary can catch anything). Components holding non-plain data must declare themselves transient (§2.3). At 50k entities the sync walk is O(entities × components) on the main thread — use it for user-initiated saves, not per-tick autosave.

`snapshot(options?)` accepts `SnapshotOptions`. `pruneEmptyEntities` (default `false`) drops entities whose serializable bag is empty once transient components are excluded — transient-only and bare `spawn()` entities. The default records every alive entity so id/archetype membership round-trips exactly. `@domecs/persist`'s `pruneTransientOnlyEntities()` plugin applies the same prune on the no-arg `save()` path via `onSnapshot`.

`restore(snap)` is a trusted authored-snapshot path in v0.1. Restore rehydrates name-keyed component bags and depends on user code to register matching `ComponentType` objects before those components are queried or mutated. The snapshot does not carry rich schema metadata or component signals, and restore does not run `ComponentOptions.validate`; strict validation, unknown-component reporting, and metadata-backed restore belong to the future persistence/reflection work.

**PRNG and driver (O-46, O-48).** `restore()` rewinds the world's generator in place, so a `world.rand` reference captured before the restore draws the restored stream; own streams (§2.8) are rewound in place the same way. A restore also gives an idle `startLoop` driver one heartbeat frame, so the restored state is painted while the world stays at the checkpoint, paused or not (§3 Idle suspension).

**Pending events (normative; O-90).** `restore()` sets aside all pending (undelivered) events before the plugin hooks run: events emitted on the timeline being abandoned must not fire into the first tick after the restore — otherwise identical episodes (e.g. `AgentBridge.reset()` loops) diverge on leftover event state. **The abandoned timeline's queue is replaced by the snapshot's queue when the snapshot carries one.** Events a plugin emits during its `onRestore` hook are preserved when the restore succeeds, queued after the snapshot's.

- `snapshot({ pendingEvents: true })` records the queue as `pendingEvents: [{ event, payload }]` in bus order (by first emit of each type, then payload order within a type). Each payload is copied as plain data: `null`, booleans, strings, finite numbers (`-0` kept), arrays, and objects whose prototype is `Object.prototype` or `null`; an `undefined` object property is omitted, and an `undefined` payload (a `defineEvent<void>` event) omits `payload`. Any other payload — `undefined` inside an array, a non-finite number, BigInt, symbol, function, class instance (`Date`, `Map`, …) or a cycle — throws `TypeError` naming the event and the path (`payload.at`). Because the record is by name, a pending event whose name another known event type shares (§2.6) also throws `TypeError`: restore would refuse the name as ambiguous, or re-queue the wrong type in a world that knows only the twin. The field is omitted when nothing is in flight, so the option changes neither the envelope nor the hash of a world with an empty queue. Default `false` in 2.x (ED-16): the field is absent and behaviour is 2.0's. Every fork, keyframe or checkpoint whose future must match the live world's opts in.
- When the field is present, `restore()` validates it (an array of objects with a string `event`) and resolves every name through `world.lookupEvent` **before any effect**, alongside the envelope validation above: a malformed field, an unknown name, or an ambiguous one (two known types share it, §2.6) throws with the world, and its pending queue, untouched. It then re-queues the events in order, with cloned payloads. A world that restores snapshots with events in flight must therefore know those types: `register` them in setup (or subscribe to them, or name them as `triggers`).
- `world.pendingEvents()` returns the same queue as `{ type, payload }` pairs without consuming it, so a host can report what an act produced without `world.action()` (which inserts a tick).
- `@domecs/persist`'s `save()` and `createSnapshotHistory` call the no-arg `snapshot()` and therefore do not carry pending events.

**Canonical form (O-11, normative).** `canonicalJson(value)` (core) is the canonical text of a plain-data value: `JSON.stringify` value semantics with every object's keys sorted ascending by UTF-16 code unit, so two values that are equal as data serialize identically whatever order their keys were inserted in (a snapshot's component bag follows archetype insertion order, which differs between worlds in the same state). `undefined`, function and symbol values are omitted in objects and become `null` in arrays; numbers are written with ECMAScript `Number::toString` (spec-defined, identical across engines) **except `-0`, which is written as the literal `-0`** — valid JSON, and `JSON.parse('-0')` returns `-0`. A non-finite number (`NaN`, `±Infinity`), a BigInt or a cycle throws `TypeError` naming the path (`"entities[3].components.Body.vx"`); mapping them to `null` would change the value's type on restore and hide a divergence. The form is **lossless**: `canonicalJson(JSON.parse(canonicalJson(x))) === canonicalJson(x)`, and a world restored from `JSON.parse(canonicalJson(snap))` continues exactly like one restored from `snap`. `JSON.stringify` is not lossless (it writes `-0` as `0`), so keyframes and forks taken from disk serialize with `canonicalJson`; `@domecs/persist` `save()` still uses `JSON.stringify` (switching is a follow-up).

`canonicalSnapshot(snap, options?)` is the canonical text of a snapshot's simulation state: every top-level field except `version` (format, not state — a migrated snapshot hashes the same), `meta` and `changes`. That includes `pendingEvents` when present, so two worlds that differ only in what is about to be delivered hash differently. `options.includeMeta` adds `meta`; `options.includeChanges` adds `changes`. `hashSnapshot(snap, options?)` is FNV-1a-64 over the UTF-8 bytes of that text, as 16 lowercase hex characters (`HASH_ALGORITHM === 'fnv1a64'`; not cryptographic). `hashEntities(snap)` maps each entity id, ascending, to the hash of its canonical `components`, so comparing two maps localizes a divergence; `hashValue(value)` hashes `canonicalJson(value)`.

**Strict hash for restore equivalence (normative).** Two worlds with equal default hashes can still have different futures: `changes` carries the marks and cursors that decide what change-gated systems do next, and marks and cursors can differ between worlds in the same state (a render hook that marks a component during a heartbeat, §4.0, adds a mark without changing any value). Every restore-equivalence check — fork vs live, checkpoints, keyframe verification — compares `hashSnapshot(snap, { includeChanges: true })`. The default hash is for cache keys and UI.

### 7.2 Autosave — eventually consistent (planned; not in v1.0)

Autosave has not shipped — v1.0 persistence is explicit `save`/`load`. This section is the locked design for the planned facade. Autosave is **not** a repeated sync `snapshot()`. It is an incremental, eventually-consistent writer:

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

The `createPersistence` facade below (IndexedDB database, per-component codecs) is **planned, not in v1.0** — the shipped surface is the snapshot-version chain described at the end of this section:

```ts
// Planned facade — does not exist in v1.0.
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

**Snapshot-version chain (implemented).** Alongside the per-component codecs, the implemented `@domecs/persist` surface migrates the *envelope* by `version`: `migrate(snap, targetVersion, migrations)` applies single-step functions keyed by source version (`MigrationMap.get(N)` → the `N → N+1` step) until reaching the target, hard-failing with `migration_failed` on a gap, a step that does not produce exactly version N+1, or a snapshot newer than the target (O-63). `world.restore()` itself throws on a snapshot whose `version` is newer than the engine's `SNAPSHOT_VERSION`; older snapshots should go through `migrate()` (as `load()` does). `load()` overlays caller-supplied steps on top of `BUILTIN_MIGRATIONS` via `withBuiltinMigrations` (caller keys win on collision), so framework version bumps load transparently while userland can still override or extend any step. The framework ships two built-ins, both pure version bumps: `1 → 2` (a v1 snapshot simply lacks `resources`, §7.1) and `2 → 3` (2.1: a v2 snapshot simply lacks `rngRoot`, `rngStreams` and `pendingEvents`). `save()` writes v3.

### 7.4 Ring buffer (time-travel)

The inspector (§10) consumes a bounded ring buffer of **diff snapshots**: each entry records only the components that changed since the previous snapshot.
Memory is `O(changes)` not `O(entities × snapshots)`.

### 7.5 Act logs, replay and branches (`@domecs/core`, 2.2)

An act log (`ActLog`, `format: 'domecs-actlog'`, `version: 1`) records what entered a world from outside so that another world, built by the same setup and restored from the same base, replays to equal strict hashes (harness spec §7.1; O-80). It is a separate artifact; the snapshot format is unchanged.

**Recording.** `createRecorder(world, { hashEvery? })` attaches to a world-internal tap (not a public signal) and records the base (`startTick`, `fixedStep`, `startScale` — plus `resumeScale`, the scale `resume()` returns to, when it is 0 — and `baseHash` = `hashSnapshot(snapshot({ pendingEvents: true }), { includeChanges: true })`). Then:

- **Acts.** Every emit not made by a system or a direct `on` handler — `world.emit`, `world.events.emit` outside a tick, `turn`, `action` (`via: 'action'`, the others `via: 'emit'`), and emits from plugin hooks and signal subscribers during full ticks **and** heartbeats — is recorded by event name with a plain-data copy of its payload (absent for `undefined`), in emit order: into the next frame's `acts` when made before a step's event flush (out of tick, during heartbeats, from plugin `onTickStart` — which runs before the flush, so its emits join the frame of the tick that delivers them); during a full step after the flush, into that frame's `startActs` (`signals.tickStart` subscribers, before the systems) or `endActs` (render, plugin `onTickEnd`, `signals.tickEnd`, after the systems). Replay emits `startActs` and `endActs` at the same points, so they keep their place among the events the step's systems emit and the step ends with the same queue.
- **Frames.** Each full step (`stepOnce()`, or `step(dt)` with `dt > 0`) is one frame `{ tick, dt, scale?, hookScale?, acts?, startActs?, endActs?, input? }`: `tick` before the step, the caller's `dt` (`null` for `stepOnce`), `scale` = `time.scale` on entry to the tick (the scale its dt is scaled by) when it differs from the scale the previous frame ended with, `hookScale` = the scale after the tick-start hooks (plugin `onTickStart`, `signals.tickStart`) when a hook changed it (it decides whether that step's `fixed` and `tick` systems run), and `input` = `encodeInput(world.input)` as the step's systems see it (after plugin `onTickStart`, re-read after `signals.tickStart` when a subscriber replaced it) when it differs from the previous frame's (always on the first frame). Heartbeats (`step(dt <= 0)`) are not frames: acts emitted around them carry over to the next frame, and a `setInput` followed only by a heartbeat records nothing.
- **Gaps.** `out_of_tick_mutation` (spawn, despawn, add/remove component, `markChanged`, `setResource`, `markResourceChanged` outside a full tick, heartbeats included; a draw on `world.rand` between steps), `unserializable_payload` (a payload that is not plain data; the act is dropped) and `restore` (acts the restore abandoned are dropped; `onRestore` emits are kept). The log stops describing the world at a gap. Route every runtime perturbation through a command.
- **Checkpoints.** With `hashEvery: k`, the strict hash at each full-tick end where `tick % k === 0`.

`encodeInput` / `decodeInput` convert `InputSnapshot` (whose key sets are `Set`s) to `JsonInput` (sorted arrays; empty `pressed`/`released` and parts equal to the empty input omitted) and back.

**Replay.** `replay(world, log, { base?, toTick?, verify?, onFrame? })` returns `Result<{ ticks, hash }, ReplayError>` and never throws for a bad log:

1. Check the log's shape (`invalid_log`, also for a `fixedStep` other than `world.time.fixedStep`, an unknown gap reason, or a checkpoint that does not follow a frame end in frame order — it would leave every later checkpoint uncompared).
2. `restore(base)` when given, then `setScale(log.resumeScale)` when present and `setScale(log.startScale)`; compare the strict hash with `baseHash` (`base_mismatch`).
3. Per frame (stopping before the first frame whose `tick >= toTick`): resolve every act with `lookupEvent` (an unknown or ambiguous name is `unknown_event`) and check `via: 'action'` payloads against the event's schema (`rejected_payload`; raw emits are never validated live, so `via: 'emit'` acts are not), both before any emit; set `scale` and `input` (else keep the previous ones); emit the acts in order; `stepOnce()` or `step(dt)`, applying `hookScale` and emitting `startActs` from a one-step `signals.tickStart` subscription and emitting `endActs` from a one-step `signals.tickEnd` subscription.
4. Compare the checkpoint taken at that frame's end (`diverged`), unless `verify: false`.

**Preconditions** (§8): the replay world has the same setup (systems, plugins, order) as the recording world **minus every stimulus source** — no input plugin (it would overwrite `world.input` at `onTickStart`) and no plugin hook or signal subscriber that emits events, and none that sets `time.scale` at tick start (their effects are already in the log) — and no enabled `once` system the source had already run (`once` run state is not snapshotted). A stimulus source is left out whole, so it must do nothing else a replay needs: its `world.rand` draws and world writes during a full tick are not in the log. Under them the same base, setup and log give the same hashes, tick systems (`scaledDelta` comes from the recorded dt and scale) and own RNG streams included. Not recorded: `runSystems` calls, draws on an own stream outside a tick, changes to the setup, acts emitted after the last frame (the log has no frame for them, so a replay ends without them in its queue), and a step that throws out of `step` (a plugin hook that throws): the log does not describe it.

**Branches** (harness spec §7.2; O-81). Systems are closures, so a world cannot be cloned; a branch is a fresh world built by the source's setup and restored from one of its snapshots. `createBranch(setup, from, { fixedStep?, seed?, scale? })` runs `createWorld({ headless: true, fixedStep: fixedStep ?? from.fixedStep ?? 1/60, seed })`, `setup(world)`, `world.restore(from)` and `setScale(scale ?? 1)`, and returns `Result<{ world, setup }, BranchError>` with `setup`'s return value. A throw from `setup` is a bug and propagates; a throw from `restore` is `restore_failed` (the cause serialized with `normalizeCause`); an enabled `once` system registered by `setup` when `from.tick > 0` is `once_systems` (it would run on the branch's first step while the source had already run it). `seed` matters only for a v2 `from`, which has no `rngRoot`. A snapshot carries `fixedStep` only with a fixed backlog and never carries the scale, so the caller passes the source's `time.fixedStep` (when it is not 1/60) and `time.scale`; for a paused source, the scale it resumes to, then `pause()` on the branch (`scale: 0` resumes to 1).

`runBranch(world, { steps, dt?, log?, probes?, sampleEvery?, keyframeEvery?, hashEvery?, until?, shouldStop? })` steps the world it is given, synchronously, and returns `Result<BranchRun, ReplayError>` with `{ ticks, stoppedBy: 'steps' | 'until' | 'cancelled', samples, keyframes, hashes, faults, finalHash }`. Called again, it extends the branch from where it stopped. Before each step it polls `shouldStop`; it applies the `log` frame whose `tick` is the current tick, when there is one, with the replay frame code (acts resolved and checked first; scale, input, dt), else `stepOnce()` (`dt: null`) or `step(dt ?? time.fixedStep)`; after it, `until` is checked. Before the first step, the input of the latest log frame earlier than the current tick is set (input is delta-encoded and not snapshotted), so a branch from a mid-log keyframe starts with the source's input; the scale is not carried (it is `createBranch`'s `scale`). `sampleEvery` (default 1 with probes), `keyframeEvery` and `hashEvery` count the steps of this call, not absolute ticks; probes are also sampled after the final step whatever stopped the run (once at the current tick when no step was taken). Keyframes are `snapshot({ pendingEvents: true })`; every hash is strict; probe values are copied as plain data; `faults` are the `signals.faultRaised` faults of this call. A malformed log or one for another `fixedStep` is `invalid_log`, and an act that does not resolve or validate is `unknown_event` / `rejected_payload`, with the steps already taken left taken. Equal `(setup, from, options)` give equal `finalHash`, `hashes` and `samples`.

**Restore-continuation preconditions** (§7.1 "What restore continues"): `setup` registers the same types, systems and plugins in the same order as the source world (stable rules make the order a function of the definitions); `from` is taken with `{ pendingEvents: true }` and without snapshot-rewriting plugins (redaction); `scale` is the source's `time.scale`; and every event type that can be pending is registered. Probes must be read-only: at the first sample of each call `runBranch` compares the strict hash before and after each probe and throws an `Error` naming one that changed it. A `log` given to a branch follows replay's preconditions (no stimulus sources in `setup`). Nothing else can verify these.

---

## 8. Determinism contract

DOMECS promises:

- **Given identical inputs, seed, and initial snapshot, the post-tick state is bit-identical across engines that correctly implement IEEE-754 arithmetic.**

This relies on:

- `world.rand` — or the system's own stream, `ctx.rand` under `rng: 'own'` (§2.8) — is the only PRNG used in authoritative systems. An own stream is keyed by the system's cursor key and derived from the world's root seed, and its state travels in the snapshot.
- Systems do not read `Date.now()`, `performance.now()`, or wall-clock APIs.
- Query iteration order is **ascending entity id** — live `query().entities`, system `ctx.entities`, reactive deltas, `listEntities`, `selectViews`, `countEntities`, and `iterEntitiesWith` alike — regardless of the order entities joined a query or archetypes were created. `Where` predicates are evaluated in the same order, so a predicate with side effects makes the same calls. Archetype creation order is not part of the snapshot, so a restored world could not reproduce it; id order it can (O-40).
- **Transcendentals go through `dmath` (O-75).** `Math.sin`, `Math.cos`, `Math.tan`, `Math.atan2`, `Math.exp`, `Math.log`, `Math.pow`, `Math.hypot` and the other platform transcendentals are implementation-approximated under ECMA-262 and differ by up to 1 ulp between engine builds (Node 24 and Electron 44 disagree on thousands of inputs per 200k). Authoritative systems use `dmath` from `@domecs/core` instead: `dmath.sin`, `dmath.cos` and (2.2) `dmath.atan2` and `dmath.hypot` are straight-line ports of musl libm (generic C, non-FMA), `dmath.pow` (2.2) of fdlibm `e_pow.c`, and they return the same bits on every ECMA-262 engine; `dmath.sqrt` is `Math.sqrt`. `dmath.pow`'s special values are ECMAScript `**`'s. `@domecs/rules` does this automatically: `sin()`/`cos()` evaluate with `dmath` from 2.1, `atan2()`/`hypot()`/`pow()` from 2.2. `Math.sqrt`, the arithmetic operators, `Math.floor`, `Math.round`, `Math.abs`, `Math.min` and `Math.max` are exact under ECMA-262 / IEEE-754 and need no wrapper.
- **Runtime stamp.** Determinism holds per runtime build until every transcendental goes through `dmath`. Rules guarantee that; hand-written JS systems may not, so a host comparing runs across runtimes stamps its runtime identity (engine and version, arch, platform) plus each package's `BUILD_ID`.
- `Map`/`Set` insertion order is preserved; object key order is insertion order for string keys.

- **Equality is by hash (O-11).** "Same state" means equal `hashSnapshot` (§7.1 "Canonical form"): canonical JSON with sorted keys and a lossless `-0`, hashed with FNV-1a-64. Restore-equivalence checks (fork vs live, checkpoints, keyframes) use the strict form, `hashSnapshot(snap, { includeChanges: true })`. `JSON.stringify(snapshot())` is not an equality test: it depends on component insertion order and writes `-0` as `0`.

Nothing enforces these rules at run time: no shipped tool detects `Math.random`, wall-clock or transcendental use in a system. Check determinism by replay — same seed and inputs, compare `hashSnapshot(snapshot(), { includeChanges: true })`. `createRecorder` / `replay` (§7.5) record a live session and re-run it with checkpoint verification; `createBranch` / `runBranch` (§7.5) run a headless fork from a snapshot and compare its hashes and probe samples.

---

## 9. Plugins

### 9.1 Shape

```ts
interface PluginHandle {
  teardown?:     () => void
  onTickStart?:  (world: World) => void
  onTickEnd?:    (world: World) => void
  onRender?:     (world: World) => void
  onSnapshot?:   (snap: WorldSnapshot) => WorldSnapshot
  onRestore?:    (snap: WorldSnapshot) => WorldSnapshot
}

interface Plugin<O = void> {
  name:     string
  version?: string             // informational; surfaced in diagnostics
  depends?: readonly string[]  // plugin names required (topological order, §9.2)
  provides?: readonly string[] // capability keys exported (spatial index, etc.)
  // Result contract (BETTER_ERRORS Phase 1): success → optional PluginHandle,
  // failure → DomecsError (quarantined: provided capabilities unwound, world
  // survives). A throw normalizes to { kind: 'plugin_install_failed', … }.
  install(world: World, options: O): Result<PluginHandle | void, DomecsError>
}
```

**Authoring (normative recommendation).** Author plugins with
`definePlugin(spec)` rather than the raw `Plugin` literal. `definePlugin`
lets `install` return a bare `PluginHandle`, `void`, or a `Result`,
auto-wrapping the bare/void forms in `ok()` and passing an explicit `Result`
through — so the common "no failure mode" plugin needs no `ok()`/`err()`
boilerplate and stays valid under the Result contract:

```ts
const physics = definePlugin({
  name: '@domecs/physics',
  provides: ['spatial-index'],
  install(world) {
    /* register capability; void return is wrapped as ok() */
  },
})
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

`onTickStart`, `onRender` and `onTickEnd` are called as `(world, info)`, where `info: TickInfo` is `{ heartbeat: boolean }` — `true` on a `step(dt <= 0)` heartbeat (§4.0, O-57).

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

A headless plugin with no DOM dependency: `createInspector(options?)` returns
`{ plugin, view, clear }`. When installed, it:
- Records every entity fault (`Faulted` entries) and systemic fault
  (`signals.faultRaised`) into a bounded ring as `InspectorEntry` records.
- Optionally (`recordStateChanges`) interleaves spawns, despawns and component
  adds/removes into a timeline.
- Exposes a filter-composable `InspectorView` (`bySource`, `byKind`,
  `byTickRange`, `recoverableOnly`, …) and a serializable `export()`.

UI panels (Studio, custom devtools) are built on this surface; the package
ships none. It is **not** part of core; production builds can omit it.

---

## 11. Framework integration

**v0.1 ships no first-party framework adapters.**  Vanilla is the only supported path, the reference implementation, and the shape the rest of the spec is optimized around.

The integration surface is:

- `World.signals` (listener-gated, see `api.md`) — subscribe from any reactive system to be notified of entity/component/tick events.
- `world.markChanged(entity, type)` — explicit change tracking, the input to `OnChanged(T)` queries.
- `WorldSnapshot` — structural clone suitable for any store that can hold a plain object.

Any framework (Svelte, React, Solid, Vue, Lit, or vanilla DOM) can layer on top by subscribing to signals and mapping them into its own reactivity model.  Such integrations are **user code**, not core, not blessed, not versioned in lockstep with DOMECS.

### 11.1 Why no adapters in v0.1

- **Scope.**  Two adapters × two reactivity models doubles the surface the spec has to defend.  v0.1 picks one path and proves it.
- **Honesty.**  A Svelte `$state`-wrapped component store is not the same object as a vanilla component instance; systems written against one do not trivially port to the other.  Tiered adapters hid that asymmetry behind a marketing story.
- **Invariant I-1.**  The cross-tick reference rule (§2.2) is uniform for vanilla.  Adapter-wrapped references introduce per-adapter lifetime questions; deferring them lets the invariant stay simple.
- **`markChanged` is the API.**  With no "auto-detect in Svelte" alternative, explicit marking is not an ergonomics regression — it is the contract (see §2.9 for the full change-tracking contract).  This closes the `OnChanged(T)` correctness question by removing the branch where discipline varies.

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
- Every exemplar in `doc/exemplars.md` has a corresponding `HyperNovaSystem` app repository that CI builds and smoke-tests.
- The standalone example app repos validate source interop through `file:../domecs/packages/*`; release validation must also stage clean app copies against packed/published `@domecs/*` packages and run their normal `test` and static `build` scripts.
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

- `critique.md` — design flaws in the README proposal and the corrections applied here. (Removed after the v1.0 freeze; retrieve from git history.)
- `exemplars.md` — six applications whose requirements shaped v0.1.
- `api.md` — concrete type and function signatures (next document).
- Appendix A below — the rules expression language (`@domecs/rules`).

---

## Appendix A. Rules expression language (`@domecs/rules`, normative from 2.2)

A rule (`RuleDef`) runs as a system named `rule:<name>` over the entities
holding every `query` component and (2.2) none of the `without` components.
For each entity, in ascending id, it evaluates `when` and then every action
expression, and commits the action writes atomically (§2.8 for streams,
§3 for ordering). The package README is the tutorial; this appendix is the
contract.

**Grammar** (precedence lowest first; `(+)` = 2.2, `(++)` = 2.3):

```
expr           := nullish ( '?' expr ':' expr )?                  right-assoc
nullish        := logicOr ( '??' logicOr )*                       (+) left-assoc
logicOr        := logicAnd ( '||' logicAnd )*
logicAnd       := equality ( '&&' equality )*
equality       := relational ( ('==' | '!=') relational )*
relational     := additive ( ('<' | '<=' | '>' | '>=') additive )*
additive       := multiplicative ( ('+' | '-') multiplicative )*
multiplicative := unary ( ('*' | '/' | '%') unary )*
unary          := ('!' | '-') unary | primary
primary        := number | string | 'true' | 'false' | 'dt' | 'time'
                | 'tick'                                          (+)
                | IDENT '.' IDENT                                 self Component.field
                | entity '.' IDENT '.' IDENT                      (+)
                | entity '.' 'id'                                 (+)
                | 'pointer' '.' ('x' | 'y' | 'buttons' | 'wheel')  (+) input
                | 'event' '.' IDENT                               (++) payload field; event rules only
                | call | '(' expr ')'
entity         := 'self' | 'first' '(' SET ')'                    (+)
                | 'other'                                         (++) event rules with an `other` binding only
                | 'nearest' '(' SET ( ',' expr )? ')'             (+)
                | 'entity' '(' expr ')'                           (+)
call           := FUNC '(' ( expr ( ',' expr )* )? ')'
                | 'has' '(' ( entity ',' )? SET ')'               (+)
                | ('count' | 'exists') '(' SET ')'                (+)
                | 'countWithin' '(' SET ',' expr ( ',' entity )? ')'   (+)
                | ('sum' | 'avg' | 'minOf' | 'maxOf') '(' SET ',' IDENT '.' IDENT ')'   (+)
                | 'distanceTo' '(' entity ')'                     (+)
                | ('key' | 'pressed' | 'released' | 'mod') '(' expr ')'   (+) input; arg a string
SET            := IDENT                                           (+) the holders of that component
FUNC           := min/2 max/2 clamp/3 abs/1 sin/1 cos/1 floor/1 random/0
                | sqrt/1 pow/2 atan2/2 hypot/2 sign/1 round/1 ceil/1 lerp/3 distance/4   (+)
```

Number literals are decimal without exponent; strings take `\n \t \r \\ \" \'`.
Limits (O-66): 16384 characters, 128 levels of AST depth. Unknown functions
and wrong arities are parse errors.

**Reserved words (2.2).** `self`, `tick`, `other`, `event`, `pointer` cannot
name a component in an expression ("reserved word" at the name); after an
entity, `id` is reserved. From 2.3 `event.f` and `other` parse (event
rules). Only `first(`, `nearest(`, `entity(` start a
selector (`first.x` is `Component.field`), and only `key(`, `pressed(`,
`released(`, `mod(` read input (`key.x` is `Component.field`). An entity is
not a value: outside a member base, `has`/`countWithin`/`distanceTo`
argument it is a parse error.

**Values and kinds.** Values are numbers, strings and booleans. Arithmetic,
comparison and function arguments require numbers (a `RuleEvalError`
otherwise); `==`/`!=` compare with `===`; `!`, `&&`, `||`, `?:` use JS
truthiness and short-circuit, as does `??`. Type errors certain before the
rule runs are compile errors (`has`/`exists` are boolean; `count`,
`countWithin`, `distanceTo`, `e.id`, `tick`, the aggregates and every
function are numbers; `key`/`pressed`/`released`/`mod` are boolean and take
a string; `pointer.*` are numbers; field reads are unknown).

**Semantics (2.2).**

- `SET` is the entities holding the component, ascending id, computed once
  per rule run (membership never changes within a run).
- `first(S)`: lowest-id member other than the evaluated entity.
  `nearest(S[, d])`: the member minimizing squared distance from the
  evaluated entity's position, ties to the lowest id, excluding itself,
  within `d` (inclusive) if given. `entity(n)`: the alive entity with id `n`
  (`n` must be an integer, else a type error).
- `e.C.f` reads `C.f` on `e` as an own property; `e.id` is the id;
  `self.C.f` is `C.f` (it sees the entity's staged writes). `has([e,] C)` is
  a boolean, `e` defaulting to the evaluated entity.
- `count(S)`, `exists(S)` = `count > 0`; `sum/avg/minOf/maxOf(S, C.f)` read
  `C.f` on each member including the evaluated entity, skip members without
  it, and fault on a non-number. `sum` of none is 0; `avg`/`minOf`/`maxOf`
  of none have no value. `countWithin(S, r[, e])` counts members within `r`
  of `e` (default the evaluated entity), excluding `e`.
- `distanceTo(e)` = `sqrt(dx² + dy²)` between the evaluated entity's and
  `e`'s live positions; `distance(x1, y1, x2, y2)` likewise.
- Positions come from `installRules(..., { spatial: { component, x?, y?,
  cellSize? } })`; without it, `nearest`/`countWithin`/`distanceTo` are
  compile errors. A missing or non-finite position is no value. Candidate
  selection (`nearest`, `countWithin`) uses a `createSpatialGrid` (§2.12)
  built from positions at the start of the rule run; results never depend
  on `cellSize`.
- **No value**: a missing self or member field, an empty selector, a dead
  `entity(n)`, an empty `avg`/`minOf`/`maxOf`, a missing position. `a ?? b`
  evaluates `b` only on no value; other errors propagate. An uncaught error
  skips the entity for that run with a `rule_eval_failed` fault (nothing is
  written).
- **Read timing**: reads are live; entity *k* sees the committed writes of
  lower ids from the same run (Gauss–Seidel). Rules write only the
  evaluated entity.
- **Math**: `sin`, `cos`, `atan2`, `hypot`, `pow` evaluate with `dmath`
  (§8); every other function is exact IEEE-754 arithmetic (`lerp(a, b, t)`
  = `a + (b - a) * t`). A non-finite intermediate is allowed; a non-finite
  write is rejected.
- **Determinism**: iteration is ascending id, distances are exact double
  arithmetic with id tie-breaks, caches never outlive a run, nothing
  derived is snapshotted, and `random()` draws the rule's stream (§2.8).
- **Input** (2.2): rules read `ctx.input`, the snapshot installed for the
  tick (`setInput` or an input plugin). `key(n)` = `keys.has(n)` (held);
  `pressed(n)` / `released(n)` = `keyDelta.pressed/released.has(n)` (edges,
  one render tick); `mod(n)` = `mods[n]` for `n` in `ctrl`, `alt`, `shift`,
  `meta` (another name is a type error); `pointer.x|y|buttons|wheel` are the
  pointer's numbers. A non-string argument is a type error. `pressed`,
  `released` and `pointer.wheel` in a `fixed` rule are compile errors (§6:
  edges and the wheel last one render tick). Input is not snapshotted: a
  host replays it by installing the same snapshots before the same steps.
- **Event rules** (2.3, `schedule: 'event'`): `on` names the trigger
  (resolved by `resolveEvent`, default `world.lookupEvent`); the rule is a
  core event system with `triggers: [event]` and runs, per payload in
  emission order, for the entity `self` evaluates to (dead or not matching
  `query`/`without`: no-op; no value or not an integer: a systemic
  `rule_eval_failed` fault), else for every `query` match in ascending id,
  else once with no entity (world scope: empty `query`; `set` actions and
  evaluated-entity reads are compile errors). `event.f` reads the payload's
  own field (absent, `undefined`, `null` = no value; with a schema, an
  undeclared field is a compile error). `other` is the entity the `other`
  binding gives; unbound or dead = no value. The `self`/`other` bindings
  cannot read the evaluated entity or `other`. `event.f` and `other`
  outside an event rule (and in world expressions) are compile errors.
- **Effects** (2.3, `effects`: `emit`, `spawn`, `despawn`, `add`,
  `remove`): queued per entity only when `when` held and every action
  succeeded, with their expressions evaluated then (self = the queuing
  entity, seeing its staged writes; `random()` draws then), and applied at
  the end of the rule's run in queue order (payload, entity ascending,
  effect index). `emit` is validated with `validateEventPayload` when
  applied (invalid: a `rule_eval_failed` fault on the queuing entity) and
  delivered next tick. `spawn` calls `prefabs(name)` per spawn,
  plain-data clones each entry, writes `at` (the `spatial` position fields)
  then `set` (`Component.field`), and assigns ids in apply order. `despawn`
  is idempotent and later effects targeting a dead entity are skipped.
  `add` uses defaults plus `set`, or only `set` when the component exists;
  `remove` of an absent component is a no-op. Effect writes are checked
  like action writes; a rejected one skips that effect with a fault. No
  snapshot format change: emits in flight travel with
  `snapshot({ pendingEvents: true })` (§7), spawns advance the id cursor.
- **World expressions** (`compileWorldExpression`, 2.2): the same grammar
  with no evaluated entity. Bare `C.f`, `self`, `has(C)`, `countWithin(S, r)`
  without a centre, `distanceTo`, `nearest`, `dt`, `random()` and every
  input form are compile errors. `time` = `world.time.elapsed`, `tick` = `world.time.tick`.
  Evaluation reads with `listEntities`/`getComponent` only (no RNG, no
  change windows, no registration of a type no entity holds), so the strict
  snapshot hash and `describe().componentCounts` are unchanged; an uncaught
  error or a non-finite number result is `err({ kind: 'rule_eval_failed',
  rule: '<expr>', message })`.

