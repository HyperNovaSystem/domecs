# DOMECS Findings — Harbor Authority Exemplar

Notes from fleshing out `harbor_game`, based on exemplar #2 in `doc/exemplars.md`.

## Summary

The current DOMECS slice was expressive enough to build the Harbor Authority prototype: thousands of containers can simulate without DOM nodes, `Visible` can gate rendering, `time.scaledDelta` supports pause/fast-forward, events handle burst arrivals, and transient components keep UI projection state out of snapshots.

The implementation also exposed several framework gaps that matter before a real 20k-entity management sim can be considered validated.

## Findings

### 1. Fast-forward needs first-class logical substepping

Harbor Authority wants pause, 1×, 4×, 16×, and 64×. The prototype uses `world.time.scaledDelta`, so one browser frame at 64× can become a single very large tick. That is acceptable for coarse continuous systems, but not for systems that assume logical 60 Hz or bounded per-tick work.

Suggestion:

- Add/document a scheduler mode or driver option for bounded logical substeps, e.g. `world.start({ maxSimStep: 1 / 60, maxSubsteps: N })`.
- Make the intended relationship between `tick`, `fixed`, fast-forward, and render cadence explicit in `SPEC.md`.
- Provide exemplar guidance: management-sim hot paths should generally be `fixed`, while DOM/HUD projection should stay render-rate sampled.

### 2. Relationship/index support is needed for large sims

The prototype stores relationships as entity ids (`shipId`, `berthId`, `warehouseId`) and then scans arrays to answer questions like:

- containers aboard a ship
- yard containers at a berth
- cranes assigned to a berth
- least-full warehouse

This is fine for a demonstrator but becomes the wrong shape for 20k+ entities.

Suggestion:

- Provide an official secondary-index plugin pattern, e.g. `indexBy(Component, field)`.
- Support common relationship indexes: one-to-many, many-to-one, nullable entity refs.
- Consider lifecycle/integrity helpers for dangling entity references on despawn.

### 3. Selective rendering works, but `Visible` causes structural churn

The exemplar uses transient `Visible` components as the renderer admission gate. This proves unrendered entities are possible, but changing the focused berth removes/adds `Visible` on many entities, causing structural query changes and renderer mount/unmount churn.

Suggestion:

- Keep `Visible` as the simple v0.1 story, but add a documented viewport/windowing pattern.
- Consider view-level admission predicates or virtualized view adapters so render visibility can change without changing entity archetypes.
- Expose renderer metrics for mounted count, created/destroyed count, and updated count to catch accidental all-entity DOM projection.

### 4. Synchronous snapshots will jank at Harbor scale

`world.snapshot()` plus `JSON.stringify()` is easy and worked in tests, and transient components correctly omitted UI projection state. But a real Harbor Authority save of 20k entities will be too expensive to do synchronously on the main thread during play.

Suggestion:

- Define an async/chunked snapshot API before v1, even if backed by the current sync snapshot initially.
- Make snapshot data explicitly structured-clone-safe for future Worker hosting.
- Document which component values are snapshot-safe and what transient components are for.

### 5. Worker hosting conflicts with closure-heavy systems

The current ergonomic style encourages systems that close over `world`, entity id arrays, DOM-facing state, and helper functions. That is pleasant in app code, but hard to move off-main-thread or serialize.

Suggestion:

- Design the Worker host API around a constrained subset of system definitions.
- Document what must be cloneable: component values, event payloads, plugin config, snapshots.
- Consider a split between simulation systems and presentation systems in examples.

### 6. Event bus needs observable backpressure semantics

Burst `ManualShipArrivalEvent` tests passed: all events were delivered. The framework already buffers arrays per event type, which is good. What is missing is visibility into pressure and policy.

Suggestion:

- Expose per-tick event counts/bytes for instrumentation.
- Document whether events are guaranteed lossless by default.
- Consider optional coalescing/drop policies for dashboard-style feeds, while keeping game/sim events lossless.

### 7. Batch mutation APIs would reduce hot-path overhead

Large updates require many repeated calls such as `markChanged(entity, Component)`, `addComponent`, and `removeComponent`. In Harbor, crane/worker/container systems can touch hundreds or thousands of entities in one tick.

Suggestion:

- Add/document batch helpers like `markChangedMany(Component, ids)` or scoped mutation batches.
- Ensure query invalidation only fires composition hooks on composition changes, not value changes. This appeared to hold in practice and is important enough to preserve with tests.

### 8. Need performance benchmark exemplars, not only behavioral tests

The Harbor tests verify correctness paths, but they do not assert frame/tick budgets. Exemplar #2 is primarily about scale and throughput.

Suggestion:

- Add a benchmark harness for `20k entities / 64× speed / selective render`.
- Track query iteration, event delivery, snapshot size/time, and DOM mount/update counts.
- Keep the benchmark headless by default so it can run in CI as a regression signal.

## What worked well

- Transient components are a good fit for UI projection (`Visible`, `Viewport`).
- The DOM renderer can mount only a narrow query, so background entities do not imply DOM nodes.
- `time.scale` + `scaledDelta` made pause/fast-forward straightforward.
- Event systems were natural for UI controls and burst arrivals.
- Snapshot/restore shape is simple enough to use as autosave plumbing in application code.
