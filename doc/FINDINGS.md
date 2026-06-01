# DOMECS Engine Review Findings

Review date: 2026-06-01

Scope: core engine (`packages/domecs`), DOM renderer, input, persistence, package READMEs, and top-level design docs. The focus was documentation drift, inconsistencies, over-engineering signals, and concrete code improvement opportunities rather than broad feature design.

## Executive summary

DOMECS has a coherent core architecture, good type-level ergonomics, and a useful discipline around results, faults, snapshots, and deterministic ticks. The largest gap is not implementation quality; it is that several public documents still describe either earlier aspirational APIs or post-refactor shapes that no longer match the shipped packages. That creates a real adoption risk because a user can copy examples that reference APIs that are not exported.

The highest-priority work is:

1. Align persistence documentation with the shipped `save` / `load` / `Storage` API, or implement the documented `createPersistence` / IndexedDB / autosave facade.
2. Normalize resource API names to `getResource`, not `resource`.
3. Normalize DOM `changedOn` documentation to the discriminated-union form.
4. Decide whether `world.action(..., { dt: 0 })` should reject early or return a non-accepted result, because it currently contradicts its own “action event is consumed” invariant.
5. Split or annotate `world.ts`; it is carrying many unrelated subsystems and review-history comments in one 1,888-line module.

## Findings

### 1. High — persistence docs describe an API and storage backend that are not shipped

**Evidence**

- The top-level README advertises `createPersistence(world, { database, version, migrate })`, async `persist.save`, async `persist.load`, and `persist.autosave`.
- `doc/SPEC.md` repeats that `createPersistence` shape and describes per-component codecs.
- The actual package entry point exports `save`, `load`, `migrate`, `createMemoryStorage`, snapshot-history helpers, and `pruneTransientOnlyEntities`; there is no `createPersistence` export.
- The shipped storage abstraction is synchronous and slot-keyed text storage. The only concrete adapter in-tree is `createMemoryStorage`; IndexedDB, localStorage, filesystem, and network adapters are documented as possible concrete adapters, not implemented exports.

**Impact**

Users following the top-level README will immediately hit a missing export. The README also promises IndexedDB and autosave as “first-class” while the released package currently exposes a low-level storage interface. This makes `@domecs/persist` look broken even though the implemented primitives are usable.

**Recommendation**

Pick one direction and make it explicit:

- Documentation-first fix: rewrite top-level README and SPEC persistence sections around `save(world, storage, slot, opts?)`, `load(world, storage, slot, opts?)`, `Storage`, `createMemoryStorage`, and snapshot-history.
- Product/API fix: add the documented `createPersistence` facade plus IndexedDB adapter and autosave, then keep lower-level primitives as advanced APIs.

Until the facade exists, avoid calling persistence “IndexedDB save/load” in install comments and feature lists.

---

### 2. High — resource docs use `world.resource(...)`, but the public engine API is `getResource(...)`

**Evidence**

- `World` exposes `getResource(type)`, `setResource(type, value)`, and `markResourceChanged(type)`.
- `packages/domecs/README.md`, `doc/SPEC.md`, and `doc/api.md` refer to `world.resource(...)` and say defaults materialize on first `resource(R)` read.

**Impact**

This is a copy/paste failure for a core v1 API. It is especially confusing because the surrounding `setResource` and `markResourceChanged` names are correct, making the nonexistent `resource` method look intentional.

**Recommendation**

Replace all user-facing `world.resource(R)` / `resource(R)` mentions with `world.getResource(R)` / `getResource(R)`, and add a short note that the returned value is live and in-place mutations require `markResourceChanged`.

---

### 3. High — DOM `changedOn` docs still describe an array API, but code ships a discriminated union

**Evidence**

- `ViewDef.changedOn` is typed as `{ mode: 'auto' } | { mode: 'legacy' } | { mode: 'explicit'; types: ... }`.
- The renderer resolves those modes explicitly.
- `doc/SPEC.md`, `doc/api.md`, and `packages/domecs-dom/README.md` still describe `changedOn: []` as legacy redraw-every-tick and `changedOn: [Type, ...]` as explicit gating.

**Impact**

The docs invite users to write TypeScript that no longer type-checks. It also hides the more legible shipped API: `{ mode: 'legacy' }` and `{ mode: 'explicit', types }` are clearer than the previous array tri-state.

**Recommendation**

Update all docs and examples to:

- omitted or `{ mode: 'auto' }` → derive from `Has` leaves;
- `{ mode: 'legacy' }` → redraw every tick;
- `{ mode: 'explicit', types: [Position] }` → gate on exactly those components.

---

### 4. High — `world.action(..., { dt: 0 })` can return the action event as a “downstream” event

**Evidence**

- `action` emits the action event, then calls `stepOnce()` or `step(opts.dt)`, then reads `bus.pendingEvents()`.
- A non-positive explicit `dt` is documented as a heartbeat that will not process the action.
- During a heartbeat, the event buffer is not flushed. Therefore the just-emitted action event remains in `pending`, and `pendingEvents()` can include the action event even though the API docs state the action event was consumed and is not included.

**Impact**

This is an edge-case correctness bug in a turn-based command API. A caller that passes `{ dt: 0 }` to mean “zero-time turn” gets a heartbeat instead; the returned result may report the original command as if it were a downstream effect, and the default verdict still reports `accepted: true` / `consumedTurn: true` unless the resolver compensates.

**Recommendation**

Consider one of these changes:

- Reject `opts.dt <= 0` in `action` with a programmer-error throw or a structured rejected result.
- Treat `action(..., { dt: 0 })` like `stepOnce()` rather than heartbeat, because action semantics promise a processed command.
- If heartbeat behavior is retained, compute `events` from only emissions after a successful flush, and default to `accepted: false, consumedTurn: false` when no tick was processed.

Add an explicit regression test for `action(Event, payload, { dt: 0 })`.

---

### 5. Medium — README status and roadmap disagree with each other and with shipped package state

**Evidence**

- The top-level README says v1.0.0 is stable and all five `@domecs/*` packages are published at 1.0.0.
- The same README roadmap still has unchecked items for the core engine, DOM renderer, IndexedDB persistence, inspector, and time-travel debugger.
- `doc/SPEC.md` says v1.0 is an API freeze for core/dom/persist but also lists aspirational packages such as `@domecs/sprites` and `@domecs/worker` alongside implemented packages.

**Impact**

This creates uncertainty about what is production-ready. Users and agents cannot tell whether unchecked roadmap entries are stale, intentionally incomplete, or waiting for future work.

**Recommendation**

Split the roadmap into “shipped in v1.0”, “planned packages”, and “not currently implemented”. Move `@domecs/sprites` and `@domecs/worker` out of the package list or mark them explicitly as planned/nonexistent.

---

### 6. Medium — implementation history comments leak into public code and confuse versioning

**Evidence**

Examples include comments such as `review #16`, `#17`, `F-6`, `D-4`, and “Remove after v0.2” in current v1.0 code.

**Impact**

The comments are useful to maintainers who know the review thread, but they make the shipped source harder for external contributors to read. The `__wake` comment says it should be removed after v0.2 even though the package is v1.0, which raises the question of whether stale compatibility code remains unintentionally.

**Recommendation**

Replace internal review IDs with stable ADR/doc links or short rationale comments. Decide whether `world.__wake` should still exist in v1.x; if it must remain, document it as compatibility debt with a current removal plan.

---

### 7. Medium — `world.ts` is a large multi-responsibility module that increases review cost

**Evidence**

`packages/domecs/src/world.ts` owns entity storage, archetypes, query maintenance, resources, event/tick orchestration, RAF driver state, action/turn APIs, plugin lifecycle integration, snapshot/restore, reflection, and built-in fault consolidation in one file.

**Impact**

The module is currently understandable, but it is costly to review safely because small changes often cross subsystem boundaries. The file also duplicates some concepts that already have dedicated modules (`events`, `scheduler`, `snapshot`, `resource`, `plugin`).

**Recommendation**

Refactor incrementally rather than rewrite:

- Extract resource registry/materialization into a small internal helper.
- Extract snapshot/restore mechanics into an internal `world-state` helper that receives stores/registries.
- Extract RAF driver state into an internal `driver` helper.
- Keep the public `World` factory as the orchestration layer.

This should be done after documentation drift fixes so API behavior stays stable during refactor.

---

### 8. Medium — reactive resource fallback adds special-case complexity that should be documented with examples

**Evidence**

`changedResource` is structurally neutral, `evalEntity` treats it as an entity-independent per-tick gate, and `reactiveResourceFallback` separately fires purely resource-gated reactive systems when there are no structural `Has` components.

**Impact**

This is clever and likely correct, but it is a non-obvious semantic split: entity-scoped resource reactions run over matching entities, while pure resource reactions need a special fallback because there are no entity members to trigger on. Without clear docs/tests, future changes to query evaluation can easily break one side.

**Recommendation**

Add a SPEC subsection and examples for:

- `And(Has(Position), OnChangedResource(Config))` → runs over matching entities only on changed resource ticks.
- `OnChangedResource(Config)` in a reactive system with no entity query → one coalesced call with empty `ctx.entities`.

Keep or expand tests around both forms before touching query internals.

---

### 9. Low — snapshot cloning is documented as JSON-safe but implemented as a plain recursive clone

**Evidence**

`snapshot()` deep-clones components and resources via `cloneSerializable`, which handles arrays and plain object keys recursively. It does not detect cycles, preserve richer structured-clone types, or reject non-JSON leaves. `save()` later relies on `JSON.stringify` and converts serialization errors into `persist_io`.

**Impact**

This is acceptable if the contract is “JSON-ish plain data”, but some docs imply broader structured-clone behavior. Cyclic component values can overflow during `snapshot()` before `save()` reaches the JSON error boundary, and values such as `Date`, `Map`, `Set`, functions, or class instances are not meaningfully preserved.

**Recommendation**

Tighten the docs to say snapshots are plain-data/JSON-oriented unless a future codec layer is added. Optionally add development validation for cycles and unsupported values, or use `structuredClone` behind a capability check if preserving richer data is a goal.

---

### 10. Low — fault result shape-check is intentionally permissive, but malformed fault entries can leak through

**Evidence**

`runSystem` treats any object with an array `errors` property as a `SystemResult`, then `buildFaultEntry` assumes `fault.error.kind` exists and normalizes the rest of the payload. `strictReturns` only warns when the whole return value is not shaped like a result; it does not validate each fault.

**Impact**

This matches the “void by default, opt into results” design, but typoed fault entries can produce vague runtime errors or entries with invalid kinds. That is manageable for trusted TypeScript code, less so for untyped JS consumers or agent-generated systems.

**Recommendation**

Consider a dev-only strict result validator (perhaps tied to `strictReturns`) that verifies every fault has `{ error: { kind: string }, recoverable: boolean }` and reports a clearer warning/error.

## Suggested immediate patch sequence

1. Documentation correction pass: persistence API, resource API, DOM `changedOn`, roadmap/status.
2. Add regression test or guard for `action(..., { dt: 0 })`.
3. Decide `__wake` compatibility status and remove or document it.
4. Add snapshot plain-data validation docs and, optionally, dev diagnostics.
5. Plan a low-risk `world.ts` extraction after the public docs match the API.
