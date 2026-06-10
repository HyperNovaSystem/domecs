# DOMECS — Consolidated Findings & Audit Reference

_Last updated: 2026-06-10 (post-v1.0 freeze)._

This is the **single** post-v1.0 findings reference for the DOMECS engine. It
merges the 2026-05-29 29-agent engine audit (the A/B/C priority synthesis) with
the durable design input mined from the per-exemplar audits, the **2026-06-01
engine review** (formerly `doc/FINDINGS.md` — its open items are O-20…O-26
below), and the fleet O-16 repro recipe (formerly `doc/FINDINGS_fleet.md`).
Both former `doc/` files were folded in here on 2026-06-10 and deleted —
git history retains the originals.

The exemplar apps that produced these findings (Halls, Harbor, Fleet, Tessera,
Lighthouse, Studio, Railroad, Prism, the Vite template, etc.) now live in
**separate standalone repos**. Their findings are kept here as *design history /
forward design input*, not as live per-app trackers. Resolved/vestigial content
has been deliberately purged — git history retains the originals.

Cross-references:
- `doc/LEGIBILITY.md` — the six legibility laws (all enforced as of v1.0).
- `doc/api.md` + `doc/api-surface/` — the authoritative type contract.
- `doc/SPEC.md` — runtime semantics.
- `ROADMAP.md` — the home for the v0.2+/deferred items below.

---

## 1. Status — what shipped in v1.0

The 2026-05-29 review's **A-tier** (additive/bugfix) and most of its **B-tier**
landed in the v1.0 break. These are recorded as closed; do not re-litigate.

### Bug fixes (verified shipped)
- **restore() prevMembers id/index mismatch** — `onRemove` mis-fired on restore
  after any query dispose. Fixed (index by array position).
- **reactive `ctx.entities` for `reactsTo`-only systems** — reactive systems
  declared with only `reactsTo` now receive the tick-filtered delta in
  `ctx.entities` (previously `[]`).

### Additive engine surface (verified shipped)
- `ComponentValue<typeof C>` value-type extractor (`types.ts`).
- `describeError(e)` + `getErrorRepairHint(e)` total formatters over the closed
  `DomecsError` union (`errors.ts`).
- `tap` / `tapErr` Result side-effect combinators (`result.ts`).
- `definePlugin(spec)` authoring helper (`plugin.ts`) — wraps bare handles,
  passes `name/version/depends/provides` through. Plugin `install` returns
  `Result<PluginHandle | void, DomecsError>`.
- `defineResource` + `world.getResource/setResource/markResourceChanged` +
  `OnChangedResource(R)` query node + resources in the snapshot envelope.
- One-shot leak-free selectors: `world.countEntities` / `listEntities` /
  `selectViews` (compile-time reject reactive `On*` nodes).
- `world.action(type, payload, opts)` → `{ accepted, consumedTurn, reason,
  events, snapshot? }`; `turn()` stays void. `stepOnce`/`stepN` split out.
- Schema reflection: `defineComponent(..., { schema })`, `world.describeComponent`,
  `describeResource`, `describeEvent`, and the composed
  `world.describe(): WorldManifest` (+ `InspectorView.export()`).
- `@domecs/persist`: `save(world, storage, slot, opts?)` stamps a `meta`
  envelope (`savedAt` + caller/plugin meta); `createSnapshotHistory` +
  `diffSnapshots` (undo/redo, branch truncation, diff); `pruneTransientOnlyEntities`.

### Packaging / docs (verified shipped)
- All five packages declare `sideEffects: false`.
- `api.md` synced to shipped types (no `createPersistence` facade; correct
  `Plugin`/`InspectorOptions`/`MountOptions`/plugin-install Result shape);
  inline `ts doctest` fences run in CI (L6).
- `defineComponent` name-widening is now a **documented** TS limitation: a
  `const Name` overload infers a string-literal name when type args are not
  explicitly constrained; the dual-overload trade-off is in the docstring.
- `defineEvent` payload tick-delay (emit on tick N → visible to `event` systems
  on N+1) is documented and doctested.

### Resolved post-freeze — doc-accuracy pass 2026-06-10 (commit e9b4103)
The 2026-06-01 engine review's three doc-drift highs/mediums are fixed:
- **Persistence docs drift** (review #1) — README/SPEC rewritten around the
  shipped `save`/`load`/`Storage`/`createMemoryStorage` API; the
  `createPersistence` / IndexedDB / autosave facade is now explicitly marked
  *planned* (SPEC §7.2–7.3, ROADMAP).
- **`world.resource(R)` → `world.getResource(R)`** (review #2) — all
  user-facing mentions corrected.
- **README status/roadmap contradiction** (review #5) — roadmap split into
  shipped-in-v1.0 / planned (`@domecs/sprites`, `@domecs/worker`, IndexedDB
  facade) / indefinitely deferred (Svelte/React adapters); SPEC package list
  split shipped vs planned. Same pass also fixed `start()`→`startLoop()`,
  `step()`→`stepOnce()`, `Changed/Added/Removed`→`On*` drift in `api.md`.

---

## 2. Open / actionable (still informs design)

These were surfaced by the exemplars and are **not** yet shipped. Tagged by the
review tier they map to.

| # | Finding | Source apps | Tier | Notes |
|---|---------|-------------|------|-------|
| O-1 | **Async IndexedDB `Storage` adapter** — `createLocalStorageStorage(prefix?)` shipped 2026-06-09 (resolves the original localStorage half of this finding; it lives in the main `@domecs/persist` entry, kept host-safe via lazy `globalThis` resolution rather than a `/web` subpath). The async IndexedDB adapter remains open. | Railroad, Lighthouse, Halls | B | `Storage` interface itself is clean (4 Result-returning methods). |
| O-2 | **DOM view first paint on mount** — under default `changedOn: auto`, an entity spawned then left untouched (e.g. content created in a paused `once` system) is *mounted* but never `update()`d, so it renders empty/at (0,0) until some unrelated change marks it. Either run `update()` once on mount, or document the "static entities need `{mode:'legacy'}`" trap in the `defineView`/`ChangedOn` docstring (currently undocumented). | Railroad | A | Engine still gates the first `update()` behind the changed-set (`mount.ts`). |
| O-3 | **Pause-gating boundary** — `tick`/`fixed` are gated off at `setScale(0)`, so control input (resume/save/build hotkeys) read inside a `tick` system goes dead while paused; the working pattern is reading from the always-fires `tickStart` signal. Document which hooks fire at scale 0 vs not; consider an opt-in `runWhilePaused` system flag for pure UI/control logic. | Railroad | B | The signal-vs-system split is correct but undocumented and easy to get wrong. |
| O-4 | **Batch mutation helpers** — `markChangedMany(Component, ids)` / scoped mutation batches for systems touching thousands of entities/tick. | Harbor, Fleet | C | Fold into a perf pass; only large-sim scale benefits. |
| O-5 | **Virtualized / windowed DOM helpers** — selective rendering today means structural component churn (`Visible`, `TableRow` add/remove → mount/unmount churn). Want: a virtual-list / `TileMapView` / viewport-window adapter that recycles nodes without mutating entity archetypes, plus renderer metrics (created/destroyed/updated counts) to catch accidental full remounts. | Fleet, Harbor, Halls, Lighthouse | B/v0.2 | Recurring across every scale exemplar. |
| O-6 | **Keyed reconciliation primitives** — editors/projection code rebuild transient view entities by despawn+respawn each sync, generating noisy Added/Removed traffic. Want reusable `key → entity/view` reconciliation (update-in-place, removed keys despawn) so apps stop hand-rolling a mini retained-mode renderer. | Studio, Fleet | B | Pairs with O-5. |
| O-7 | **Secondary-index / relationship plugin pattern** — `indexBy(Component, field)`, range indexes (`indexRange(Telemetry,'speed')` instead of scanning `Where`), one-to-many/many-to-one/nullable entity-ref indexes, and dangling-ref integrity on despawn. | Harbor, Fleet | C/v0.2 | `Where` stays the ergonomic fallback; expose when a hot range query scans too many. |
| O-8 | **Spatial index with occupancy layers** — `firstAt/allAt(layer,x,y)`, `isBlocked(x,y,mask)` for terrain/actor/item/interactable/FOV-blocker layers. | Halls | v0.2 | Roguelike-shaped; subsumes part of O-7. |
| O-9 | **Async / chunked snapshot at scale** — sync `snapshot()` + `JSON.stringify` janks at 20k entities; define an async/chunked API and keep snapshot data structured-clone-safe for future Worker hosting. | Harbor, Fleet | v0.2 | |
| O-10 | **Worker-host system boundary** — closure-heavy systems (closing over `world`, DOM, helpers) can't move off-main-thread. Needs a constrained serializable system-definition subset + a documented sim-vs-presentation split. | Harbor, Lighthouse | v0.2 | |
| O-11 | **Canonical snapshot serializer/hash** — determinism/replay tests compare `JSON.stringify(snapshot())`, which only works while key order is incidentally stable. Provide a canonical serializer/hash. | Tessera | v0.2 | Serves the determinism/replay milestone. |
| O-12 | **Multi-world `EntityRef`** — raw numeric entity ids are ambiguous once tooling opens multiple guest worlds / compares snapshots / preserves selection across restore. Want an optional world identity/label + `EntityRef { worldId, entity }` for editor-facing APIs. | Studio | v0.2 | Core stays numeric-id internally. |
| O-13 | **Scene schema/codec registry** — name-keyed restore holds opaque component bags until matching `ComponentType`s register later. An explicit scene-load flow should consult schemas/codecs, report unknown component types, and surface them as inspectable unknowns. | Studio | v0.2 | Builds on the now-shipped schema reflection. |
| O-14 | **Benchmark harnesses tied to exemplar budgets** — behavioral tests prove correctness, not frame/tick budgets. Want headless-by-default harnesses (e.g. 20k entities @ 64×; 500 telemetry updates/s) tracking query iteration, event delivery, snapshot size/time, DOM mount/update counts, heap growth. | Harbor, Fleet, Studio | B/ongoing | |
| O-15 | **Bounded logical substepping** — at high time-scale one browser frame becomes one very large tick; systems assuming ~60 Hz break. Want `start({ maxSimStep, maxSubsteps })` and explicit `tick`/`fixed`/fast-forward/render-cadence relationship in SPEC. | Harbor | C/v0.2 | Railroad's `fixed` accumulator under `setScale` already covers the common case. |
| O-16 | ~~Orphaned DOM nodes survive a same-tick remove-all/re-add view rebuild~~ — **fixed 2026-06-10**. Root cause confirmed exactly as suspected: for an entity removed and re-added within one commit window, `onAdd` cancels the pending destroy (node survives, correct), the create-phase double-create guard skips the mounted node, and the `OnChanged` gate never fires — a re-add is an *Added* mark, not a *Changed* mark — so the surviving node was neither rebuilt nor repainted. Fix in `mount.ts commit()`: re-added entities are tracked and force-repainted in the update phase (views with `update()`), or their node is destroyed+rebuilt (create-only views, where `create()` is the only painter). 4 regression tests in `domecs-dom/test/readd-reconcile.test.ts` follow the repro recipe below (assert rendered-content *set*, not child count; between-tick + in-system rebuilds; partial-overlap window; create-only view). | Fleet | A | Closed. |

| O-17 | ~~`mountDOM` leaks queries + subscriptions on its error paths~~ — **fixed 2026-06-09**: the `unregistered_slot` / `plugin_install_failed` returns now dispose every already-built `ViewState` (unsub + `query.dispose()` + changed queries) alongside the slot-claim rollback; regression test in `domecs-dom/test/slots.test.ts`. | Railroad (2026-06-09 v1.0 migration audit) | A | Closed. |
| O-18 | ~~`restore()` bypasses validators~~ — **fixed for resources 2026-06-09**: registered resource types validate before any state is wiped (mirrors `setResource`; invalid ⇒ throw with the world untouched, `persist_io` via `load()`). Component values stay un-revalidated by design — the live path validates only at `Component.create()`, in-place field mutation never re-validates, so restore-validating components would reject legitimately reachable states. Documented in `api.md`. | Railroad (2026-06-09 v1.0 migration audit) | B | Closed (resources); component trust boundary now documented. |
| O-19 | ~~Idle driver spins at `setScale(0)` when tick systems exist~~ — **fixed 2026-06-09**: `hasFrameSystems()` now applies the same `time.scale !== 0` gate to tick systems that `step()` does; paused worlds still get frames for rendering via the mutation wake path (`hasPendingComponentWork` / bus pending). | Railroad (2026-06-09 v1.0 migration audit) | C | Closed. |
| O-27 | ~~Phantom `T` on the `ResourceType` brand~~ — **fixed 2026-06-10**: `ResourceType<T, Name>` (`types.ts`) declared `T` without referencing it in the body, so (1) consumers compiling engine *source* under `noUnusedParameters`/`noUnusedLocals` failed `TS6133` at `types.ts(98)` — `skipLibCheck` can't help, it's a `.ts` file (see the "engine-source-is-public-surface" recipe note above) — and (2) the type was structurally non-generic: ResourceTypes of different `T` were mutually assignable (a `Roster` handle passed where a `Score` was expected typechecked, letting `setResource` accept the wrong value shape) and `ResourceValue<R>`'s `infer T` couldn't discriminate. The `__resourceTag` brand now carries `(value: T) => void` — type-level only, `defineResource` never materializes the property — making `T` load-bearing and distinct-`T` resources non-assignable. Pinned in `types.test.ts` (mutual-assignability `@ts-expect-error` both directions + `ResourceValue` discrimination). | Prism, Vite template (2026-06-10 strict-flag consumer audit) | A | Closed. |
| O-28 | **`load()` collapses "missing slot" into generic `persist_io`** — a first-run boot (`load(world, storage, slot)` on a slot that was never written) returns the same `{ kind: 'persist_io', op: 'load' }` as real I/O failures, distinguishable only by the cause-message string (`slot "X" is empty`). Apps that treat first run as normal (every browser app with a boot restore) must pre-probe `storage.read(slot)` for `ok(null)` and only call `load()` when the slot exists — workable (`Storage.read` documents missing ⇒ `ok(null)`), but every consumer re-derives the two-step dance. Want a distinct signal: a `slot_missing`-style discrimination on the error, `Result<boolean>` ("loaded?"), or a blessed `loadIfPresent` helper. | Harbor (2026-06-10 persist adoption) | B | `persist.ts load()`; first-run is the *common* path, not the error path. |
| O-29 | **`save()` reports no stored-envelope size** — `save()` returns `Result<void>`, so an app wanting a save-size stat (Harbor's autosave HUD readout, quota forecasting against the ~5MB localStorage cap) must `JSON.stringify(world.snapshot())` a second time: double full-world serialization per autosave at scale (compounds O-9), and the figure only *approximates* the persisted payload because `save()` builds its own envelope with injected `meta` (`savedAt` + caller meta). Want `ok({ bytes })` (or the serialized length surfaced some other way) so the app-side re-serialization disappears. | Harbor (2026-06-10 persist adoption) | C | `persist.ts save()` already has the string in hand; returning its length is free. |
| O-30 | **`world.componentTypes()` can't enumerate defined-but-unused components** — the type registry is use-based (a `ComponentType` registers on first `spawn`/store access; `defineComponent` and `describeComponent` do *not* register), so reflection consumers under-report until every type has been touched: Studio's `reflectedComponentTypes` stat reads 7 of its 8 schema'd Guest components until the first crate prefab instantiates `GuestPrefabSource`, and its name→type edit-resolution map had to refresh-on-miss instead of build-once. Want an opt-in eager registration (e.g. `world.register(C)`) or a documented enumerate-defined-types path for editor tooling. | Studio (2026-06-10 schema adoption) | B | `world.ts` typeRegistry; builds on shipped schema reflection, pairs with O-13's unknown-type surfacing. |
| O-31 | **`createSnapshotHistory` stores full snapshots and exposes no size stats; `diffSnapshots` is entity-level only** — replacing Studio's diff-ring deleted its compaction demo: the engine history keeps a full `WorldSnapshot` per checkpoint (vs the ring's per-tick diffs + periodic base checkpoints — a real memory delta at scale) and surfaces nothing like `compactBytes`/`fullSnapshotBytes`, while `diffSnapshots(prev, next)` returns only added/removed/changed entity-id lists (no per-component granularity, no byte sizes). Want optional diff-compacted storage and/or size + changed-component stats on `SnapshotHistory`. | Studio (2026-06-10 history adoption) | C | Compounds O-9 (snapshot cost at scale) and O-29 (no byte counts anywhere in persist). |
| O-32 | **`startLoop` `pauseOnHidden` auto-resume tramples app-managed pause** — the default-on visibility handler calls `hooks.resume()` *unconditionally* on tab re-show (`driver.ts:118-126`), even when the pause was the app's own deliberate `world.pause()` (a Pause button), desyncing app pause-state from the world. Both Prism and the Vite template had to opt out with `pauseOnHidden: false` to keep a manual Pause control coherent. Want provenance-aware resume (only resume a pause the auto-path itself initiated); document the interaction either way. | Prism, Vite template (2026-06-10 v1.0 repair) | B | Default-on footgun; every app with a pause control hits it. |
| O-33 | **No browser-importable build for no-build consumers** — `@domecs/*` `exports` resolve to TypeScript source (`./src/index.ts`), so a zero-build static-ESM app cannot consume the engine without adopting a bundler. This blocked Halls from adopting `createLocalStorageStorage` even though it is exactly Halls' hand-rolled localStorage code. Want a prebuilt browser-ESM dist (a `dist/` exports condition or CDN artifact) importable from a plain `<script type="module">`. | Halls (2026-06-10 audit) | C/v0.2 | Packaging; pairs with the `create-domecs` CLI item in §3. |

### O-16 reproduction recipe (fleet, 2026-05-31) — resolved 2026-06-10

Kept for the testing lesson (assert the rendered-content *set*, not the child
count). The recipe is now pinned as regression tests in
`packages/domecs-dom/test/readd-reconcile.test.ts`; the fleet-side mitigation
below is no longer required.

Confirmed deterministic repro — no real browser needed. Mount a view over
`Has(TableRow)` whose `create`/`update` paint a per-entity *rank* into the node,
then in one tick run a projection that `removeComponent(TableRow)` over the
whole current window and `addComponent(TableRow)` for a freshly-sorted window
(partial membership overlap). After a single `world.step`, the slot retains
stale nodes carrying their PRE-sort rank.

- **The trap that hid it:** the rendered row *count* stays correct (`= size`,
  e.g. 50) — the corruption is duplicate/stale *content*, not extra nodes. A
  test asserting only `childElementCount` passes while the DOM is visibly
  wrong. Assert the set of rendered ranks equals `1..N` (no duplicates), not
  just the length.
- **Observed signature in fleet** (seed `0x51ee7`, window 50, sort speed desc
  from the initial callsign-asc order): stale ranks `3,4,17,18,27,28,41,42`
  survive as duplicates. Reproduces under rAF `startLoop` in a browser and in
  jsdom via manual `world.step` — see `fleet_app/test/fleet.dom.test.ts`.
- **Fleet-side mitigation (does not fix the engine):** `sim.ts
  rebuildTableRows()` updates `TableRow` in place keyed by entity (remove only
  leavers, add only enterers, mutate survivors) so the view never sees a mass
  component exit. Any consumer doing hand-rolled despawn+respawn in one tick
  still corrupts the DOM.

### Engine review 2026-06-01 — open items

Open remainder of the 2026-06-01 engine review (its #1/#2/#5 are resolved —
see §1 "Resolved post-freeze"). Severity in the Tier column.

| # | Finding | Tier | Notes |
|---|---------|------|-------|
| O-20 | ~~`changedOn` docs still describe the removed array API~~ — **fixed 2026-06-10**: `doc/api.md` ViewDef block now declares the `ChangedOn` discriminated union, `doc/SPEC.md` §5.3 gating rules rewritten to `{mode:'auto'\|'legacy'\|'explicit'}`, `packages/domecs-dom/README.md` examples updated. | High (doc) | Closed. |
| O-21 | ~~`action(..., { dt: 0 })` returned the action event as a "downstream" event~~ — **fixed 2026-06-10** (option c, heartbeat semantics kept): on an explicit `dt <= 0` the result is now `{ accepted: false, consumedTurn: false, events: [] }` with a heartbeat reason, the resolver is not invoked, and the action stays buffered for the next real tick. 5 regression tests in `action.test.ts`; `api.md` + docstrings updated. | High (code) | Closed. |
| O-22 | ~~Review-history comments leak into shipped source~~ — **fixed 2026-06-10**: `review #N`/`#17`/`D-4` parentheticals stripped from all `packages/*/src`; **`world.__wake` removed** (untyped cast-only escape hatch marked "remove after v0.2"; the v1.0 break already migrated consumers to `world.requestTick()`). `F-6` kept — it is referenced by name in api.md/SPEC as a stable label. Test-name `(review #N)` suffixes kept (maintainer-facing). | Med | Closed. |
| O-23 | ~~`world.ts` is a ~1,900-line multi-responsibility module~~ — **fixed 2026-06-10**: extracted in three slices, zero behavior change. `src/driver.ts` (rAF state + frame/wake/startLoop/stop behind a `DriverHooks` interface), `src/world-resources.ts` (resource registry/values/change-set pair, `createResourceState`), `src/world-state.ts` (`buildSnapshot`/`applySnapshot` over a `WorldStateCtx`; plugin onSnapshot/onRestore chains stay in the factory as orchestration; F-3 step counters grouped into a shared `StepClock`). `world.ts` 1,920 → 1,577 lines; barrel untouched (`api:check` green); 360 tests + doctest green. | Med | Closed. |
| O-24 | ~~`reactiveResourceFallback` semantics undocumented~~ — **resolved 2026-06-10**: SPEC §4 step 6 already carried the normative "Resource-gated reactive fire" paragraph and `resources.test.ts` already pins both forms (bare-resource in an entity-less world with empty `ctx.entities`; `And(Has(Hud), OnChangedResource(Score))` scoping); added the implementation note + the two code examples the review asked for. | Med (doc) | Closed. |
| O-25 | ~~Snapshot docs implied structured-clone behavior~~ — **fixed 2026-06-10**: SPEC §7 now states the plain-data/JSON contract explicitly (no structured-clone codec; `Date`/`Map`/`Set`/class instances not preserved; cyclic values overflow during `snapshot()`; non-plain data must be transient); api.md "structurally-cloneable handoff" corrected. Dev-only cycle validation remains optional/unscheduled. | Low | Closed (docs). |
| O-26 | ~~Fault result shape-check permissive~~ — **fixed 2026-06-10**: `strictReturns` now also validates each fault entry (`{ error: { kind: string, ... }, recoverable: boolean }`); malformed entries get a one-shot-per-system `console.warn` and are skipped instead of producing an undefined-kind `FaultEntry`. Permissive default path unchanged. 4 tests in `errors.test.ts`; `error-handling.md` updated. | Low | Closed. |

### Recipe / documentation gaps (no engine change required)
These are recurring patterns the exemplars each re-discovered; the fix is a
blessed recipe or example, not new API:
- **Durable-log pattern** — event buffers are intentionally transient; durable
  history (transcript, game log) must be a component/resource. Document the
  "event in → append to durable component" pattern and snapshot semantics for
  event buffers. (Lighthouse, Tessera, Halls)
- **Post-restore transient-view rebuild** — `onRestore`/`afterRestore` convention
  (or a `deriveViews` helper) for rebuilding transient projection entities from
  persistent state. Harbor's boot restore re-seats `Viewport` + re-emits
  `FocusBerthEvent` from the browser shell for exactly this reason. (Lighthouse, Harbor)
- **History + snapshot-redaction ordering** — `createSnapshotHistory(world,
  { captureInitial })` takes its baseline through whatever `onSnapshot` plugin
  hooks are installed *at construction time*; create the history only **after**
  `world.use(redactionPlugin)` or the baseline checkpoint leaks unredacted
  state. (Studio)
- **`createSnapshotHistory` vs `save()`/`load()` decision guide** — linear
  undo/redo (bounded ring, cursor, redo-branch truncation) vs **named slots**
  with per-slot `meta` (label/thumbnail/…) over a `Storage` adapter. Apps with
  a saves panel want `save()`/`load()`, not a history shoehorn; apps with
  undo buttons want history. Document in the `@domecs/persist` README.
  (Lighthouse)
- **Preferences vs world-state split** — operator preferences (columns, sort,
  filters) usually persist separately from disposable live feed state. (Fleet)
- **External-feed adapter** — queue → coalesce by entity/key → emit one batch
  event/frame; expose event-buffer pressure metrics; optional drop/coalesce
  policy while keeping game/sim events lossless by default. (Fleet, Harbor)
- **Script/DSL → events plugin pattern** for narrative/data-driven spawning,
  with condition/effect/validation examples. (Lighthouse)
- **Local UI-state projection** — transient component vs controller-side repaint,
  and how each interacts with snapshot/restore. (Tessera, Studio)
- **Stable domain ids for replay/network** (`owner,index`) instead of raw entity
  ids; resolution tables kept out of hot systems. (Tessera)
- **Deterministic clock policy** — local-trusted / server-authoritative /
  adjudicated, with command-payload time (`spentMs`) keeping rules off wall-clock. (Tessera)
- **Status-effect lifecycle** exemplar plugin — merge/refresh stacking, tick-down
  on accepted turn, expiration hooks, snapshot-safe data. (Halls)
- **Text/UI DOM recipes** — ordered keyed list views, event-emitting button
  views, transcript rendering, tooltips (entity/resource-backed hover text with
  a11y labels), accessible dialogue markup, rich-text/typewriter without a
  permanent RAF loop. (Lighthouse, Halls)
- **Multi-view projection** is confirmed central (one state → many DOM regions);
  keep it prominent in `@domecs/dom` docs. (All exemplars)
- **RNG helpers** — `int/range/pick/roll/fork` ship; `oneOf/weighted/shuffle`
  still wanted; plus a documented way to expose seed/state for save debugging.
  (Halls)
- **Engine-source-is-public-surface** — workspace apps consuming `@domecs/*` via
  `file:`/`exports→src` typecheck engine sources directly under their strict
  config (`noUnusedParameters`, `noUncheckedIndexedAccess`). Keep engine tsconfig
  aligned with the strictest advertised consumer config, or run that exact
  `tsc --noEmit` against engine sources in CI. (Prism)
- **`api-surface` gate is barrel-only** — the no-drift snapshot captures
  `dist/index.d.ts` (the re-export barrel), not interface *bodies*, so adding a
  method to an exported interface (e.g. `World.getSystem`) produces no snapshot
  diff and the gate stays green. Adequate for catching added/removed exports;
  does not catch interface-shape changes. Note when relying on it. (observed 2026-05-31)

---

## 3. Deferred / needs a design decision (C-tier & v0.2+)

Park these in `ROADMAP.md`:

- **`capability-typing`** — `CapabilityMap` augmentation so `world.capability(name)`
  is typed without triple-casts. Typing-contract change.
- **`dispatch` alias** — pure sugar over `turn()`/`action()`; settle the naming
  after `action()` has soaked.
- **`componenttype-redaction`** — general exclude-set in one `SnapshotOptions`
  pass; redaction at the ComponentType layer (by capability/schema flag) rather
  than string-matching serialized component names (Studio's brittle name-keyed
  redaction). (Studio)
- **`canonical-snapshot-hash`** — see O-11; tie to the determinism/replay
  milestone.
- **v0.2+ architectural roadmap**: range index (O-7), spatial layers (O-8),
  worker host (O-10), async/chunked snapshot (O-9), virtualized views (O-5),
  multi-world `EntityRef` (O-12), scene schema registry (O-13), benchmark
  budgets (O-14).
- **`create-domecs` CLI** — a separate publishable scaffolding package
  (release-infra, not engine API). Must: emit a workspace variant
  (`--workspace <path>` with `file:` deps and no `DOMECS_LOCAL_DEV` alias
  branch), copy only tracked files (`git ls-files`, not the dir verbatim, so
  stale `dist/` isn't seeded), and strip `.git/`/`node_modules/`. (Prism, Vite
  template)

