# DOMECS — Consolidated Findings & Audit Reference

_Last updated: 2026-07-16 (WS-0/WS-2 adoption tranche)._

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
- `PLAN.md` — the governing post-v1.0 plan (priorities, stop-doing list, kill gates).
- `../doc/LEGIBILITY.md` — the six legibility laws (all enforced as of v1.0).
- `../doc/api.md` + `../doc/api-surface/` — the authoritative type contract.
- `../doc/SPEC.md` — runtime semantics.
- `../doc/ROADMAP.md` — the itemized feature queue for the v0.2+/deferred
  items below (subordinate to `PLAN.md`).

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
| O-2 | ~~**DOM view first paint on mount**~~ — **fixed 2026-07-16**: `commit()` calls `update()` once when a node is created, so static entities under `changedOn: auto`/`explicit` first-paint correctly. Subsequent updates stay change-gated. Regression tests in `domecs-dom/test/lifecycle.test.ts`. | Railroad | A | Closed. |
| O-3 | **Pause-gating boundary** — `tick`/`fixed` are gated off at `setScale(0)`, so control input (resume/save/build hotkeys) read inside a `tick` system goes dead while paused; the working pattern is reading from the always-fires `tickStart` signal. **Documented 2026-07-16** (README + `doc/api.md`); opt-in `runWhilePaused` system flag remains open/demand-driven. Lyceum re-hit this independently: a `tick`-schedule control system could pause but never resume; working pattern was moving pause/speed outside the world. | Railroad, Lyceum | B | Doc half closed; `runWhilePaused` stays fuel. |
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
| O-14 | **Benchmark harnesses tied to exemplar budgets** — largely **shipped 2026-07-16/17** as the in-repo `bench/` suite (soak, telemetry firehose with coalescing ratio, windowed projection, snapshot size/time + stepped determinism, plain baseline, Koota/signals compare with warmup + GC isolation + work-equivalence checks). Remaining open (PLAN WS-1): heap growth / GC pressure sampling, per-frame DOM mount/update/remove split, dropped frames, multi-machine stability. | Harbor, Fleet, Studio | B/ongoing | `pnpm bench`; see `bench/README.md` Methodology. |
| O-15 | **Bounded logical substepping** — at high time-scale one browser frame becomes one very large tick; systems assuming ~60 Hz break. Want `start({ maxSimStep, maxSubsteps })` and explicit `tick`/`fixed`/fast-forward/render-cadence relationship in SPEC. | Harbor | C/v0.2 | Railroad's `fixed` accumulator under `setScale` already covers the common case. |
| O-16 | ~~Orphaned DOM nodes survive a same-tick remove-all/re-add view rebuild~~ — **fixed 2026-06-10**. Root cause confirmed exactly as suspected: for an entity removed and re-added within one commit window, `onAdd` cancels the pending destroy (node survives, correct), the create-phase double-create guard skips the mounted node, and the `OnChanged` gate never fires — a re-add is an *Added* mark, not a *Changed* mark — so the surviving node was neither rebuilt nor repainted. Fix in `mount.ts commit()`: re-added entities are tracked and force-repainted in the update phase (views with `update()`), or their node is destroyed+rebuilt (create-only views, where `create()` is the only painter). 4 regression tests in `domecs-dom/test/readd-reconcile.test.ts` follow the repro recipe below (assert rendered-content *set*, not child count; between-tick + in-system rebuilds; partial-overlap window; create-only view). | Fleet | A | Closed. |

| O-17 | ~~`mountDOM` leaks queries + subscriptions on its error paths~~ — **fixed 2026-06-09**: the `unregistered_slot` / `plugin_install_failed` returns now dispose every already-built `ViewState` (unsub + `query.dispose()` + changed queries) alongside the slot-claim rollback; regression test in `domecs-dom/test/slots.test.ts`. | Railroad (2026-06-09 v1.0 migration audit) | A | Closed. |
| O-18 | ~~`restore()` bypasses validators~~ — **fixed for resources 2026-06-09**: registered resource types validate before any state is wiped (mirrors `setResource`; invalid ⇒ throw with the world untouched, `persist_io` via `load()`). Component values stay un-revalidated by design — the live path validates only at `Component.create()`, in-place field mutation never re-validates, so restore-validating components would reject legitimately reachable states. Documented in `api.md`. | Railroad (2026-06-09 v1.0 migration audit) | B | Closed (resources); component trust boundary now documented. |
| O-19 | ~~Idle driver spins at `setScale(0)` when tick systems exist~~ — **fixed 2026-06-09**: `hasFrameSystems()` now applies the same `time.scale !== 0` gate to tick systems that `step()` does; paused worlds still get frames for rendering via the mutation wake path (`hasPendingComponentWork` / bus pending). | Railroad (2026-06-09 v1.0 migration audit) | C | Closed. |
| O-27 | ~~Phantom `T` on the `ResourceType` brand~~ — **fixed 2026-06-10**: `ResourceType<T, Name>` (`types.ts`) declared `T` without referencing it in the body, so (1) consumers compiling engine *source* under `noUnusedParameters`/`noUnusedLocals` failed `TS6133` at `types.ts(98)` — `skipLibCheck` can't help, it's a `.ts` file (see the "engine-source-is-public-surface" recipe note above) — and (2) the type was structurally non-generic: ResourceTypes of different `T` were mutually assignable (a `Roster` handle passed where a `Score` was expected typechecked, letting `setResource` accept the wrong value shape) and `ResourceValue<R>`'s `infer T` couldn't discriminate. The `__resourceTag` brand now carries `(value: T) => void` — type-level only, `defineResource` never materializes the property — making `T` load-bearing and distinct-`T` resources non-assignable. Pinned in `types.test.ts` (mutual-assignability `@ts-expect-error` both directions + `ResourceValue` discrimination). | Prism, Vite template (2026-06-10 strict-flag consumer audit) | A | Closed. |
| O-28 | ~~**`load()` collapses "missing slot" into generic `persist_io`**~~ — **fixed 2026-07-16**: shipped `loadIfPresent` → `ok(true)` loaded / `ok(false)` missing / `err` for real failures; empty-slot `load()` now `retryable: false`. | Harbor (2026-06-10 persist adoption) | B | Closed. |
| O-29 | **`save()` reports no stored-envelope size** — `save()` returns `Result<void>`, so an app wanting a save-size stat (Harbor's autosave HUD readout, quota forecasting against the ~5MB localStorage cap) must `JSON.stringify(world.snapshot())` a second time: double full-world serialization per autosave at scale (compounds O-9), and the figure only *approximates* the persisted payload because `save()` builds its own envelope with injected `meta` (`savedAt` + caller meta). Want `ok({ bytes })` (or the serialized length surfaced some other way) so the app-side re-serialization disappears. | Harbor (2026-06-10 persist adoption) | C | `persist.ts save()` already has the string in hand; returning its length is free. |
| O-30 | **`world.componentTypes()` can't enumerate defined-but-unused components** — the type registry is use-based (a `ComponentType` registers on first `spawn`/store access; `defineComponent` and `describeComponent` do *not* register), so reflection consumers under-report until every type has been touched: Studio's `reflectedComponentTypes` stat reads 7 of its 8 schema'd Guest components until the first crate prefab instantiates `GuestPrefabSource`, and its name→type edit-resolution map had to refresh-on-miss instead of build-once. Want an opt-in eager registration (e.g. `world.register(C)`) or a documented enumerate-defined-types path for editor tooling. | Studio (2026-06-10 schema adoption) | B | `world.ts` typeRegistry; builds on shipped schema reflection, pairs with O-13's unknown-type surfacing. |
| O-31 | **`createSnapshotHistory` stores full snapshots and exposes no size stats; `diffSnapshots` is entity-level only** — replacing Studio's diff-ring deleted its compaction demo: the engine history keeps a full `WorldSnapshot` per checkpoint (vs the ring's per-tick diffs + periodic base checkpoints — a real memory delta at scale) and surfaces nothing like `compactBytes`/`fullSnapshotBytes`, while `diffSnapshots(prev, next)` returns only added/removed/changed entity-id lists (no per-component granularity, no byte sizes). Want optional diff-compacted storage and/or size + changed-component stats on `SnapshotHistory`. | Studio (2026-06-10 history adoption) | C | Compounds O-9 (snapshot cost at scale) and O-29 (no byte counts anywhere in persist). |
| O-32 | ~~**`startLoop` `pauseOnHidden` auto-resume tramples app-managed pause**~~ — **fixed 2026-07-16**: visibility handler only resumes a pause the driver initiated; app-managed `world.pause()` survives tab re-show. Tests in `lifecycle.test.ts`. **2026-07-17 residuals:** `stop()` now relinquishes a driver-owned pause (a stop+startLoop cycle while hidden no longer orphans the world at scale 0); the remaining known limit — app `pause()` taken *while hidden* after the driver claimed ownership is still auto-resumed on re-show — is documented on `StartOptions.pauseOnHidden` (apps driving pause from background logic should pass `pauseOnHidden: false`). | Prism, Vite template (2026-06-10 v1.0 repair) | B | Closed (limit documented). |
| O-33 | **No browser-importable build for no-build consumers** — workspace `exports` still point at TypeScript source for monorepo DX; **npm-published packages already resolve to `dist/` via `publishConfig`** (verified on registry 1.0.0). Import-map / no-build docs **shipped 2026-07-16** (`doc/PACKAGING.md`); cold-install smoke **scripted 2026-07-16** (`pnpm cold-install`, packed tarballs — the exact publish payload; opt-in `RUN_COLD_INSTALL=1` test). Remaining gap: wiring the cold-install gate into a release/CI path. | Halls (2026-06-10 audit) | C/v0.2 | Packaging; pairs with the `create-domecs` CLI item in §3. |
| O-34 | ~~**`spawn()` shallow-copies component values — undocumented divergence trap**~~ — **documented 2026-07-16** on `World.spawn` JSDoc + CHANGELOG. Correct pattern: capture entity id and `getComponent`. Dev-mode warning / deep-freeze remains demand-driven. | Lyceum (2026-06-10 MVP build) | B | Doc closed. |
| O-35 | ~~**One-shot `keyDelta` edges are invisible to low-rate `fixed` systems**~~ — **documented 2026-07-16** in `@domecs/input` README: edges are render-tick-scoped; edge-triggered handling belongs on `tick` (or use held `keys`). Per-schedule edge latching remains demand-driven. | Lyceum (2026-06-10 MVP build) | B | Doc closed. |
| O-36 | **Resources can't be marked transient/snapshot-excluded** — entities have `pruneTransientOnlyEntities`, but every registered resource value unconditionally enters the snapshot envelope. Render-only or derived resources (camera offsets, HUD caches, anything rebuilt on boot) bloat saves and, worse, get *restored* over freshly-derived state on `load()`. Lyceum kept all its resources persistable to stay safe, folding render state into per-frame recomputation instead. Want a `defineResource(name, { transient: true })` flag (skip on snapshot, keep live value on restore), mirroring the entity-side transient story. | Lyceum (2026-06-10 MVP build) | C | `world-resources.ts` + `world-state.ts buildSnapshot`; symmetric gap with the entity transient mechanism. |
| O-37 | ~~**`stepOnce()` never fires `fixed` systems**~~ — **documented 2026-07-16** on `World.stepOnce` / `doc/api.md`: fixed systems need positive dt so the accumulator advances; headless fixed-schedule tests should use `step(fixedStep)`. Optional `{ dt }` on stepOnce remains demand-driven. | Lyceum (2026-06-10 MVP build) | B | Doc closed. |
| O-38 | ~~**Snapshots don't carry the entity-id cursor**~~ — **fixed 2026-07-17**: `snapshot()` records `nextId` and `restore()` sets the cursor to `max(snap.nextId, maxAliveId + 1)` (optional field — older snapshots fall back to the derived cursor; the max() guard prevents a corrupt cursor from re-issuing live ids). The original repro (live spawn → id 2, post-reset spawn → id 1 after a max-id despawn pre-baseline) is pinned as a regression test in `agent-bridge.test.ts`; SPEC §7.1 states the contract. | 2026-07-17 tranche review (R-7) | B | Closed. |
| O-39 | ~~**`action()`/`bridge.act()` accepts malformed payloads as `accepted: true`**~~ — **fixed 2026-07-17**: when the event declares a `schema`, `action()` validates the payload before emitting — unknown fields, wrong-typed declared fields, out-of-`options` enum values, or a non-object payload return `{ accepted: false, consumedTurn: false, reason, events: [] }` with no emit and no tick advance. Declared-but-absent fields are optional (FieldSchema has no required-marker); schema-less events and `turn()`/`emit` stay unvalidated by design. Plantroom's command events now declare schemas (dogfood); the `CommandResult` resolver pattern remains the domain-level adjudication layer on top. Tests in `action.test.ts`; SPEC action semantics updated. | 2026-07-17 tranche review (R-8) | B | Closed. |
| O-40 | ~~**`restore()` does not continue the live timeline**~~ — **fixed 2026-10-13**: (1) the clock was zeroed on restore (`time.elapsed`, fixed accumulator, F-3 counters), so `fixed` systems — divisor-rate ones especially — fired on different frames than the live world; snapshots now carry `scaledTime` (+ `fixedBacklog` and its `fixedStep` when a `tickStart` pause left steps owed; optional, no version bump) and restore re-derives the clock with the tick's own expressions. (2) Live queries iterated in join order, one-shot selectors and `iterEntitiesWith` archetype by archetype or store order, while restore rebuilt membership by id — per-entity `rand` draws diverged; all query iteration and `Where` evaluation is now ascending entity id (SPEC §8 wording updated: archetype creation order is not restorable). Live queries and archetype buckets keep an id-ordered set (`id-set.ts`) with lazy, bounded merge of out-of-order joins. (3) Restore validates the envelope the `onRestore` hooks produce before touching world state, and a failed restore leaves pending events as they were. Lockstep live-vs-restored tests (fresh twin via JSON, same-world rewind, `tickStart`-pause backlog) in `restore-continuity.test.ts`; SPEC §7.1 lists what restore still does not carry (pending events, out-of-tick change marks, time scale, system state, `once` re-fire in a fresh world, captured `world.rand`). Codex-reviewed (PR #12). | 2026-10-13 engine review (C1) | A | Closed. |
| O-41 | ~~**A failed load wipes the live world**~~ — **fixed 2026-10-14**: `applySnapshot` cleared every store before reading entity records, and persist's `isWorldSnapshot` checked only top-level types, so a malformed record (`{id: 3}` with no `components`) or a buggy user migration threw after the wipe — `load()` returned `persist_io` and left 0 entities. `validateSnapshot` now checks the whole envelope before any effect: `seed` (four finite numbers), `tick` and `nextId` (integers ≥ 0), `resources` (object), and every entity record (object, unique integer `id` ≥ 0, object `components`). `history.load` gets the same guarantee through `restore()`. Tests in `kernel-hardening.test.ts` and persist `load-failure.test.ts`. Extends O-18. | 2026-10-13 engine review (C2) | A | Closed. |
| O-42 | ~~**In-tick change marks are dropped at the next step 0**~~ — **fixed 2026-10-14** (owner chose per-system change ticks): change sets were cleared at step 0, so a system that ran earlier in a tick than the writer never saw the mark — tick systems gated on `OnChanged` fed by event/reactive systems, the deferred reactive re-trigger SPEC §4.1 promised, and marks made in render/`tickEnd`. Every mark is now stamped into one change log (`change-log.ts`); a system's `query`/`reactsTo` reports the marks since its previous run ended (never its own writes), any other live query the marks since the last tick it was read. Nothing resets at tick boundaries; removal marks are pruned once every `OnRemoved` reader has seen them. Snapshots carry the marks a system has not seen plus each system's position (`WorldSnapshot.changes`, optional, no version bump), so restore stays exact — now also for out-of-tick mutations. An idle driver stays awake while an enabled reactive system or a renderer-style query would act on an unseen mark. Cursors are keyed `name#k` on name clashes; spent `once` systems are not readers; removal reads look up by stamp, so a held-back prune cannot make reads quadratic. A review subagent found ten defects in the first cut (restore ticking an idle loop, duplicate names, live-vs-restored snapshot drift, `once` systems pinning marks, quadratic removal reads, idle re-triggers); all are fixed and pinned in `change-windows.test.ts`. `observe()` hands `onChange` the reactive delta. SPEC §2.4, §2.9 (I-2 restated, buffer-and-swap replaced by change windows), §2.11, §4.0, §4.1, §7.1. `change-windows.test.ts`. Bench: soak faster, windowed equal, telemetry ~+8% p50. | 2026-10-13 engine review (C3) | A | Closed. |
| O-43 | ~~**The schedule is mutated while it is being iterated**~~ — **fixed 2026-10-14**: each phase looped over the live per-mode array that `remove()` spliced and `register()` pushed and re-sorted, so a self-removing system skipped the next one and a system added mid-phase could run a neighbour twice; the tie-break `registrationIndex = systems.length` repeated after removals. Per-mode arrays are now copy-on-write, a removed system is flagged and skipped by a phase already iterating it, and the tie-break is the scheduler's monotonic id. SPEC §3 states the rule. | 2026-10-13 engine review (C4) | A | Closed. |
| O-44 | ~~**Component defaults are shared by reference across entities**~~ — **fixed 2026-10-14**: `create()` did `{...defaults, ...value}`, so a nested array or object in `defaults` was one instance shared by every entity (and stopped being shared after a restore). `create()` now clones arrays and plain objects in `defaults` per entity (symbol keys, null prototypes and cycles preserved); other objects keep their identity. SPEC §2.2. Adjacent to O-34 (caller values, unchanged). | 2026-10-13 engine review (C5) | A | Closed. |
| O-45 | ~~**One throwing system stops the rAF loop**~~ — **fixed 2026-10-14**: the driver scheduled the next frame after `step()` returned, so a throw ended the loop (`idle: false`) or stalled it until an outside wake. The next frame is now scheduled in a `finally`; the error still propagates out of the rAF callback for the host to report. SPEC §3 Idle suspension. The renderer half (a throwing view callback jams every later commit) is O-53. | 2026-10-13 engine review (C6) | B | Closed. |
| O-46 | ~~**A captured `world.rand` keeps its old stream after restore**~~ — **fixed 2026-10-14**: restore replaced the generator object, so `const rng = world.rand` kept drawing the abandoned timeline. Restore now rewinds the generator in place (`rewindRng`, internal). SPEC §7.1. | 2026-10-13 engine review (C7) | B | Closed. |
| O-47 | ~~**Views of despawned entities are cached forever**~~ — **fixed 2026-10-14**: `OnRemoved` reads built and cached a view per despawned id, and ids are never reused, so worlds with churn grew without bound (22 MB vs 4 MB over 200k cycles). `makeView` no longer caches views of dead ids. | 2026-10-13 engine review (C8) | B | Closed. |
| O-48 | ~~**`restore()` does not wake an idle driver**~~ — **fixed 2026-10-14**: after a restore under `startLoop` the DOM stayed stale until something else woke the loop (the engine cause of R-12). `restore()` now asks an idle driver for one heartbeat frame (`driver.repaint()`: hooks and render, no tick), so the restored state is painted and the world stays at the checkpoint — a plain wake would have run a 1 ms tick, moving undo/`reset()` one tick past it. A mutation before that frame upgrades it to a normal wake step. Tests in `kernel-hardening.test.ts` and dom `restore-repaint.test.ts`. | 2026-10-13 engine review (C9) | C | Closed. |
| O-49 | ~~**Archetype keys collide when a component name contains `|`**~~ — **fixed 2026-10-14**: the key was the sorted names joined with `|`, so `{"a|b"}` and `{"a","b"}` shared a bucket. The key is now the JSON-encoded sorted name list. | 2026-10-13 engine review (C10) | C | Closed. |
| O-50 | ~~**AGENTS.md recommends spawning in `onRestore`, which restore then wipes**~~ — **fixed 2026-10-14** (docs): plugin `onRestore` runs before `applySnapshot`, so anything it spawns is cleared. The post-restore recipe now says to rebuild right after `restore`/`load` returns, or in a boot `once` system in a fresh world. An `afterRestore` hook remains an option if the call-site pattern proves awkward. | 2026-10-13 engine review (C11) | C | Closed (docs). |
| O-51 | ~~**Agents cannot discover commands from `observe()`**~~ — **fixed 2026-10-14**: `world.system()` records an event system's `triggers` as known event types, and `describe().events` entries are `describeEvent()` descriptors (`name`, `fields`, `fieldsSource`), so a schema-declared command is listed with its fields before anything emits it. Was: an event type appeared only after it was emitted or subscribed, with no schema. A type that is only ever passed to `act()` still appears once used (O-30 territory). | 2026-10-13 engine review (C12) | B | Closed. |
| O-52 | ~~**`Where` in a DOM view query breaks the view lifecycle**~~ — **fixed 2026-10-14**: views created/destroyed nodes from structural `onAdd`/`onRemove`, which ignore `Where`, so a non-matching spawn got a node and an entity that started matching never did. A view whose query has a `Where` now reconciles its pending creates/destroys against the filtered `query.entities` at each commit. Temporal nodes (`On*`) in a view query return the new `invalid_view_query` MountError. SPEC §5.1; dom `where-view.test.ts`. | 2026-10-13 engine review (D1) | A | Closed. |
| O-53 | ~~**One throwing view callback jams the renderer**~~ — **fixed 2026-10-14**: each commit takes over the pending maps before any callback runs and isolates every `create`/`update`/`destroy`, so a throw affects only its entity; all views still commit and the first error is rethrown afterwards (teardown likewise). A failed create is retried when the entity is marked changed on a redraw trigger. Core now closes the tick's change windows in a `finally`, so a renderer that threw is not handed the same marks (and the same throw) every frame. Was: the pending maps were not cleared, so every later commit threw on the same entity, later views never committed and `tickEnd` never fired. SPEC §4.1 step 8, §5.3. | 2026-10-13 engine review (D3) | B | Closed. |
| O-54 | ~~**Change-gated commit is O(all entities) per changed type**~~ — **fixed 2026-10-14**: core keeps a stamp-ordered log of `OnAdded`/`OnChanged` marks for each type some query reads, and such a query takes its candidates from the marks in its window when they are fewer than a quarter of its members; the DOM update phase visits only the changed, created and re-added entities instead of every view member. 50k entities: idle commit 0.90 → 0.010 ms, one change 10.6 → 0.028 ms; soak/telemetry/windowed benches unchanged within noise (logs exist only while a reader does). Was: `collectChanged` scanned every holder of the component and one change rebuilt the whole `query.entities` array. SPEC §2.4. | 2026-10-13 engine review (D4) | B | Closed. |
| O-55 | ~~**DOM projection details**~~ — **fixed 2026-10-14**: (D2) `create` gets the commit-time view (`world.getView`), with components added after the entity matched; `destroy` keeps the last view the renderer held. (D5) auto mode also redraws on `Where(T, …)` leaves; a view with `update` and no trigger (no positive `Has`/`Where` leaf, or `explicit` with `types: []`) is the new `invalid_changed_on` MountError instead of silently redrawing every tick. ~~(D6) heartbeat repaint~~ — fixed by O-42. (D7) each `mountDOM` installs its own renderer plugin, so a world takes several mounts on distinct slots; SPEC §5.6 now says a slot collision returns `slot_already_mounted` (it said "throws"). | 2026-10-13 engine review (D2, D5–D7) | C | Closed. |
| O-56 | ~~**Input: keys stuck held after a focus change**~~ — **fixed 2026-10-14**: `onKeyUp` returned early while a text input had focus, so a key pressed in the game and released in a textarea stayed held; with an element `keyTarget`, held keys cleared only on window blur. Releases are now always processed (presses still pass through to text inputs), and an element `keyTarget` releases held keys on `focusout` to outside itself (under `clearOnBlur`). input `stuck-input.test.ts`. | 2026-10-13 engine review (I1) | A | Closed. |
| O-57 | ~~**A heartbeat `step(0)` eats input edges**~~ — **fixed 2026-10-14**: plugin `onTickStart`/`onRender`/`onTickEnd` now receive `TickInfo` (`{ heartbeat }`, exported); on a heartbeat the input collector publishes current held keys and position but no edges or deltas, keeping them for the next tick's systems (a first cut also published the edges on the heartbeat, so a `tickStart` hotkey saw a press twice). Was: the collector consumed them in `onTickStart` on heartbeats, where no system runs, so they were lost (R-12 recommends exactly this repaint). SPEC §4.0, §9.4. | 2026-10-13 engine review (I2) | B | Closed. |
| O-58 | ~~**Input teardown leaves the last snapshot live**~~ — **fixed 2026-10-14**: teardown now resets `world.input` to an empty snapshot, so the last edges no longer replay every tick. | 2026-10-13 engine review (I3) | B | Closed. |
| O-59 | ~~**Input details**~~ — ~~(I4) pointer buttons stick~~ — fixed 2026-10-14: `pointercancel` and window blur clear `buttons`, `lostpointercapture` takes the event's own `buttons`; ~~(I5)~~ documented 2026-10-14 (SPEC §6, input README): a press fires once per `fixed` sub-step; edge-triggered input belongs on `tick` systems — no latch added; ~~(I6)~~ fixed 2026-10-14: the `pointerTarget` doc now says coordinates are client coordinates (as SPEC §6 says), the first move sets the position without a delta, pointer lock uses `movementX/Y`, and the default text-input selector (`TEXT_INPUT_SELECTOR`, exported) excludes checkboxes/radios/ranges/buttons and includes `select` and `contenteditable=""`. | 2026-10-13 engine review (I4–I6) | C | Closed. |
| O-60 | ~~**Inspector fault capture**~~ — ~~(N1) faults appended after the inspector's observer ran were missed~~ — fixed by O-42 (inspector `late-fault.test.ts`); ~~(N2) restore duplicated history~~ — fixed 2026-10-14: while a restore is applied (`onRestore` until the next frame), a fault whose entity, source, kind, tick, component and detail match a recorded entry is skipped; outside a restore, identity alone decides, so a fault raised again after a rewind, or by another fixed sub-step, is still recorded (a first cut deduped by content always and dropped those); ~~(N3)~~ fixed 2026-10-14: filtered views copy the timeline as well as the entries, the buffers are rings with O(1) amortized push (was `entries.shift()` per push), and the README reads `entry.systemId`. | 2026-10-13 engine review (N1–N3) | B | Closed. |
| O-61 | ~~**Pruning drops bare parent entities and orphans the hierarchy**~~ — **fixed 2026-10-14**: `setParent` rejects a parent that is not alive (new `world.isAlive(entity)` in core); the scene README gives groups a persistent component and says why; the prune plugin's docs (README, doc comment, api.md) state that it runs on every `snapshot()`, history included, and that an entity others refer to by id needs a persistent component. Pruning itself is unchanged: persist cannot tell which ids other components refer to. Was: `pruneTransientOnlyEntities` removed entities with no serializable components while the scene README parented children under a bare `world.spawn()`, so save/load and history undo deleted live group entities; `setParent` accepted a dead or never-created parent. | 2026-10-13 engine review (P1) | B | Closed. |
| O-62 | ~~**History cursor and `retryable` on failed loads**~~ — **fixed 2026-10-14**: (P2) `undo`/`redo` moved the cursor before a restore that can throw, leaving the index on a checkpoint the world was not showing; a throwing restore now puts the cursor back (it still moves first, so code running inside the restore sees the new position). (P4) corrupt JSON, non-snapshot payloads, unserializable snapshots (BigInt, cycles) and restore rejections returned `retryable: true`, so callers honoring the flag would loop; they now return `retryable: false` (storage I/O failures stay retryable). Tests in persist `load-failure.test.ts`. | 2026-10-13 engine review (P2, P4) | C | Closed. |
| O-63 | ~~**Persist validation gaps**~~ — **fixed 2026-10-14**: (P3) `migrate()` rejects a step that does not produce exactly version N+1, and `world.restore()` throws on a snapshot newer than `SNAPSHOT_VERSION` (and on a non-integer `version`). (P5) `registerComponentTypes` checks the document's shape (non-array `data`, entries or fields without a string `name`, entries without `fields`) and reports instead of throwing; `__proto__` and duplicate field names are reported and skipped; a default that does not fit its kind or enum options is reported and dropped. Was: 1→5 with target 2 returned ok at version 5, restore never checked the version, and the loader threw `TypeError` on an entry without `fields`, dropped `__proto__` silently and let duplicates overwrite. SPEC §7.3. | 2026-10-13 engine review (P3, P5) | C | Closed. |
| O-64 | ~~**Scene hierarchy does not scale or terminate**~~ — **fixed 2026-10-14**: (S1) `despawnTree` visits each entity once, so a cyclic `Parent` graph terminates; (S2) it indexes children in one pass and the despawn-orphan plugin skips the subtree it is removing, so a 4k star despawns in a few ms (was ~800 ms); (S3) `composeTransforms` resolves chains with a loop, so depth is unbounded (a 50k chain overflowed the stack). Remaining: `childrenOf` and the plugin's plain-`despawn` handler still scan every `Parent` per call — a persistent parent→children index is O-7 territory. | 2026-10-13 engine review (S1–S3) | B | Closed. |
| O-65 | ~~**`composeTransforms` marking and lifecycle**~~ — **fixed 2026-10-14**: (S4) `World_` is written and marked only when a primitive field moved (a field holding an object always counts as moved, since in-place changes are invisible), and an entity that loses `Local` loses `World_`, through a system-owned `OnRemoved(Local)` window that survives snapshots (a first cut tracked "plugin-added" entities in a closure set, which a restore lost); a `priority` option places the system relative to writers of `Local` and readers of `World_`. (S5) the plugin and system are named per component pair (`domecs-scene:compose-transforms:<Local>><World_>`, or `options.name`), so several pairs coexist, and disposal removes the system. (S6) `childrenOf` was already ascending by id once `iterEntitiesWith` was (O-40); now pinned by a test across restore. Was: every entity marked changed every tick, a stale `World_` after losing `Local`, a hard-coded name, and a system left running after disposal. | 2026-10-13 engine review (S4–S6) | B | Closed. |
| O-66 | ~~**Rules: deep or long expressions overflow the stack**~~ — **fixed 2026-10-14**: the parser, `walkFieldRefs` and the evaluator recursed without a limit (8 KB of nested parens or 15k unary minuses threw `RangeError` from `parseExpression`; a 6k-term flat sum threw later in `compileRule`). `parseExpression` now returns a `ParseError` for sources over `MAX_EXPRESSION_LENGTH` (16384) or ASTs deeper than `MAX_EXPRESSION_DEPTH` (128, checked iteratively, so long operator chains count), which bounds every later pass. rules `hardening.test.ts`. | 2026-10-13 engine review (R1) | A | Closed. |
| O-67 | ~~**Rules: writes are unchecked**~~ — **fixed 2026-10-14**: (R2) reads are own-property only and `__proto__`/`constructor`/`prototype` are rejected as field names at compile time; (R5) a write must target an existing own field of the same kind (number/string/boolean) with a finite number, so `&&`/`||` no longer write booleans into numbers, typos no longer add fields, and `Infinity` is not stored. A field holding `null`/`undefined` accepts any primitive. A failing write — or a missing target component — skips the entity. rules `hardening.test.ts`. | 2026-10-13 engine review (R2, R5) | B | Closed. |
| O-68 | ~~**Rules: errors are swallowed**~~ — ~~(R3) actions not atomic~~ — fixed 2026-10-14: actions are evaluated in order against staged writes (a later action reads an earlier one's value, as Studio's action reordering relies on) and committed only when all succeed, so a failure leaves the entity untouched. Was: each action wrote and marked before the next was evaluated, so a later error left earlier writes in place, against the skip-this-entity contract. (A first cut evaluated every action against the pre-rule values; dogfooding Studio showed that breaks in-order actions, so swaps stay unsupported.) ~~(R4) errors swallowed~~ — fixed 2026-10-14: a `RuleEvalError` skips the entity and is returned through `SystemResult` as an entity fault (`rule_eval_failed`, source `rule:<name>`, `detail: { rule, message }`; `RuleFault` exported); any other error propagates. `compileRule` rejects type errors certain before the rule runs: a string/boolean literal or operator result where a number is needed, outside short-circuited or branch code (a first cut also inferred field kinds from defaults; review showed defaults do not fix a field's kind, so that was dropped). Error messages render values that `JSON.stringify` cannot (BigInt, cycles) instead of crashing the step. Was: `catch { continue }` hid every runtime error, real bugs included. Separate from the RuleError field-tag item. | 2026-10-13 engine review (R3, R4) | B | Closed. |
| O-69 | ~~**Rules: ordering, validation and cost**~~ — **fixed 2026-10-14**: (R6) `RuleDef.priority` places rules among systems; equal-priority rules run in `defs` order (every `update()` re-registers in that order). (R7) an unknown `schedule` or non-finite `priority` is a `RuleError`. (R8) a repeated name is not installed and is reported under that name. ~~(R9)~~ (fixed earlier). (R10) documented, not changed: a `fixed` rule's `time` is the frame's elapsed time in every sub-step (core exposes no per-sub-step clock). (R11) number literals too large for a double and unknown escapes are lex errors; `foo(1,` already reported "expected an expression" at the end; `sin`/`cos` non-determinism is documented. (R12) expressions compile once to closures, per-run scratch state is reused, and staging/dedupe are skipped when the actions do not need them: a 5k-entity rule went 12.3 → 3.1 ms per tick (hand-written: 1.3 ms). | 2026-10-13 engine review (R6–R12) | C | Closed. |
| O-70 | ~~**Docs point npm users at APIs that were never published**~~ — **fixed 2026-10-16**: released as **2.0.0** (a major, since the review fixes change behavior; first prepared as 1.1.0). All seven packages (core, dom, input, persist, inspector, scene, rules) are on npm at `latest` = 2.0.0, so `createAgentBridge`, `loadIfPresent`, scene and rules resolve; siblings peer-depend on `@domecs/core ^2.0.0`. CHANGELOG `[2.0.0]` covers persist schema, scene and rules; `pnpm cold-install` packs and probes all seven, and `pnpm cold-install:registry` (passes against npm) checks the published release; release checklist in `doc/PACKAGING.md`; tag and GitHub release `v2.0.0`. Was: npm had only the June 1.0.0 build, scene/rules returned 404, and every `package.json` was still 1.0.0. | 2026-10-13 engine review (X2) | A | Closed. |
| O-71 | ~~**Doc drift**~~ — **fixed 2026-10-14**: (X4) `doc/api.md`'s World listing now matches the `World` interface member for member (`getResource`, `iterEntitiesWith`, `events`, `input`/`setInput`, `resourceTypes`, `describeResource`, `describeEvent`, `describe`, `signals.faultRaised`, `use` returning a `Result`; `resource<T>()` and `entitiesWith` removed). (X5) README and AGENTS say five packages are published and that scene and rules are in the repo but unpublished (superseded by the 2.0.0 release, O-70: they now say seven are published); the README diagram lists all seven and calls the inspector what it is (a headless fault/timeline recorder); SPEC §8 no longer claims a determinism sandbox, SPEC §10 describes the shipped headless inspector, and the `world.__wake` mention is gone. Was: api.md documented removed names and omitted live ones; README claimed "all five" packages with seven present. Only api.md is doctested (unchanged). | 2026-10-13 engine review (X4, X5) | B | Closed. |
| O-72 | ~~**Bench numbers do not reproduce**~~ — **fixed 2026-10-14**: the compare phase runs `--trials` (default 5) interleaved trials and reports median p50/p95, the per-engine p95 range and per-trial ratio ranges (`verdictRange`); a runtime win must clear ≤0.70× in every trial; `pnpm bench` runs with `--expose-gc`. bench/README commits a 5-trial table (no win: soak 1.07–1.45×, windowed 1.35–3.73× Koota p95) and withdraws the "0.65× (decisive)" windowed claim; PLAN WS-1 no longer calls windowed "sometimes decisive". The step-vs-`updateEach` timing asymmetry stays deliberate and documented (COMPARISON.md). Kill gate 1 is still not cleared. | 2026-10-13 engine review (X6) | B | Closed. |
| O-73 | ~~**Project hygiene**~~ — **fixed 2026-10-14**: (X3) the API-surface snapshot is every emitted `.d.ts` of each package, under `// file:` headers, so a changed signature fails the gate, not just a changed export list. (X7) siblings peer-depend on `@domecs/core` with `workspace:^` (published as `^2.0.0`; dev dependency kept for the workspace); `src` ships so source maps resolve; every package declares `engines.node >=18`. (X8) CI runs Node 20/22/24 and the cold-install gate (on 22); the stale `package-lock.json` is gone; direct tests cover `stepN`, `setInput`, the Result combinators, `attempt`/`attemptAsync` and `withBuiltinMigrations`; `scripts/validate-release.mjs` packs rules and scene and finds `../fleet`, and the Plantroom example loads the installed `@domecs/core` when staged outside the repo (it imported `../../../packages/domecs/dist` and aliased workspace source, so validation died on it before reaching any org app); `pnpm release:validate` passes for 6 apps. Bench and `release:validate` stay out of CI (noisy / need sibling app repos). (X9) PLAN §5 records scene, rules and persist schema I/O. | 2026-10-13 engine review (X3, X7–X9) | C | Closed. |
| O-74 | ~~**`Not(Where(T, p))` behaves as `Not(Has(T))`**~~ — **fixed 2026-10-14**: archetype matching is three-valued (yes / no / depends on the entity); `Where` and the change filters are "depends", which negation keeps, so `Not(Where(T, p))` means "lacks T or fails p" in live queries, `listEntities` and `countEntities` alike, matching `evalEntity`. Same fix for `Not(OnAdded/OnChanged/OnRemoved/OnChangedResource)`, which matched nothing or only non-holders. Was: core `evalStructural` treated a `where` node as plain `has`, so under `Not` an entity whose `T` failed the predicate was excluded. SPEC §2.4. Found while reviewing O-52. | 2026-10-14 review of O-52 | B | Closed. |

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

Park these in `../doc/ROADMAP.md`:

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

