# Changelog

All notable changes to DOMECS are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `world.getSystem(name)` returns the live `SystemHandle` for a registered
  system (built-in or user-registered) by name, or `undefined`. This makes
  `SystemHandle.disable()` / `.enabled` reachable for built-in systems such as
  the fault consolidator (`CONSOLIDATE_FAULTS_NAME`), whose handle was
  previously auto-registered with no public way to retrieve it — leaving the
  documented disable escape hatch unreachable.

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
