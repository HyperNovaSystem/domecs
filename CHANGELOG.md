# Changelog

All notable changes to DOMECS are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `createAgentBridge(world, opts?)` in `@domecs/core` (PLAN WS-3) — thin agent
  facade: `reset` / `observe` / `act` / `step` / `snapshot` over existing
  world APIs. Ships with root `AGENTS.md` and `skills/domecs/SKILL.md`.
- Cold-install smoke: `node scripts/cold-install.mjs` (and
  `RUN_COLD_INSTALL=1` node test) packs tarballs into an empty temp project
  and probes published-layout imports.
- `loadIfPresent(world, storage, slot, opts?)` in `@domecs/persist` (FINDINGS
  O-28) — boot-friendly load where a missing slot is `ok(false)` rather than
  `persist_io`. Real I/O / parse / migration / restore failures remain `err`.
- `createLocalStorageStorage(prefix?)` in `@domecs/persist` (FINDINGS O-1) —
  a browser `localStorage` adapter that namespaces slots under `prefix`
  (default `'domecs:'`), resolves the backing store lazily from `globalThis`
  (safe to import in headless/Node hosts), and maps missing-storage /
  privacy-mode / quota throws to `persist_io` Results. Browser apps no longer
  hand-roll this adapter.
- `world.getSystem(name)` returns the live `SystemHandle` for a registered
  system (built-in or user-registered) by name, or `undefined`. This makes
  `SystemHandle.disable()` / `.enabled` reachable for built-in systems such as
  the fault consolidator (`CONSOLIDATE_FAULTS_NAME`), whose handle was
  previously auto-registered with no public way to retrieve it — leaving the
  documented disable escape hatch unreachable.

### Removed

- Dropped the never-constructed `system_threw` variant from the closed
  `DomecsError` union (dead surface: thrown systems were never caught — systems
  report faults by returning `SystemResult`, not by throwing). Thrown-system
  isolation is deferred; re-add the variant if/when that mode is built.

### Fixed

- **O-2 first paint:** under default `changedOn: auto` (and explicit gating),
  `mountDOM` now calls `update()` once when a node is created, so static
  entities are not left empty/at (0,0) until an unrelated change marks them.
- **O-32 `pauseOnHidden` provenance:** the rAF driver only auto-resumes a
  pause it initiated. App-managed `world.pause()` (e.g. a Pause button) is no
  longer trampled when the tab becomes visible again.
- **O-28 empty-slot retryability:** `load()` on a missing slot now returns
  `persist_io` with `retryable: false` (first-run is deterministic until a
  save exists). Prefer `loadIfPresent` for boot paths.
- `mountDOM` no longer leaks queries on its error paths (FINDINGS O-17). The
  `unregistered_slot` and `plugin_install_failed` returns now dispose the live
  queries and `onAdd`/`onRemove` subscriptions built for already-processed
  views, in addition to rolling back slot claims.
- `restore()` now validates incoming values for *registered* resource types
  before any world state is wiped (FINDINGS O-18), mirroring the
  `setResource()` contract: an invalid value throws and leaves the world
  untouched (surfaced as `persist_io` through `@domecs/persist` `load()`).
  Component values are deliberately not re-validated — the live path
  validates only at `Component.create()`, so snapshots may legitimately hold
  values a validator was never asked to bless.
- The idle rAF driver no longer spins at `setScale(0)` just because enabled
  `tick` systems exist (FINDINGS O-19). `hasFrameSystems()` now mirrors the
  scale gate that `step()` applies to tick systems; paused worlds still get
  frames for rendering via the mutation wake path.
- A throwing direct `on()` event handler no longer escapes `step()`. Such a
  handler is now quarantined as an `event_handler_threw` fault (`retryable:
  true`) routed to `world.signals.faultRaised`, and the remaining subscribers
  for that event plus the remaining events in the same flush still deliver —
  one bad handler can no longer crash the tick loop or starve the others.

### Documentation

- Root README repositioned for operable simulation + agent operation; drops
  unearned "high-performance" claim; labels v1.0 as **API-stable** (PLAN WS-0).
- Documented first-hour traps: `spawn` shallow-copy (O-34), `keyDelta`
  render-tick scope (O-35), `stepOnce` vs `fixed` (O-37), scale-0 gating for
  `tick`/`fixed` (O-3), and provenance-aware `pauseOnHidden` (O-32).
- `doc/api.md`: removed pre-v1.0 drift — deleted the ghost `@domecs/sprites`
  section (no such package ships), rewrote the quick-start to import only real
  packages, retitled the reference to v1.0, swept the remaining `v0.1` version
  labels to `v1.0`, and updated the inspector fault-kind example off the
  now-removed `system_threw` kind.

## [1.0.0] — 2026-05-31

First stable release. Completes the agent-legibility pass (Phases 0–4): the
public surface is decidable from signature + one-line doc, spelled exactly one
way, with errors that say how to fix. All five `@domecs/*` packages are at
`1.0.0`.

### Breaking

The single coordinated v1.0 break (Phase 2):

- **Naming sweep** to one verb language:
  - Reads encode cardinality/cost: `world.resource` → `getResource`;
    `count` → `countEntities`; `entitiesMatching` → `listEntities`;
    `select` → `selectViews`; `entitiesWith` → `iterEntitiesWith`.
  - RNG unified to a `uniform*` family: `next` → `uniform`, `int` →
    `uniformInt`, `range` → `uniformRange`, `roll` → `uniformRoll`
    (`pick`/`fork`/`seed` unchanged).
  - Temporal query nodes gain an `On*` prefix: `Added` → `OnAdded`,
    `Removed` → `OnRemoved`, `Changed` → `OnChanged`,
    `ChangedResource` → `OnChangedResource` (`Has`/`Where`/`Not`/`And`/`Or`
    unchanged).
  - Driver: `start` → `startLoop`; `step(dt?)` split into a required
    `step(dt)` plus a new no-arg `stepOnce()`.
- **`SystemDef` is now a discriminated union on `schedule`**
  (`TickSystemDef` | `FixedSystemDef` | `EventSystemDef` | `OnceSystemDef` |
  `ReactiveSystemDef`); each variant carries only its valid fields, so invalid
  schedule/field combinations are unrepresentable instead of throwing at
  registration.
- **`ChangedOn` union replaces the `changedOn` tri-state** on `ViewDef`:
  `{mode:'auto'} | {mode:'legacy'} | {mode:'explicit'; types}` replaces the old
  omitted / `[]` / `[T]` presence-encoding.
- **One-shot selectors reject temporal nodes at compile time** — `On*`
  constructors return a branded `TemporalQueryNode`; `countEntities` /
  `listEntities` / `selectViews` take a narrowed `OneShotQueryDef`.
- **`mountDOM` returns `Result<MountHandle, MountError>`** — failure is now
  enumerable (`slot_already_mounted` / `unregistered_slot` /
  `plugin_install_failed`) instead of thrown.
- **Errors carry repair info** — every `DomecsError` variant now has a required
  `retryable: boolean` (and `SystemFault` an optional `idempotent?`); the union
  is documented as closed.
- **Removed internal types from the public barrel** — `InternalComponentType`
  and the `__`-field reach-ins are no longer public surface; reflection is via
  the typed `describe*` family.

### Added

Additive self-describing root and surrounding surface (Phase 3 + earlier):

- **Reflection family** — `world.describeComponent` / `describeResource` /
  `describeEvent`, `world.resourceTypes()`, and the composed
  `world.describe(): WorldManifest` (with `PluginManifestEntry`); plus
  `InspectorView.export(): InspectorSnapshot`. `WorldManifest` carries the
  schema surface plus O(1)/O(archetype) live debug counts (`entityCount`,
  `componentCounts`, `archetypes`).
- **`defineEvent(name, { schema? })`** payload field-schema (reusing the
  component `FieldSchema` vocabulary) and `EventBus.knownTypes()`.
- **`DEFAULT_INPUT_OPTIONS`** — machine-readable static input defaults
  (`@domecs/input`), consumed by the plugin as the single source of truth.
- **Resources** — `defineResource` + `world.getResource` / `setResource` /
  `markResourceChanged`, the `OnChangedResource(R)` query node, and resources in
  the snapshot envelope.
- **One-shot leak-free selectors** — `countEntities` / `listEntities` /
  `selectViews` (compile-time reject reactive `On*` nodes).
- **`world.action(type, payload, opts)`** → `{ accepted, consumedTurn, reason,
  events, snapshot? }` (with `turn()` staying void); `stepOnce` / `stepN` split.
- **Error helpers** — `describeError(e)` + `getErrorRepairHint(e)` total
  formatters over the closed `DomecsError` union, `ERROR_KINDS` const, and
  `isKnownDomecsErrorKind` guard.
- **Result combinators** — `tap` / `tapErr` side-effect helpers;
  `ComponentValue<typeof C>` value-type extractor.
- **`definePlugin(spec)`** authoring helper; plugin `install` returns
  `Result<PluginHandle | void, DomecsError>`.
- **`@domecs/persist`** — `save` stamps a `meta` envelope (`savedAt` + caller
  meta); `createSnapshotHistory` + `diffSnapshots` (undo/redo, branch
  truncation, diff); `pruneTransientOnlyEntities`.

### Fixed

- **`restore()` `prevMembers` id/index mismatch** — `onRemove` mis-fired on
  restore after a query dispose; now indexed by array position.
- **Reactive `ctx.entities` for `reactsTo`-only systems** — reactive systems
  declared with only `reactsTo` now receive the tick-filtered delta in
  `ctx.entities` (previously `[]`).

### Docs / Infra

- **`LEGIBILITY.md`** — the six legibility laws, all enforced as of v1.0.
- **Committed API-surface contract** — a generated, reviewable
  `doc/api-surface/*.d.ts` snapshot per package, with a CI no-drift gate
  (`pnpm api:surface` / `pnpm api:check`).
- **Inline doctests (L6)** — `ts doctest` fences in `api.md` are extracted,
  typechecked, and run in CI (`pnpm doctest`).
- **`api.md` synced to shipped types** — removed the never-shipped
  `createPersistence` facade; corrected `Plugin` / `InspectorOptions` /
  `MountOptions` / plugin-install Result prose; added an authoritative-source
  banner.
- **CI hardening** — least-privilege `permissions`, auto-cancel `concurrency`,
  SHA-pinned actions, and the doctest gate.
- All five packages declare `sideEffects: false`.
- **`defineComponent` name-widening** documented as a TS limitation (the
  dual-overload trade-off); `defineEvent` payload tick-delay (emit on tick N →
  visible to `event` systems on N+1) documented and doctested.

[Unreleased]: https://github.com/hypernovasystem/domecs/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/hypernovasystem/domecs/releases/tag/v1.0.0
