# DOMECS — Consolidated Findings & Audit Reference

_Last updated: 2026-05-31 (post-v1.0 freeze)._

This is the **single** post-v1.0 findings reference for the DOMECS engine. It
merges the 2026-05-29 29-agent engine audit (the A/B/C priority synthesis) with
the durable design input mined from the per-exemplar audits.

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

---

## 2. Open / actionable (still informs design)

These were surfaced by the exemplars and are **not** yet shipped. Tagged by the
review tier they map to.

| # | Finding | Source apps | Tier | Notes |
|---|---------|-------------|------|-------|
| O-1 | **Browser-durable `Storage` adapter** — `@domecs/persist` ships only `createMemoryStorage` (in-process, lost on reload). Every browser app hand-rolls a `localStorage`/IndexedDB adapter. Ship `createLocalStorageStorage(prefix?)` (+ async IndexedDB), ideally under a `@domecs/persist/web` entry to keep core DOM-free. | Railroad, Lighthouse, Halls | B | High value; `Storage` interface itself is clean (4 Result-returning methods). |
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
| O-16 | **Orphaned DOM nodes survive a same-tick remove-all/re-add view rebuild** (correctness bug, sharpens O-5/O-6). Reproduced in Fleet 2026-05-31: a projection that does `removeComponent(TableRow)` over the whole window then `addComponent(TableRow)` for the new window (`sim.ts rebuildTableRows`) leaves ~8 stale `<button.row>` nodes in the slot with their *pre-rebuild* content, while ECS state is correct (exactly `size` `TableRow`, `DashboardStats.renderedTableRows` = 50). `mount.ts commit()` reads correct on inspection — drop-outs get `onRemove`→`pendingDestroy`→`el.remove()`, retained ids guard double-create — so the suspect is the query membership / changed-set delta coalescing a same-tick remove+add to "no change", so the node is neither destroyed nor `update()`d. Net: hand-rolled despawn+respawn projections silently corrupt the DOM. Pairs with the O-5/O-6 keyed-reconciliation work and the O-14 renderer metrics (created/destroyed/updated counts) that would have caught it. | Fleet | A | Confirmed defect, not just missing ergonomics — needs a `@domecs/dom` reconciliation test for churned remove+add in one tick. |

| O-17 | **`mountDOM` leaks queries + subscriptions on its error paths** — `mount.ts` creates a live `world.query()` plus `onAdd`/`onRemove` subscriptions (and `changedQueries`) per view *before* all failure checks complete. On the `unregistered_slot` return (and both `plugin_install_failed` returns) only the slot claims are rolled back; the queries and subscriptions built for already-processed views are never disposed, so a failed mount permanently leaks reactive queries that keep accumulating per-tick deltas. Fix: dispose every `ViewState` (unsub + `query.dispose()` + changed queries) before each error return. | Railroad (2026-06-09 v1.0 migration audit) | A | Confirmed by reading `mount.ts:62-138`; teardown() does this correctly but is unreachable on the error paths. |
| O-18 | **`restore()` bypasses validators** — `world.ts` rehydrates resources (`resources.set(name, cloneSerializable(value))`) and component values (`store.set(rec.id, cloneSerializable(value))`) without running the `validate` hooks that `setResource`/`addComponent` enforce. A corrupted, hand-edited, or badly-migrated snapshot silently injects invalid state that systems then trust. Either validate on restore (with an enumerable `persist`-style error) or document the trust boundary explicitly in SPEC + `defineComponent/defineResource` docstrings. No test covers validation-on-restore today. | Railroad (2026-06-09 v1.0 migration audit) | B | If skipping validation is intentional for perf, it is currently an undocumented contract hole. |
| O-19 | **Idle driver spins at `setScale(0)` when tick systems exist** — `hasFrameSystems()` counts enabled `tick` systems unconditionally, but `step()` gates tick systems off at `time.scale === 0` (it already mirrors the gate for `fixed`). A paused world with any tick system keeps scheduling rAF frames that run only plugins/render. Note any fix must keep frames flowing when a renderer actually needs them (paused boards still repaint via `onRender` — see O-3), so the check likely needs a "renderer present" carve-out rather than a blanket scale gate. | Railroad (2026-06-09 v1.0 migration audit) | C | Perf only; no correctness impact. |

### Recipe / documentation gaps (no engine change required)
These are recurring patterns the exemplars each re-discovered; the fix is a
blessed recipe or example, not new API:
- **Durable-log pattern** — event buffers are intentionally transient; durable
  history (transcript, game log) must be a component/resource. Document the
  "event in → append to durable component" pattern and snapshot semantics for
  event buffers. (Lighthouse, Tessera, Halls)
- **Post-restore transient-view rebuild** — `onRestore`/`afterRestore` convention
  (or a `deriveViews` helper) for rebuilding transient projection entities from
  persistent state. (Lighthouse)
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

