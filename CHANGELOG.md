# Changelog

All notable changes to DOMECS are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `@domecs/core`: `validateEventPayload(type, payload): string | null` is now
  exported — the O-39 schema check `world.action()` / `bridge.act()` apply,
  for hosts that pre-validate a command without emitting or stepping (studio
  finding 2026-10-19; studio had kept a copy).

- `@domecs/core`: `createSpatialGrid(cellSize)` — a pure, world-free
  uniform grid over 2D points keyed by entity id (O-8, harness spec §5.1):
  `set`/`delete`/`clear`/`position`/`size`, `within(x, y, r, accept?)`
  (ascending id), `nearest(x, y, { maxDistance?, accept? })` (ties → lowest
  id) and `pairs(r, accept?)` (`a < b`, sorted). Results equal a
  brute-force scan and never depend on the cell size or insertion order;
  non-finite positions are not indexed. SPEC §2.12.
- `@domecs/scene`: `createSpatialHash(world, { component, x?, y?, cellSize })`
  → `SpatialIndex` over one position component: `refresh()` (O(n),
  ascending id; also once at creation), `within`/`nearest` with live tag
  filters and `exclude`, `pairs(r, a, b)` (first element holds `a`), and
  `dispose()`. Derived state: never snapshotted.
- `bench`: `spatial` workload (refresh and `nearest` at 1000 entities).
- `@domecs/core`: `dmath.atan2(y, x)`, `dmath.hypot(x, y)` and
  `dmath.pow(x, y)` (O-75, harness spec §4.2, ED-18) — bit-reproducible on
  every ECMA-262 engine. `atan2` (with its `atan` kernel) and `hypot` are
  musl libm ports, `pow` a port of fdlibm 5.3 `e_pow.c` (no tables, no FMA).
  `atan2`/`hypot` specials follow C99 Annex F; `pow`'s follow ECMAScript
  `**` (`(±1) ** ±Infinity` and `1 ** NaN` are `NaN`). `pow` keeps fdlibm's
  known weak region (`|1 - x| <= 2^-20`, `|y| > 2^31`: relative error up to
  ~2^-43). Golden vectors in `test/golden/dmath2-vectors.json`.

- `@domecs/rules`: cross-entity rules (G1, O-82, harness spec §5.2; SPEC
  Appendix A). Selectors `self`, `first(S)`, `nearest(S[, d])`, `entity(n)`
  with reads `e.Component.field` and `e.id`; `has([e,] C)`; aggregates
  `count`, `exists`, `sum`, `avg`, `minOf`, `maxOf` (sets include the
  evaluated entity); `countWithin(S, r[, e])`, `distanceTo(e)`; functions
  `sqrt pow atan2 hypot sign round ceil lerp distance` (`pow`/`atan2`/
  `hypot` via `dmath`); the identifier `tick`; `a ?? b` (b on "no value":
  a missing field, an empty selector, a dead `entity(n)`, an empty
  `avg`/`minOf`/`maxOf`). `RuleDef.without` (excluded components; errors on
  `{ without: i }`), `InstallRulesOptions.spatial` (`{ component, x?, y?,
  cellSize? }`, start-of-run grid from `createSpatialGrid`), `compileRule`'s
  optional `{ spatial }` argument, `walkComponentRefs`, `SPECIAL_FORMS`,
  types `EntityNode`, `AggregateOp`, `SpatialOption`, `CompileRuleOptions`.
  Reads are live in ascending id (an entity sees lower ids' writes from the
  same run); set aggregates that cannot change during a run are memoized.
- `scripts/determinism-golden.mjs`: fixtures `rules-chase` and
  `rules-keep-distance` (built with `@domecs/rules`) and a
  `dmath2Fingerprint` (`atan2`/`hypot`/`pow`); the 2.1 fixtures and
  `dmathFingerprint` are unchanged. The script now also needs the built
  `@domecs/rules` (`--engine` looks for `<dir>/@domecs/rules`), and
  `pnpm test:golden` builds it.
- `bench`: `rules` workload (self-only vs `nearest(Player)` vs memoized
  `sum` rule at 1000 entities; spec §5.2 targets 3× and 1.2×: 1.7× and
  0.95× measured).

### Changed

- `@domecs/rules` (behaviour change): `self`, `tick`, `other`, `event` and
  `pointer` are reserved words — a component with one of these names can no
  longer be referenced in an expression (a parse error, "reserved word"),
  and `id` is reserved after an entity. `a??b` now lexes as `??` (it was a
  syntax error). A missing self field still faults the entity as before
  (it is now a "no value" error, still a `RuleEvalError`). Every component
  name in an expression is resolved at compile time, including sets and
  `has` targets.

### Type-level changes

- `@domecs/rules`: `FUNCTION_NAMES` gains nine names, so `FunctionName`
  widens and `FUNCTION_ARITY` gains keys; `AstNode` gains `member`,
  `entityId`, `has`, `aggregate`, `countWithin`, `distanceTo` and `nullish`
  nodes and `identifier.name` gains `'tick'`; `RuleDefPath` gains
  `{ without: number }`. Exhaustive switches over `FunctionName`,
  `AstNode['kind']` or `RuleDefPath` need a case or a default branch (the
  rules README recommends a default branch).

### Fixed

- `@domecs/core`: `validateEventPayload` (and so `world.action()` /
  `bridge.act()`) checked undeclared keys with `in`, so a payload key that is
  only inherited from `Object.prototype` (`toString`, `constructor`,
  `__proto__` from `JSON.parse`, …) was treated as declared and accepted; and
  an absent declared field with such a name was read through the prototype
  chain and rejected. Both now use own properties only.

## [2.1.0] — release candidate (2026-10-19; not yet published)

All seven `@domecs/*` packages move to 2.1.0 together. Additive minor: the
determinism foundation and build identity for the Studio harness. `^2.0.0`
peer ranges still resolve. Release notes:
[`doc/release-notes/v2.1.0.md`](doc/release-notes/v2.1.0.md).

### Added

- `@domecs/core`: canonical snapshot hash (O-11). `canonicalJson(value)` —
  `JSON.stringify` value semantics with object keys sorted by UTF-16 code
  unit, `-0` kept as the literal `-0`, and a `TypeError` naming the path for
  `NaN`/`±Infinity`, BigInt and cycles. `canonicalSnapshot(snap, options?)`,
  `hashSnapshot(snap, options?)` (FNV-1a-64, 16 hex chars; `version`, `meta`
  and `changes` excluded unless `includeMeta`/`includeChanges`),
  `hashEntities(snap)`, `hashValue(value)`, `HASH_ALGORITHM` (`'fnv1a64'`),
  type `CanonicalOptions`. SPEC §7.1 "Canonical form", §8.
- Every package: `BUILD_ID: string` export (`'dev'` in source; stamped by
  `scripts/pack-for-studio.mjs`, plain version when published).
- `scripts/pack-for-studio.mjs` (`pnpm pack:studio`): builds, stamps
  `BUILD_ID` and a `<version>+g<sha>[-dirty]` package version, packs the seven
  packages as `domecs-<pkg>-<buildId>.tgz`, and writes `manifest.json`
  (`version`, `buildId`, `gitSha`, `dirty`, `packedAt`, per-package `file`,
  `integrity`, `buildId`). Never publishes.
- `bench`: `hash` workload (1000-entity snapshot, strict hash); `dmath`
  workload (`dmath.sin`/`cos` vs `Math.sin`/`cos`, informational ≤ 3×).
- `@domecs/persist`: field-level diff (G9, O-31 diff half).
  `diffSnapshots(prev, next, { fields: true })` adds `componentsAdded`,
  `componentsRemoved`, `fieldChanges` and `resourceChanges` (dotted paths,
  canonical order), with `epsilon`, `components` and `limit`/`truncated`
  options; `firstDivergence(a, b)` returns the first difference (state, then
  lowest entity id, then resources) or `null`. New types
  `SnapshotDiffOptions`, `FieldChange`, `ResourceChange`, `Divergence`.
- `@domecs/core`: `dmath` (G19, O-75) — bit-reproducible `sin` and `cos`
  (a straight-line port of musl libm, generic C / non-FMA, < 1 ulp) and
  `sqrt` (= `Math.sqrt`, already correctly rounded). Identical results on
  every ECMA-262 engine, where `Math.sin`/`Math.cos` differ by up to 1 ulp
  between V8 builds. Golden vectors in `test/golden/dmath-vectors.json`
  (`scripts/dmath-golden.mjs`).
- `@domecs/core`: `SystemDef.order` (G20, O-76) — a finite secondary sort
  key (default 0). Systems in a mode run by (priority, order, registration
  index); a non-finite `order` throws at `world.system()`.
  `describe().systems[i]` now reports `priority` and `order`.
- `@domecs/rules`: `installRules(world, defs, resolve, options?)` takes
  `InstallRulesOptions` (G20, O-76). `{ order: 'stable', orderBase? }`
  registers rule *i* of the de-duplicated defs with `order: orderBase + i`
  (default base 1), so `update()` no longer moves rules behind equal-priority
  systems and a live world after updates stays hash-equal to a fresh build
  from the current defs restored from its snapshot. The default
  `'registration'` keeps the 2.0 order. SPEC §3 documents the ordering
  triple and the recommended priority bands.
- `@domecs/core`: registry and name lookup (G10; O-30, O-78).
  `world.register(...types)` eagerly registers component, event and resource
  types so reflection lists them before first use; it is idempotent,
  all-or-nothing, and returns `err({ kind: 'name_conflict', registry, name })`
  (type `RegisterError`) instead of throwing. `lookupComponent`,
  `lookupEvent` (`undefined` for an ambiguous name), `lookupResource`, and
  `eventTypes()` (first-seen order). SPEC §2.3, §2.6.
- `@domecs/core`: `AgentBridge.act(name, payload, opts?)` — name-based act
  for JSON callers; an unknown or ambiguous name is rejected with no emit
  and no tick.
- `@domecs/core`: richer manifest. `describe().systems[i]` gains
  `components` (sorted component names the query / reactsTo reference) and
  `meta` (new `SystemDef.meta?: JsonValue`, cloned). `FieldSchema.description`,
  `EventDefOptions.description` and `EventDescriptor.description` add free
  text for humans and agents.
- `@domecs/persist`: `ComponentFieldData.description` round-trips through
  `serializeComponentType` / `registerComponentTypes`.
- `@domecs/rules`: each rule's system carries `meta: { rule: name }`.
- `@domecs/rules`: `RuleError.field?: RuleDefPath` (G12, O-79). Every error
  from `compileRule` and `RulesHandle.update()` names the one part of the def
  it is about: `'name'` (duplicate), `'schedule'`, `'priority'`,
  `{ query: i }`, `'when'`, or `{ action: i, part: 'set' | 'expr' }`.
  `position` keeps its meaning (offset within that part's string, or -1).
  New type `RuleDefPath`; the union widens in later minors, so keep a
  default branch when switching on it.
- `@domecs/core`: pending events travel with opt-in snapshots (G21, O-90).
  `snapshot({ pendingEvents: true })` records the undelivered events as
  `WorldSnapshot.pendingEvents: [{ event, payload? }]` (new type
  `SnapshotPendingEvent`), in bus order, as plain-data copies; a payload
  that is not plain data throws `TypeError` naming the event and path. The
  field is omitted when nothing is in flight. `restore()` resolves each name
  with `lookupEvent` before any state change (unknown or ambiguous throws)
  and replaces the queue with those events, so a fork taken between an emit
  and its delivery delivers it too. `world.pendingEvents()` reads the queue
  without consuming it. `canonicalSnapshot`/`hashSnapshot` include the field;
  `@domecs/persist` `firstDivergence` reports it (`key: 'pendingEvents'`).
  Default snapshots are unchanged (the option is off in 2.x). The field is
  one of snapshot v3's optional fields (below).
- `@domecs/core`: per-system RNG streams (G6, O-77). `SystemDef.rng?:
  'shared' | 'own'` (default `'shared'`): an own system's `ctx.rand` is a
  stream keyed by its cursor key and derived from the world's root seed with
  the new `deriveStream(root, key)` export, so adding, removing or editing
  one system no longer changes another own-stream system's draws. Streams
  outlive their systems (re-registration resumes them) and travel in the
  snapshot as `WorldSnapshot.rngStreams`, beside the root seed `rngRoot`;
  `restore()` validates both before any effect, rewinds live generators in
  place and re-derives the streams the snapshot lacks.
  `describe().systems[i].rng` reports the mode. SPEC §2.8.
- `@domecs/rules`: `RuleDef.rng` and `InstallRulesOptions.rng` (`'shared'`
  default | `'own'`): rule `random()` draws its own stream, keyed
  `rule:<name>`, and `update()` re-registration resumes it. `RuleDefPath`
  gains `'rng'` (an unknown `RuleDef.rng` is a `RuleError`).
- `@domecs/persist`: built-in `2 → 3` migration (pure version bump).
- Dual-runtime determinism golden (spec §3.4): `scripts/determinism-golden.mjs`
  steps four fixed headless worlds (`trig`, `random`, `own-streams`,
  `bounce0`) 1000 fixed steps on the built `@domecs/core` and prints
  `{ buildId, fixtures, dmathFingerprint }` with strict hashes; `--engine
  <node_modules>` loads core from an install. `pnpm test:golden` (also a CI
  step) compares it with `test/golden/determinism.json` and, when
  `DOMECS_ALT_RUNTIME` is set (e.g. `env ELECTRON_RUN_AS_NODE=1 <electron>`),
  requires identical output under that runtime.
- `scripts/pack-for-studio.mjs` copies `determinism-golden.mjs` next to the
  tarballs; `manifest.json` gains `golden: { file, integrity }`.
- `@domecs/rules`: fork-equivalence suite (`test/fork-equivalence.test.ts`):
  a live world edited mid-run equals a fresh build restored from its
  `snapshot({ pendingEvents: true })` for 150 ticks (tick and fixed rules,
  `composeTransforms` at priority 100, own and shared streams, spawns, `-0`,
  events in flight). `@domecs/scene` is a new devDependency of
  `@domecs/rules` (tests only).

### Changed

- **Behavior change (snapshot format): `SNAPSHOT_VERSION` is 3.** Every
  snapshot a 2.1 world writes has `version: 3`, whether or not it uses own
  streams or pending events, and carries `rngRoot` (`rngStreams` and
  `pendingEvents` are omitted while empty). **2.0 engines reject 2.1 saves**
  ("newer than this engine supports"); 2.0 saves still restore and load (v2
  restores onto the world's `createWorld` root and re-derives own streams;
  persist migrates 2 → 3 in memory, and `save()` writes v3).
  `describe().snapshotVersion` is 3. `hashSnapshot` excludes `version`, but
  `rngRoot` is state, so hashes of world-built snapshots change once.
- **Behavior change (determinism checks):** "same state" now means equal
  `hashSnapshot(snap, { includeChanges: true })`, not equal
  `JSON.stringify(snapshot())` (AGENTS.md checklist, SPEC §8). Canonical JSON
  keeps `-0`, so two snapshots that differ only by the sign of a zero now
  compare unequal — they can have different futures (`1 / v`, `atan2`,
  `Math.sign`). `@domecs/persist` `save()` still serializes with
  `JSON.stringify`, which writes `-0` as `0`.
- `@domecs/persist`: **behavior change (narrowing)** — `diffSnapshots`
  compares component bags as data instead of by `JSON.stringify`, so an
  entity whose components differ only in key order is no longer in
  `changedEntities`; one whose field went from `0` to `-0` now is.
- `@domecs/rules`: **behavior change (≤ 1 ulp)** — `sin()` and `cos()`
  evaluate with `dmath` instead of `Math.sin`/`Math.cos` (O-75). A rule
  using them may produce a result that differs from 2.0 by at most 1 ulp in
  a given runtime, so an existing sim's hashes change once; in exchange the
  results are now the same in Node, Electron and browsers. SPEC §8 already
  disclaimed bit-identity for platform transcendentals.

## [2.0.0] — 2026-10-16

All seven `@domecs/*` packages move to 2.0.0, and `@domecs/scene` and
`@domecs/rules` are published for the first time. This release carries every
fix from the 2026-10-13 engine review and the 2026-07-17 review tranche. It is
a major release because several of those fixes change behavior an app could
rely on (below), and the `system_threw` variant left the `DomecsError` union.

Upgrading from 1.0.0:

- Upgrade the packages together. `dom`, `input`, `persist`, `inspector`,
  `scene` and `rules` now peer-depend on `@domecs/core` `^2.0.0`, so install
  `@domecs/core` yourself (most apps already do).
- Read the entries marked **behavior change** below. The ones most likely to
  touch an app: query iteration is ascending entity id (O-40); component
  `defaults` are copied per entity (O-44); change filters report every mark
  since a system last ran (O-42); rule errors become faults or propagate
  (O-68); a DOM view with `update` but no redraw trigger, or a temporal node
  in its query, is a mount error (O-52, O-55); `restore()` rejects a
  snapshot newer than the engine (O-63).

### Fixed (2026-10-13 engine review — medium items)

- `@domecs/dom`: a throwing view `create`/`update`/`destroy` no longer jams
  the renderer. The rest of the commit and every other view still run, the
  first error is rethrown once the commit is done, and later frames are
  unaffected; a failed `create` is retried when the entity is marked changed.
  `teardown()` removes every node before rethrowing. `@domecs/core` closes a
  tick's change windows even when the tick throws. (O-53)
- `@domecs/input`: a `step(0)` heartbeat no longer eats key presses and
  pointer/wheel deltas; they reach the next full tick, once (a heartbeat's
  snapshot carries held keys and position but no edges). `@domecs/core`:
  plugin `onTickStart`/`onRender`/`onTickEnd` receive a second argument,
  `TickInfo` (`{ heartbeat: boolean }`, exported). (O-57)
- `@domecs/scene`: `setParent` rejects a parent that is not alive. The README
  gives group entities a persistent component, since snapshot pruning drops
  bare entities and orphans their children; persist's
  `pruneTransientOnlyEntities` docs say it applies to history snapshots too.
  `@domecs/core`: new `world.isAlive(entity)`. (O-61)
- `@domecs/scene`: `despawnTree` terminates on a cyclic `Parent` graph and is
  linear (a 4k-child star took ~800 ms); `composeTransforms` no longer
  overflows the stack on deep chains. (O-64)
- `@domecs/rules`: **behavior change** — rule errors are reported instead of
  swallowed. An entity a rule cannot run on is still skipped, and now gets a
  `Faulted` entry (`rule_eval_failed`, source `rule:<name>`; the `RuleFault`
  type is exported); any other error propagates out of the step.
  `compileRule` rejects type errors certain at compile time — a string or
  boolean literal (or operator result) where arithmetic, a comparison or a
  function needs a number, outside short-circuited or branch code. (O-68)
- `@domecs/core`: `Not(Where(T, p))` matches entities that lack `T` or whose
  `T` fails `p` (it behaved as `Not(Has(T))`); `Not` over `OnAdded`/
  `OnChanged`/`OnRemoved`/`OnChangedResource` likewise negates per entity.
  (O-74)
- `@domecs/scene`: `composeTransforms` marks `World_` changed only when a
  value moved (change-gated views repainted every tick), removes `World_`
  when an entity loses `Local`, removes its systems on disposal, and
  takes `options` (`priority`, `name`). **Behavior change**: the default
  plugin/system name is now `domecs-scene:compose-transforms:<Local>><World_>`,
  so one instance per component pair can be installed. (O-65)
- `@domecs/inspector`: a restore no longer duplicates recorded faults;
  filtered views keep the timeline they were filtered with instead of the
  live one; pushing into a full buffer is O(1) amortized; the README example
  reads `entry.systemId`. (O-60)
- `@domecs/core`: `describe().events` (and `bridge.observe()`) list an event
  system's trigger types from registration, and each entry is the type's
  `describeEvent()` descriptor with its schema fields, so agents can
  discover commands before anything emits them. (O-51)
- `@domecs/core`, `@domecs/dom`: a change-gated read or commit costs what
  changed, not the number of entities: `OnAdded`/`OnChanged` queries read
  the marks in their window when that is cheaper, and a view's update phase
  visits only changed, created and re-added entities (50k entities, one
  change: 10.6 → 0.03 ms per commit). New `world.getView(entity)` returns
  the entity's current view (the object queries hand out). (O-54)
- Docs: `doc/api.md`'s World listing matches the shipped interface (removed
  `resource<T>()`/`entitiesWith`, added the missing members); README and
  AGENTS name the five published packages and the two unpublished ones
  (scene, rules); SPEC §8/§10 describe the inspector that ships. (O-71)
- Bench: the compare phase runs interleaved trials (`--trials`, default 5)
  and reports medians and ranges; a win must hold in every trial. The
  windowed "0.65× (decisive)" claim is withdrawn — a 5-trial run shows no
  runtime win. (O-72)
- `@domecs/persist`: a migration step must produce exactly the next version;
  `registerComponentTypes` reports malformed entries and fields, `__proto__`
  and duplicate field names, and defaults that do not fit their kind, instead
  of throwing or dropping them silently. `@domecs/core`: `restore()` throws
  on a snapshot newer than `SNAPSHOT_VERSION`. (O-63)
- `@domecs/input`: the first pointer move no longer reports a delta from
  (0, 0); pointer-lock moves report `movementX`/`movementY`; the default
  text-input selector (`TEXT_INPUT_SELECTOR`, exported) ignores checkboxes,
  radios, ranges and buttons and covers `select` and `contenteditable=""`.
  Docs: coordinates are client coordinates, and a key press fires once per
  `fixed` sub-step. (O-59)
- `@domecs/rules`: `RuleDef.priority`; equal-priority rules run in `defs`
  order. An unknown `schedule` or non-finite `priority` is a compile error, a
  repeated rule name is reported instead of silently replacing the first,
  and over-long number literals and unknown escapes are parse errors. Rules
  run about 4× faster (expressions compile to closures; staging is skipped
  when unneeded). (O-69)
- `@domecs/dom`: a world can take several `mountDOM`s on distinct slots;
  `create` sees components added after the entity matched; auto redraw
  triggers include `Where` leaves. **Behavior change**: a view with `update`
  but no redraw trigger (an empty `explicit` list, or no positive
  `Has`/`Where` leaf) is the new `invalid_changed_on` MountError instead of
  silently redrawing every tick. (O-55)
- Packaging: `@domecs/*` packages peer-depend on `@domecs/core` (`^2.0.0` as
  published) instead of depending on an exact version; `src` ships so source
  maps resolve; `engines.node >=18`. CI tests Node 20/22/24 and the
  cold-install gate. The API-surface snapshot covers every declaration file.
  (O-73)

### Changed (2026-10-13 engine review — change windows, O-42)

- `@domecs/core`: **behavior change** — change detection no longer resets at
  tick boundaries. A system's `OnChanged`/`OnAdded`/`OnRemoved`/
  `OnChangedResource` filters report every mark since that system's previous
  run ended (never its own writes); any other live query reports every mark
  since the last tick it was read. Marks made by a system that runs later in
  the tick, in render or `tickEnd`, or between ticks are no longer lost to
  systems that ran earlier — they are seen at their next run. A disabled or
  paused system sees what changed while it was off; a sub-rate `fixed` system
  sees the marks from the frames it skipped. A heartbeat render paints
  between-tick marks once. Also fixes the inspector missing faults appended
  after its observer ran (O-60 N1) and heartbeat repaints (O-55 D6).
- `@domecs/core`: snapshots carry the marks a system has not seen yet and each
  system's position (`WorldSnapshot.changes`, optional; `SNAPSHOT_VERSION`
  stays 2; the `ChangesSnapshot` type is exported). `restore()` re-issues them,
  so a restored world's change-detection filters report what the live world's
  would — including marks from mutations made between ticks.
- `@domecs/core`: `observe()` hands `onChange` the reactive delta itself.
- `@domecs/core`: component types whose `defaults` hold no nested object skip
  the per-entity copy (O-44 fast path).

### Fixed (2026-10-13 engine review — package high-severity items, O-52, O-56, O-58, O-66–O-68)

- `@domecs/dom`: a view whose query has a `Where` filter mounts exactly the
  entities that pass it and follows them in and out as the filtered fields
  change (structural add/remove used to ignore `Where`). **Behavior change**:
  temporal nodes (`OnAdded`/`OnRemoved`/`OnChanged`/`OnChangedResource`) in a
  view query return the new `invalid_view_query` MountError. (O-52)
- `@domecs/input`: a key released while a text input has focus is released
  (it stayed held); an element `keyTarget` releases held keys when focus
  leaves it; `pointercancel` and window blur clear pointer buttons and
  `lostpointercapture` re-reads them; teardown resets `world.input`. (O-56, O-58, O-59)
- `@domecs/rules`: expressions over 16384 characters or nesting deeper than
  128 levels (`MAX_EXPRESSION_LENGTH`/`MAX_EXPRESSION_DEPTH`, exported) are
  parse errors instead of stack overflows. (O-66)
- `@domecs/rules`: **behavior change** — reads see own fields only;
  `__proto__`/`constructor`/`prototype` are rejected at compile time; a write
  must target an existing field of the same kind (a `null`/`undefined` field
  takes any) with a finite number, and every target component must exist, or
  the entity is skipped; actions apply in order but commit only if all succeed; writes
  that do not change the value do not mark. (O-67, O-68, O-69)

### Fixed (2026-10-13 engine review — kernel hardening, O-41–O-50, O-62)

- `@domecs/core`: `restore()` validates the whole snapshot before it touches
  world state — the seed, `tick`, `nextId`, `resources`, and every entity
  record (unique integer `id` ≥ 0, object `components`). A malformed save or a
  buggy migration used to throw after the wipe, so a failed `load()` left the
  live world empty; it now leaves it as it was. `nextId: null` and
  `resources: null`, previously read as absent, are now rejected. (O-41)
- `@domecs/core`: adding or removing a system while a phase is running no
  longer skips or repeats a system. A system removed mid-phase does not run
  later in that phase; one added mid-phase first runs at its schedule's next
  phase. Equal-priority systems keep registration order after removals.
  (O-43, SPEC §3)
- `@domecs/core`: **behavior change** — component `defaults` are copied per
  entity. Arrays and plain objects in `defaults` were one instance shared by
  every entity (`defaults: { items: [] }`); other objects keep their identity.
  (O-44, SPEC §2.2)
- `@domecs/core`: the `startLoop` driver keeps running after a system throws;
  the error still propagates from the rAF callback. (O-45)
- `@domecs/core`: `restore()` rewinds `world.rand` in place, so a captured
  `const rng = world.rand` follows the restore. (O-46)
- `@domecs/core`: `restore()` gives an idle `startLoop` driver one heartbeat
  frame (render, no tick), so the restored state is painted and the world
  stays at the checkpoint. (O-48)
- `@domecs/core`: views of despawned entities read through `OnRemoved` are no
  longer cached, which grew without bound in worlds with churn; component
  names containing `|` no longer collide with another archetype. (O-47, O-49)
- `@domecs/persist`: `history.undo()`/`redo()` put the cursor back when the
  restore throws. Corrupt JSON, non-snapshot payloads, unserializable
  snapshots and restore rejections return `persist_io` with
  `retryable: false`; storage I/O failures stay retryable. (O-62)
- AGENTS.md: the post-restore rebuild recipe no longer suggests spawning in a
  plugin `onRestore`, which runs before the snapshot is applied. (O-50)

### Fixed (2026-10-13 engine review — restore continuity, O-40)

- `@domecs/core`: snapshots carry the simulation clock (`WorldSnapshot.scaledTime`,
  plus `fixedBacklog` and its `fixedStep` when fixed steps are owed) and
  `restore()` resumes it —
  `time.elapsed`, the fixed-step accumulator, and the fixed-step phase continue
  from the snapshot instead of restarting at 0, so `fixed` systems (including
  divisor-rate ones) fire on the live world's frames after a load, an undo, or
  an `AgentBridge.reset()` to a mid-run baseline. Older snapshots without the
  fields restore with the clock at 0, as before. `SNAPSHOT_VERSION` stays 2
  (optional fields, like `nextId`). `time.fixedAccumulator` is now kept current
  on a tick where a `tickStart` hook paused the world.
- `@domecs/core`: `restore()` validates the envelope the `onRestore` hooks
  produce (resource values and the clock fields) before it touches world
  state, and a failed restore — invalid envelope or throwing hook — now leaves
  the pending events as they were instead of discarding them. `scaledTime:
  null` is rejected rather than read as a pre-O-40 envelope.
- `@domecs/core`: **behavior change** — query iteration is now ascending entity
  id everywhere (`query().entities`, system `ctx.entities`, reactive deltas,
  `listEntities`, `selectViews`, `countEntities`, `iterEntitiesWith`), and
  `Where` predicates are evaluated in that order. SPEC §8 used to specify
  "archetype order, then entity id", which neither the live path (join order)
  nor restore (rebuilt by id) delivered consistently, so per-entity `rand`
  draws and other order-dependent logic diverged after a restore; archetype
  creation order cannot be restored, so §8 now specifies ascending id. Code
  that relied on join order will see a different order.
- Bench: the snapshot workload's `deterministic` flag now steps a sub-rate
  `fixed` system with frame times that are not fixed-step multiples and compares
  the twins' clocks, so it actually catches a lost accumulator (it reported
  `true` against the old engine).

### Fixed (2026-07-17 review tranche — see `plan/FINDINGS.CLAUDE.md`)

- `@domecs/dom`: O-2 first paint is now driven from the update phase with a
  fresh commit-time entity view — an entity created *and* marked changed in
  one commit window gets exactly one `update()` (was two), and components
  added later in the same window (spawn bags) are visible to the first
  paint. SPEC §5.3 / api.md / package README document the first-paint
  exception. (R-4/R-5/R-6)
- `@domecs/core`: `stop()` relinquishes a `pauseOnHidden` driver-owned
  pause, so a stop+startLoop cycle while the tab is hidden can no longer
  orphan the world at scale 0; the remaining ownership limit is documented
  on `StartOptions.pauseOnHidden`. (R-21)
- `@domecs/core`: snapshots carry the entity-id cursor (`WorldSnapshot.nextId`,
  optional) and `restore()` honors it — ids assigned after a restore now
  match the live world even when the highest-id entity was despawned before
  the snapshot, so `AgentBridge.reset()` episodes are id-comparable. Older
  snapshots without the field fall back to the previous maxAliveId+1
  derivation. (O-38)
- `@domecs/core`: `world.action()` validates payloads against the event's
  declared `schema` before emitting — unknown fields, wrong-typed fields,
  or out-of-enum values return `{ accepted: false, reason }` with no emit
  and no tick advance. **Behavior change** for schema-declaring events
  (previously accepted unvalidated); schema-less events and `turn()`/`emit`
  are unchanged. Plantroom's command events now declare schemas. (O-39)
- `@domecs/core`: `world.restore()` discards pending (undelivered) events
  before applying the snapshot — events emitted on the abandoned timeline
  no longer fire into the first tick after a restore, so identical
  `AgentBridge.reset()` episodes can no longer diverge on leftover event
  state. Events a plugin emits during `onRestore` still survive. SPEC §7.1
  now states the contract normatively. (R-34)
- `@domecs/core`: `describeComponent` / `describeEvent` clone `FieldSchema`
  values — manifests no longer share mutable references with live
  reflection metadata.
- `@domecs/core`: `getErrorRepairHint` for `persist_io` distinguishes
  deterministic failures (empty slot → use `loadIfPresent`) from transient
  IO; `doc/error-handling.md`'s retry example consults `e.retryable`
  instead of retrying every `persist_io`. (R-15)
- Plantroom flagship: restore-aware shared checkpoint ring (stale
  abandoned-timeline checkpoints are dropped on restore; no fallback past
  the requested tick), `compareBranches` is a pure evaluator that returns
  the world to the shared base and resumes a paused world for its rollouts,
  the plant holds a genuine steady state via a LIC-101 level loop (alarms
  only on real upsets, HI-TEMP added), alarm acks latch honestly, and every
  control command answers through a `CommandResult` resolver so
  `world.action` verdicts are truthful. Checkpoint cadence keys to sim
  time (frame-rate independent), and restored state repaints while paused
  via a heartbeat. (R-1/R-9..R-14/R-24/R-25)
- Bench: warmup discard for every engine, GC isolation under
  `--expose-gc`, compare verdicts scoped to same-N rows, cross-engine
  `domUpdates` equivalence check, telemetry workload with real coalescing
  pressure (`coalesceRatio`), warmed repeated snapshot percentiles with a
  stepped determinism check, and an actionable missing-dist guard.
  (R-2/R-3/R-18/R-19/R-28/R-29/R-30)
- Infra: CI runs the WS-3 legibility gate; `plantroom:build:pages` actually
  passes `--base=/domecs/`; `publish:npm` filters by `./packages/*`
  directory; Pages workflow uses `configure-pages` (first-deploy safe) and
  `cancel-in-progress: false`; cold-install discovers tarballs on disk
  (space-safe on Windows) and announces a retained stage on failure.
  (R-17/R-26/R-27)

### Added

- `@domecs/scene` (new package): a `Parent` component with `setParent`,
  `childrenOf`, `ancestorsOf`, `rootsOf` and `despawnTree`; `installHierarchy`
  (children of a plainly despawned parent move to the root); and
  `composeTransforms`, which keeps a world-space component derived from a
  local one, parent before child.
- `@domecs/rules` (new package): a small, safe expression language
  (`parseExpression`, `evaluate`) and `compileRule`/`installRules`, which
  turn JSON-shaped rule data (`query`, `when`, `actions`) into world systems.
  `random()` draws from the tick's seeded `ctx.rand`.
- `@domecs/persist`: `serializeComponentType` and `registerComponentTypes`
  round-trip user-authored component types through plain data, reporting
  problems as `SchemaProblem` entries instead of throwing.
- `createAgentBridge(world, opts?)` in `@domecs/core` (PLAN WS-3) — thin agent
  facade: `reset` / `observe` / `act` / `step` / `snapshot` over existing
  world APIs. Ships with root `AGENTS.md` and `skills/domecs/SKILL.md`.
- Cold-install smoke: `node scripts/cold-install.mjs` (and
  `RUN_COLD_INSTALL=1` node test) packs tarballs into an empty temp project
  and probes published-layout imports.
- Agent legibility mini-app: `example/agent-legibility` + `pnpm test:legibility`.
- Plantroom WS-4 scaffold: `example/plantroom` (tags/alarms/pump, branch
  compare, `pnpm test:plantroom`).
- Plantroom multi-view browser chrome (Vite): tags / alarms / plant slots +
  trend canvas + toolbar branch compare.
- Plantroom WS-4 complete: historian scrub + checkpoint restore, operator
  approval panel for agent proposals, ~200 sensors scale, shared
  `buildPlant.js` domain, dogfood decision (stay in monorepo).
- Plantroom polish for manual testing (guide path, keyboard shortcuts) and
  GitHub Pages deploy (`.github/workflows/pages.yml` → `/domecs/`).
- Bench workloads: windowed projection + plain baseline; `pnpm bench:write`.
- Bench compare: Koota + hand-rolled signals baselines (`--workload compare`);
  honest no-decisive-win writeup in `bench/COMPARISON.md`.
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

[Unreleased]: https://github.com/hypernovasystem/domecs/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/hypernovasystem/domecs/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/hypernovasystem/domecs/releases/tag/v1.0.0
