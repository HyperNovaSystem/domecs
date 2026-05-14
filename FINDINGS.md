# DOMECS — Code Review Findings

Focused review of the core engine (`@domecs/core`), DOM renderer
(`@domecs/dom`), and input plugin (`@domecs/input`) against the exemplar
workload targets in `doc/exemplars.md`. Scope: performance and developer
experience. Correctness, security, packaging, and spec conformance are
out of scope here.

Severity legend:

- **P0** — observable hot-path cost or footgun the exemplars will hit immediately.
- **P1** — measurable inefficiency or rough edge; matters at exemplar scale.
- **P2** — small redundancy, polish, or future-proofing.

## Status (2026-05-14)

The first wave of fixes — P-1, P-2, P-3, D-2, D-3, D-4 — landed on
`claude/code-review-findings-pjNzq`. Each is marked **RESOLVED** below with
the normative spec section that governs it and the test file that covers
it. Remaining items keep their original status.

---

## Performance

### P-1 (P0) — RESOLVED: `makeView` walks every component store, every call

`packages/domecs/src/world.ts:299-306`

```ts
function makeView(entity: Entity): EntityView {
  const view: Record<string, unknown> = { id: entity }
  for (const [name, store] of stores) {
    const v = store.get(entity)
    if (v !== undefined) view[name] = v
  }
  return view as EntityView
}
```

For every entity yielded from a query, `makeView` iterates **all** component
stores in the world — not just the entity's archetype. Harbor Authority
(20k entities, dozens of component types) and Fleet Pulse (500 vehicles,
500 events/s coalesced) will pay `O(componentTypes)` Map.gets per
`EntityView` per system per tick. For a system iterating 300 entities with
30 registered components, that's 9,000 Map.gets — most missing — instead
of the ~10 the archetype actually holds.

**Fix:** the entity's archetype already exposes the set of component names.
Iterate `entityArchetype.get(entity).types` and look up only those stores.

**Resolution.** `world.ts` `buildView` now iterates `entityArchetype.get(entity).types`,
so a view costs `O(entity-components)` Map.gets instead of
`O(registered-components)`. SPEC §2.4 *EntityView shape rule* (P-1) makes
this normative — a view MUST NOT carry keys for components the entity does
not hold. Tests: `packages/domecs/test/code-review-fixes.test.ts` —
"EntityView only carries the entity's own components".

### P-2 (P0) — RESOLVED: `query.entities` reallocates an `EntityView[]` and N view objects per access

`packages/domecs/src/world.ts:658-668`

```ts
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
```

Every read of `query.entities` allocates a fresh array and a fresh
`EntityView` object per matching entity. Touched once per system per tick
across every system that has a query — and once again per view per tick
inside `mount.ts:135`. Harbor's 20k-entity simulation cannot afford this
allocation churn under the 16 ms / 1 ms tick budgets the exemplar lists.

**Fix:** expose a non-allocating iteration path (`query.each(fn)` or
`query[Symbol.iterator]`) that yields a reusable view, or cache the
view objects keyed on entity id and invalidate only when the archetype
changes. The current eager-array shape is fine to keep for ergonomics but
should not be the only path.

**Resolution.** Took the cache route. `world.ts` keeps a
`viewCache: Map<Entity, EntityView>` invalidated in `moveEntity`,
`despawn`, and `restore`. Two consecutive `query.entities` reads of the
same entity return the same view object instance; per-tick view
allocation drops to "at most one per entity per archetype change."
SPEC §2.4 *EntityView caching rule* (P-2) makes the identity guarantee
normative. Tests: `code-review-fixes.test.ts` — three tests under
"EntityView caching (P-2)" cover identity, archetype invalidation, and
despawn invalidation.

A non-allocating `query.each(fn)` / iterator API is still attractive for
zero-alloc hot loops and remains a v0.2 follow-up; the caching fix
alone closes the per-tick allocation regression that motivated this
finding.

### P-3 (P0) — RESOLVED: default render path re-runs `update` for *every* mounted entity, every tick

`packages/domecs/packages/domecs-dom/src/mount.ts:132-149`

```ts
if (state.def.update && state.mounted.size > 0) {
  const changed = collectChanged(state.changedQueries)
  if (!changed) {
    for (const view of state.query.entities) {
      const rec = state.mounted.get(view.id)
      if (!rec) continue
      rec.view = view
      state.def.update(rec.el, view)
    }
  }
  // …
}
```

A `ViewDef` without `changedOn` causes the renderer to call `update`
against *every* mounted entity on *every* render tick. The README quick
start (and the Quick Start in this repo) shows a `Sprite` view with no
`changedOn` — so the default sample is also the slow path. For 300
mounted entities at 60 Hz that's 18k writes/sec just to mutate
`el.style.transform`, plus 300 fresh `EntityView` objects per frame from
`query.entities`.

**Fix:** make the renderer treat the missing-`changedOn` case as
"update only what `Changed(*)` reports", or require `changedOn` and fail
loudly when it's missing on a view with `update`. Either way, document
the default behaviour next to `defineView` so new users do not silently
ship per-frame full-table writes.

**Resolution.** Auto-derive (the principle-of-least-surprise option). A
`defineView` whose `changedOn` is omitted now redraws when any `Has(T)`
leaf in its query is marked changed. Three states are spec'd in
SPEC §5.3 *Update-gating rule* (P-3):

1. `changedOn` omitted → auto-derive from `Has(T)` leaves of the query.
2. `changedOn: []` (explicit empty) → legacy "redraw every tick"
   (kept as an escape hatch for time-driven animations).
3. `changedOn: [...]` → explicit gate.

`packages/domecs-dom/src/mount.ts` `resolveChangedTypes` does the
derivation; `@domecs/core` exports a new `collectHasComponents` helper
for any future consumer (inspector, other renderers). Tests:
`packages/domecs-dom/test/lifecycle.test.ts` —
"gates update on auto-derived Changed queries when changedOn is omitted (P-3)"
and "opts out of auto-derive when changedOn=[] (legacy 'update every tick')".

### P-4 (P1): `pendingCreate` / `pendingDestroy` views are dead in the destroy loop

`packages/domecs-dom/src/mount.ts:113-130`

```ts
for (const [id, view] of state.pendingDestroy) {
  const rec = state.mounted.get(id)
  if (rec) {
    state.def.destroy?.(rec.el, rec.view)
    rec.el.remove()
    state.mounted.delete(id)
  }
}
```

`view` is destructured but never read; the destroy path uses `rec.view`.
Functionally harmless, but it advertises that the `pendingDestroy` map
stores `EntityView` payloads that are never consumed — a few hundred extra
references per tick on long-running views, and a maintenance footgun.

**Fix:** store `Set<Entity>` instead of `Map<Entity, EntityView>` for both
pending sets, or document why the view is kept.

### P-5 (P1): `moveEntity` scans every registered query on every component add/remove

`packages/domecs/src/world.ts:228-253`

`addComponent` and `removeComponent` both go through `moveEntity`, which
walks the global `queries` array and performs two `Set.has` lookups per
query. With ~50 queries (live + observers + Changed-views), spawning a
10-component entity is 5 × 50 = 250 set lookups for the moves alone, plus
the 5 archetype re-keys via `archetypeKeyFor`. Compound that with Harbor's
batch spawns.

**Fix options:**

1. Build a per-archetype query-membership index: each `ArchetypeBucket`
   stores the set of queries that match it. `moveEntity` then walks
   `prev.queries XOR next.queries` instead of the full query list.
2. Batch the spawn path: compute the final archetype once instead of
   walking entity-empty → +1 → +2 → … for every component.

### P-6 (P1): `archetypeKeyFor` sorts and joins on every `ensureArchetype` call

`packages/domecs/src/world.ts:213-216`

```ts
function archetypeKeyFor(types: Set<string>): string {
  if (types.size === 0) return EMPTY_ARCH_KEY
  return Array.from(types).sort().join('|')
}
```

Called inside `moveEntity` for every component add/remove, this is
`O(k log k)` string work per mutation. Hot during initial world hydration
and bulk spawn.

**Fix:** cache archetype keys by `Set` identity (the existing immutable
`Set` per bucket), or maintain `next = prev ± name` by deriving the new
bucket from the previous bucket plus the delta (one `add(name)` /
`delete(name)` against a copy and a precomputed sorted key) rather than
re-sorting from scratch.

### P-7 (P1): `currentTypes` clones the archetype's type set on every add/remove

`packages/domecs/src/world.ts:371-374`

```ts
function currentTypes(entity: Entity): Set<string> {
  const arch = entityArchetype.get(entity)
  return arch ? new Set(arch.types) : new Set()
}
```

`addComponent`/`removeComponent` call this purely to mutate, then throw
the set away after `moveEntity`. For a 10-component entity that's 10
fresh sets per spawn, each cloned from a set that grows linearly.

**Fix:** pass `(prevArch, addName | undefined, removeName | undefined)`
into `moveEntity` and let it derive the next bucket directly. Avoids the
clone entirely.

### P-8 (P1): `Removed(X)` queries pollute `structuralMembers` with the entire world

`packages/domecs/src/world.ts:255-266` (and the seeding loop at
`world.ts:637-641`).

```ts
case 'removed': return true
```

Any query containing a `Removed` node matches **every** archetype at
structural eval, so when the query is created its `structuralMembers`
gets seeded with *every live entity*. Then `entities` re-filters per
tick. For a Harbor-scale world this is a 20k-entry `Set` per
`Removed(X)` query, plus the `collectCandidates` union work every tick.

**Fix:** treat `Removed` specially in seeding — `structuralMembers`
should hold only entities that pass the *non-removed* portion of the
query, and `collectCandidates` should layer `tickRemoved[X]` on top
(which it already does for the unioned set, just not for the seed).

### P-9 (P1): `mountDOM` runs every `update` callback even when nothing matched the `Changed` queries

`packages/domecs-dom/src/mount.ts:141-149`

When `changedOn` *is* provided but `Changed(c).entities` is empty,
`collectChanged` still returns an empty `Set` (not `null`), so the
`else if (changed.size > 0)` branch skips correctly — good. But
`collectChanged` itself drives `q.entities` reads on *every* `Changed`
query every tick, each of which re-runs the full query allocation in
P-2. For a view with five `changedOn` components, that's five extra
`EntityView[]` allocations per render even when none of them changed.

**Fix:** short-circuit via `q.size` first. Better, add a
`query.hasAny()` that uses `q.structuralMembers` for the no-filter case
and short-circuits on the first tick-filtered match otherwise.

### P-10 (P1): `entitiesWith` allocates a wrapper object per yield

`packages/domecs/src/world.ts:600-605`

```ts
*entitiesWith<T>(type) {
  for (const [id, value] of store) yield { id, value }
}
```

The docstring on `entitiesWith` advertises it as cheaper than
`query(Has(type))` + per-entity `getComponent`, but it still allocates
one `{id, value}` per entity. For Harbor's 5,000 cargo containers iterated
on every tick, that's 5k garbage objects per call.

**Fix:** yield `[id, value]` tuples and require destructuring, or pass a
callback (`world.eachWith(type, (id, value) => …)`). Same trade-off as
P-2.

### P-11 (P1): input plugin allocates ~6 fresh collections every tick

`packages/domecs-input/src/collector.ts:192-216`

```ts
function build(): InputSnapshot {
  const pressed = new Set(pressedNext)
  const released = new Set(releasedNext)
  // …
  return {
    keys: new Set(held),
    keyDelta: { pressed, released },
    mods: { ...mods },
    pointer: pSnap,
    gamepads: readGamepads(),
    focus: currentFocus(),
  }
}
```

Even with no input change, `build()` runs at `onTickStart` and allocates
two `Set` clones for `keys` and `pressed`, plus a fresh pointer snapshot,
mods clone, and `gamepads.map(...)`. For the Visual Novel exemplar (idle
most of the time) and Fleet Pulse (idle-ish), this is wasted churn on
every frame.

**Fix options:**

1. Skip publishing a new snapshot when nothing changed since the last
   one — track a `dirty` flag and reuse the previous snapshot reference
   (cheaper for downstream `Changed`/identity comparisons too).
2. Use a versioned, mutable snapshot whose contents are only re-cloned
   when consumers call a `freeze()` helper.

### P-12 (P1): `currentFocus()` and `readGamepads()` run twice per tick on the hot path

`packages/domecs-input/src/collector.ts:62-65, 192-216`

`shouldCaptureKeys()` calls `currentFocus()` on every keydown/keyup, and
`build()` calls it again at `onTickStart`. Each call does a
`doc.activeElement` read followed by an `el.matches(selector)` call —
the latter can force style/layout work in the browser.

**Fix:** memoize per tick (compute once in `build()`, reuse for the
remainder of the tick) or replace `matches()` with a tag/contenteditable
check.

### P-13 (P2): `scheduler.applyPendingReplacements` rescans every system every tick

`packages/domecs/src/scheduler.ts:192-198`

```ts
applyPendingReplacements(): void {
  for (const s of systems) {
    if (!s.pendingFn) continue
    s.fn = s.pendingFn
    delete s.pendingFn
  }
}
```

Called every tick from `world.step()`. With dozens of systems and
near-zero replacements per second, it's a wasteful scan.

**Fix:** keep a `pendingReplace: Set<CompiledSystem>` that `replaceFn`
adds to and `applyPendingReplacements` drains.

### P-14 (P2): `shouldKeepDriverAwake` rescans all once/tick/fixed systems on every wake check

`packages/domecs/src/world.ts:395-416`

Cheap individually but called inside `wakeDriver` (which fires on every
spawn/despawn/markChanged/setInput/emit/setScale/resume). For Harbor's
spawn bursts this is `O(systems)` work per spawn.

**Fix:** cache the `hasFrameSystems()` boolean and invalidate on
`system.register / remove / enable / disable`.

### P-15 (P2): `snapshot()` deep-clones recursively, unbounded depth

`packages/domecs/src/snapshot.ts:16-24`

`cloneSerializable` is a manual recursive walker. Two issues:

- For deeply nested narrative state (visual-novel transcripts, board-game
  move trees), it risks stack overflow.
- `structuredClone` is available in every supported runtime and is
  typically faster.

**Fix:** prefer `structuredClone(value)`; fall back to the manual path
only when it's not available.

### P-16 (P2): `snapshot()` runs synchronously and re-allocates the entire entity tree

`packages/domecs/src/world.ts:972-1000`

Harbor autosaves a 20k-entity world. The current path is one long
synchronous walk producing a fully-materialized object graph, deep-cloned.
That's a guaranteed jank spike.

**Fix:** either expose an async-yielding snapshotter (`for-await` over
chunks) or commit to a versioned diff snapshot in v0.2 (already on the
TODO under "diff snapshot ring buffer").

### P-17 (P2): queries are not deduplicated across systems

`packages/domecs/src/world.ts:618-700`

Every `world.query(def)` creates a fresh `CompiledQuery`, seeded by
walking every archetype. Two systems with identical query shapes hold
two independent structuralMember sets, each maintained by every
`moveEntity` call.

**Fix:** intern queries by a normalized key (component-name sets + tick
filter signature). Optional for v0.1 but free perf for big worlds.

### P-18 (P2): `spawn` walks queries on the empty archetype before components are added

`packages/domecs/src/world.ts:487-510`

Every spawn registers the entity in `emptyArch`, fires `onAdd` for any
query matching the empty archetype (typically `Not(Foo)` queries), then
walks each component and moves the entity again. Queries matching
`Not(Foo)` see the entity flicker into existence and out again as
components attach — both perf overhead and a correctness footgun for
hooks that touch the entity.

**Fix:** when `spawn(components)` is given a non-empty bag, compute the
final archetype before publishing the entity to any query.

---

## Developer experience

### D-1 (P0): default `defineView` updates everything; no compile-time or runtime nudge

Same site as P-3. Beyond perf, this is a DX trap: nothing in the
`ViewDef` shape, the README, or the renderer tells a new user that
`update` runs against every mounted entity per tick when `changedOn` is
absent. Halls/Roguelike example likely already pays this without
realising it.

**Fix:**

- Make `changedOn` required (or default to "all components in the query"
  derived automatically from `def.query`).
- Add a one-paragraph note in `defineView`'s docstring describing the
  default cost.
- Consider a `viewMode: 'always' | 'changed' | 'auto'` discriminator.

### D-2 (P0) — RESOLVED (partial): `EntityView` is `{ readonly [k: string]: unknown }` — no inferred component types

`packages/domecs/src/query.ts:27-30`

Users who `query([Position, Velocity])` get back views where every
component is `unknown`. Every system body needs `(e.Position as Pos).x`,
defeating the "TypeScript-first" claim from the README. The fact that
`query` accepts a tuple of `ComponentType<T>` means inference is
*possible*; it's just not wired up.

**Fix sketch:**

```ts
function query<T extends readonly ComponentType<any>[]>(
  ...types: T
): QueryResult<ViewFromTuple<T>>
```

This is a meaningful refactor (the `QueryDef` shape today also accepts
combinator nodes whose `T` is harder to recover), but at minimum the
array-form shorthand should infer.

**Resolution.** `ComponentType<T, Name extends string = string>` now
carries the literal name as a second type parameter; `defineComponent`
has a dual-overload signature; `EntityView<Fields>`, `QueryResult<Fields>`,
`QueryHooks<Fields>`, and `ViewDef<Fields>` are all parameterized. The
tuple-form query overload `world.query([Position, Velocity] as const)`
produces a `QueryResult` whose view fields are typed.

**Partial because:** TypeScript does not perform partial type-argument
inference, so capturing the literal `Name` requires the dual-type-arg
form `defineComponent<T, 'Name'>('Name')`. The single-arg form
`defineComponent<T>('Name')` still works (and remains the example in most
docs for casual cases) but widens `Name` to `string`, and views built
from such types fall back to the unconstrained shape. SPEC §2.4
*EntityView typing rule* (D-2) calls this out as the rule, not a bug.
Combinator-form queries (`Has`/`And`/`Or`/`Not`/`Changed`/…) are still
unconstrained — typed inference only wires through the tuple form for
now. Tests: `code-review-fixes.test.ts` —
"typed query EntityView (D-2)" exercises both the typed and combinator paths.

Follow-up: a curried `component('Name').schema<T>()` builder would let
callers skip the duplication without losing type capture; deferred until
v0.2 once the API stabilises.

### D-3 (P0) — RESOLVED: `setScale(0)` silently corrupts `pause`/`resume`

`packages/domecs/src/world.ts:735-748`

```ts
setScale(scale) { time.scale = scale; if (scale > 0) wakeDriver() },
pause()          { if (time.scale !== 0) preResumeScale = time.scale; time.scale = 0 },
resume()         { if (time.scale === 0) time.scale = preResumeScale; wakeDriver() },
```

`setScale(0.5)` → `setScale(0)` → `resume()` restores to `1`, not `0.5`,
because `pause` is the only writer to `preResumeScale`. Harbor's
"pause / 1× / 4× / 16× / 64×" speed control will hit this if any UI binds
`setScale` to a slider that passes through 0.

**Fix:** `setScale(0)` should run `pause()` semantics; `setScale(x>0)`
on a paused world should run `resume()` semantics. Or simply have
`setScale` always update `preResumeScale` to `Math.max(scale, time.scale, preResumeScale)` such that resume picks the right value.

**Resolution.** `setScale(0)` now behaves identically to `pause()`;
`setScale(x>0)` always updates `preResumeScale` and resumes if the
world was paused. Negative and non-finite scales throw. SPEC §2.7
*Scale-control rule* (D-3) is the normative anchor. Tests:
`code-review-fixes.test.ts` — five tests under "setScale semantics (D-3)"
cover the pause-equivalence, resume restoration, repeated zero-positive
toggles, and the validation throws.

### D-4 (P1) — RESOLVED: `world.__wake` is an undocumented private contract

`packages/domecs/src/world.ts:1074` /
`packages/domecs-input/src/collector.ts:36`

```ts
;(world as World & { __wake?: () => void }).__wake = wakeDriver
```

`@domecs/input` casts `world` to fish out `__wake` so that external event
handlers can rouse the idle RAF driver. This is a real capability — every
external-source plugin (Dashboard's WebSocket feed) will need it — but
right now it's a typed-as-`unknown` side-channel that's invisible to
plugin authors.

**Fix:** promote it to a first-class API:

- `world.requestTick()` / `world.poke()` on the public `World` interface.
- Or expose it as a capability: `world.capability('driver').wake()`.

**Resolution.** `world.requestTick()` is now part of the public `World`
interface. `@domecs/input` calls it through that path; the
`world.__wake` side channel is kept as a deprecated alias for one
release cycle and slated for removal in v0.2. SPEC §3 *External wake
API rule* (D-4) is normative. Tests: `code-review-fixes.test.ts` —
"world.requestTick (D-4)" covers the headless no-op case and the wake
of a sleeping idle loop against a stubbed RAF harness.

### D-5 (P1): `Plugin.install` returning `PluginHandle | void` invites latent bugs

`packages/domecs/src/plugin.ts:7`

`void` lets `install` end without an explicit return, which works fine
but also silently swallows any handle returned from a branch the author
forgot to return. `PluginHandle | undefined` is the same shape without
the silent drop.

**Fix:** change the return type to `PluginHandle | undefined`. Cheap;
enables `noImplicitReturns` to catch missed paths.

### D-6 (P1): `addComponent` throws on re-add; no upsert helper

`packages/domecs/src/world.ts:550-566`

```ts
if (store.has(entity)) {
  throw new Error(`domecs: entity ${entity} already has component "${type.name}"`)
}
```

Hard error, no `world.set(entity, type, value)` that does add-or-replace.
This is correct for catching bugs but forces every "set or upsert"
caller (think Dashboard updating live vehicle telemetry) to write:

```ts
if (world.has(e, T)) {
  Object.assign(world.getComponent(e, T)!, value)
  world.markChanged(e, T)
} else {
  world.addComponent(e, T, value)
}
```

**Fix:** add `world.setComponent(entity, type, value)` with documented
upsert semantics that internally chooses add-or-replace and calls
`markChanged` on the replace path.

### D-7 (P1): `SystemHandle.replaceFn?` is typed optional but always defined

`packages/domecs/src/scheduler.ts:33-40, 173-176`

```ts
export interface SystemHandle {
  // …
  replaceFn?(fn: System): void
}
```

The scheduler always assigns it, but consumers have to null-check or `!`
through it. Either it's optional (and the docstring should explain when
it isn't supplied) or it isn't.

**Fix:** make it required. Removes the `?` everywhere.

### D-8 (P1): two paths to remove a system, one of which leaks queries

`packages/domecs/src/scheduler.ts:164-172, 184-190`

`SystemHandle.remove()` disposes `compiled.query` and `compiled.reactsTo`.
`Scheduler.remove(s)` does not. Anyone holding a `CompiledSystem` and
calling the scheduler-level method ends up with orphaned queries.

**Fix:** collapse to one implementation, or have the scheduler-level
`remove` call into the handle-level cleanup.

### D-9 (P2): `scheduler.systemsByMode` returns the live internal array

`packages/domecs/src/scheduler.ts:180-182`

`world.step` iterates the returned array with `for (const s of ...)`. If
a system disables/removes itself or registers a new system during
execution, the iteration sees the live array under it. The order isn't
guaranteed safe across the loop, and registration of a higher-priority
system during the same tick can sort it ahead of the cursor depending on
sort stability.

**Fix:** return a snapshot (`arr.slice()`), or document the invariant
that systems must not mutate scheduler state during their own tick.

### D-10 (P2): `WorldOptions` accepts `headless: boolean` and a separate `idle: boolean`, but `start()` errors mix the two

`packages/domecs/src/world.ts:892-910`

```ts
if (headless) {
  throw new Error('domecs: World.start() is disabled for worlds created with headless=true; …')
}
if (typeof g.requestAnimationFrame !== 'function' || …) {
  throw new Error('domecs: World.start() requires requestAnimationFrame; use step(dt) in headless environments')
}
```

The first error blames the user's option, the second blames the
environment, but a non-`headless` world in a Node process gets the second
error — which then suggests `step(dt) in headless environments` even
though the user didn't set `headless: true`. Confusing for the test-author
path (the most common reason this triggers).

**Fix:** unify the messages. "World.start() requires `requestAnimationFrame`
(not available in this environment, or disabled by `headless: true`).
Use `step(dt)` for headless / Node use."

### D-11 (P2): `restore()` skips `type.create()` — components bypass defaults and `validate`

`packages/domecs/src/world.ts:1043-1069`

Restore stores raw values directly into the component maps:

```ts
store.set(rec.id, cloneSerializable(value))
```

If a saved snapshot was taken before a component added a required field
(or before its `defaults` grew), restored entities silently miss the new
field. The `validate` callback never runs. Today's migration path
(`onRestore` plugin hook) is the official answer, but the engine could
catch the easy case for free.

**Fix:** when restoring a value for a known `ComponentType`, run
`type.create(value)` so defaults fill and validate trips. Unknown types
keep today's raw behaviour for round-trip safety.

### D-12 (P2): plugin uninstall doesn't check reverse dependencies

`packages/domecs/src/plugin.ts:54-65, 92-104`

Install checks that `plugin.depends` are already installed, but
uninstalling a plugin doesn't check whether any other installed plugin
depends on it. The capability owner gets deleted; downstream plugins
silently lose their dependency.

**Fix:** track reverse-dependency edges and either refuse to uninstall
or tear down dependents first.

### D-13 (P2): `mountDOM` queues `pendingCreate` at install time but renders only inside `onRender`

`packages/domecs-dom/src/mount.ts:75, 79-89`

If a caller does `world.use(mountDOM(world, …))` and never calls
`world.start()` / `step()`, nothing renders — the entities sit in
`pendingCreate` indefinitely. This will burn an afternoon at least once
per user.

**Fix:** either commit the initial pending queue synchronously when the
plugin installs (analogous to "first render is sync"), or document the
constraint loudly in `mountDOM`'s docstring.

### D-14 (P2): `start()` and `stop()` overlap with the returned disposer

`packages/domecs/src/world.ts:892-960`

`start()` returns a disposer that calls `world.stop()`. Both are valid
ways to halt the driver. Most users will keep both around and call them
inconsistently in cleanup paths.

**Fix:** pick one. Either drop `world.stop()` (rely on the disposer) or
drop the return value (rely on `world.stop()`).

### D-15 (P2): `entry()` exists but the README example bypasses it

`packages/domecs/src/types.ts:39-41` vs. `README.md:162-166`

The README's `world.spawn([...])` uses bare tuples
(`[Position, { x: 100, y: 100 }]`). Under strict TS that fails to infer
per-tuple `T` and forces `as never` casts at the call site (the very
problem `entry()` was added to solve, per the comment in `types.ts`).

**Fix:** update the README snippet to use `entry(Position, …)`. The
exemplar code in `example/` is already a good place to confirm the
expected idiom.

### D-16 (P2): `quantizeMs` is exported but unused inside the engine

`packages/domecs/src/time.ts:24-26` / `packages/domecs/src/index.ts:5`

The function is exported but `world.ts` reimplements the same quantize
logic inline at `world.ts:796` (`Math.round(totalScaledSeconds * 1000)`).
Either keep it shared and use it from `world.ts`, or drop the export.

### D-17 (P2): `cloneSerializable` is exported only via `snapshot.ts` import but `WorldSnapshot.meta` is `Record<string, unknown>` with no clone guarantees

`packages/domecs/src/snapshot.ts:13`

Plugin `onSnapshot` can stash anything into `snap.meta`, but the snapshot
machinery only deep-clones inside `world.snapshot()` — not at plugin
extension time. Authors will hit "I mutated my plugin state and my
saved snapshot mutated with it" once.

**Fix:** either deep-clone `meta` on the way out, or document explicitly
that plugin authors own the cloning.

---

## Smaller observations (P2, terse)

- `packages/domecs/src/events.ts:36-91` — `EventBus.emit` is duplicated
  inline in `createEventBus` and inside `makeView`. They can share one
  implementation.
- `packages/domecs/src/events.ts:78-90` — direct subscribers fire at
  flush, which means a same-tick `world.on(...)` registered *before*
  `flush` sees this-tick events; one registered after misses them.
  Documented behaviour is "fires at flush time"; might warrant a
  one-line warning.
- `packages/domecs/src/world.ts:174` — `rafVisHandler` is typed
  `(() => void) | null`, but `g.document.addEventListener` and
  `removeEventListener` are typed `Function`. Tighten to
  `EventListener` for safer call sites.
- `packages/domecs/src/world.ts:600-605` — `entitiesWith` returns
  `Iterable<{id, value}>`; not `IterableIterator`, so callers can't
  spread or call `.next()` directly. Tighten the return type.
- `packages/domecs/src/world.ts:1010-1026` — `restore()` uses
  `prevMembers[q.id]` indexed by `q.id`, which is the per-world
  monotonic id. After `dispose()`, gaps appear in `q.id`, so
  `prevMembers` is sparse. Works (`?? []`) but is fragile.
- `packages/domecs-dom/src/mount.ts:14` — `mountedSlots` is a
  module-level `WeakMap`. Multi-world editor scenarios share this
  registry; that's fine, but worth a comment so a future "isolate
  per host" change doesn't break it.

---

## Recommended sequencing

If only a handful of these are taken on in v0.1:

1. ~~**P-1, P-2, P-3, D-1**~~ — *first-wave landed 2026-05-14.* P-3
   resolved together with D-1 via auto-derive. The renderer / query / view
   hot path no longer reallocates view objects per tick, the default
   redraw gate is sane, and `EntityView` no longer touches unrelated
   stores.
2. ~~**D-2, D-3, D-4**~~ — *first-wave landed 2026-05-14.* Typed views
   ship for tuple-form queries (with the documented dual-type-arg caveat),
   `setScale` semantics are sane, and `world.requestTick()` is the
   public wake path.
3. **P-5, P-7, P-8** — next up. These are required before Harbor can
   credibly simulate 20k entities under the SPEC's tick budget.

Everything else can wait for v0.2 without invalidating the public API.

---

## Resolution summary (2026-05-14)

| Finding | Resolution | Spec rule                                | Tests                                    |
|---------|------------|------------------------------------------|------------------------------------------|
| P-1     | resolved   | SPEC §2.4 EntityView shape rule          | core/code-review-fixes.test.ts           |
| P-2     | resolved   | SPEC §2.4 EntityView caching rule        | core/code-review-fixes.test.ts           |
| P-3     | resolved   | SPEC §5.3 Update-gating rule             | dom/lifecycle.test.ts                    |
| D-1     | resolved   | (folded into P-3)                        | dom/lifecycle.test.ts                    |
| D-2     | partial    | SPEC §2.4 EntityView typing rule         | core/code-review-fixes.test.ts           |
| D-3     | resolved   | SPEC §2.7 Scale-control rule             | core/code-review-fixes.test.ts           |
| D-4     | resolved   | SPEC §3 External wake API rule           | core/code-review-fixes.test.ts           |

Spec deltas land in `doc/SPEC.md` (§2.4, §2.7, §3, §5.3) and `doc/api.md`
(`defineComponent` overloads, `EntityView<Fields>`, `World.query` typed
overload, `ViewDef<Fields>`, `world.requestTick`).
