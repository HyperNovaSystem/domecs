# DOMECS TODO

Review date: 2026-05-05.

Current status: the workspace is green on `pnpm test` and `pnpm typecheck`.
This file tracks the next highest-value engine and package work after the
first red/green pass on the core runtime contract.

## Completed In This Pass

- `headless` is now a real mode: `World.start()` throws for
  `createWorld({ headless: true })`, even in browser-like environments.
- The realtime driver now honors `idle`, sleeping when no frame work remains
  and waking on external world activity and `domecs-input` events.
- `ComponentOptions.validate` now runs through `ComponentType.create()` and
  `world.addComponent(...)`.
- `world.observe(...)` now exists as query-observation sugar, including
  reactive `onChange` for change-detection queries.
- `SystemHandle.replaceFn(...)` now swaps implementations at the next tick
  boundary.

## Top 10 Outstanding

1. Add the dev diagnostics surface promised by the SPEC.
`WorldOptions.dev` and `world.diag.markChanged` are still documented, but the
runtime has no proxy-backed mutation diagnostics or counters yet.
Evidence: [doc/SPEC.md](./doc/SPEC.md) lines 183-205, [doc/api.md](./doc/api.md) lines 19-31 and 111-127.
Next step: either implement the diagnostics surface end-to-end or explicitly
de-scope it from the v0.1 contract.

2. Fix snapshot restore so reflection and signals work in a fresh world.
`restore()` rebuilds stores from component names only, so a fresh world cannot
fully recover `componentTypes()`, `archetype()`, or type-rich signal payloads
until matching `ComponentType` objects re-enter through user code.
Evidence: [packages/domecs/src/world.ts](./packages/domecs/src/world.ts) and [doc/api.md](./doc/api.md).
Next step: decide between snapshot-carried type metadata and an explicit
registry-based restore path.

3. Decide restore-time validation behavior now that add-time validation exists.
`addComponent(...)` now validates, but `restore()` still trusts snapshot
payloads blindly because rehydration is name-keyed rather than type-keyed.
Evidence: [packages/domecs/src/component.ts](./packages/domecs/src/component.ts), [packages/domecs/src/world.ts](./packages/domecs/src/world.ts).
Next step: either validate during restore when types are known, or document
snapshot trust boundaries more explicitly.

4. Deepen schema reflection beyond `componentTypes()`.
The editor/inspector roadmap needs field-level schema data, but core
reflection still stops at opaque component handles plus names/factories.
Evidence: [doc/exemplars.md](./doc/exemplars.md) lines 196-202 and 225-229, [packages/domecs/src/component.ts](./packages/domecs/src/component.ts).
Next step: choose a runtime schema format that survives TypeScript erasure and
expose it intentionally.

5. Finish the input contract: target-relative coordinates and enter/leave tracking.
The input plugin still records raw `clientX/clientY`, and `pointer.entered`
remains unused.
Evidence: [packages/domecs-input/src/collector.ts](./packages/domecs-input/src/collector.ts), [packages/domecs/src/input.ts](./packages/domecs/src/input.ts).
Next step: compute coordinates relative to `pointerTarget`, define enter/leave
semantics, and pin them with DOM tests.

6. Build `@domecs/persist`.
The docs already describe IndexedDB save/load, autosave, codecs, and
migrations, but the package does not exist in this repo yet.
Evidence: [doc/api.md](./doc/api.md) lines 544-586, [README.md](./README.md) lines 257-258.
Next step: ship the package before more higher-level features depend on it.

7. Add the diff snapshot ring buffer needed for time travel.
The editor/inspector story depends on bounded diff snapshots rather than full
world copies, and that substrate is still missing.
Evidence: [doc/exemplars.md](./doc/exemplars.md) lines 198-201, [doc/SPEC.md](./doc/SPEC.md) lines 462-468.
Next step: define the diff format and memory bounds in the persistence layer.

8. Build `@domecs/sprites`.
The DOM renderer exists, but the first-party sprite sheet / animation layer
promised by the docs and README is still absent.
Evidence: [doc/api.md](./doc/api.md) lines 503-540, [README.md](./README.md) lines 257-258.
Next step: land sprite + animation components as a plugin on top of
`domecs-dom`.

9. Build `@domecs/inspector`.
The inspector, entity browser, and devtools hooks are still a paper surface.
Evidence: [doc/api.md](./doc/api.md) lines 590-603, [README.md](./README.md) lines 259-259.
Next step: start with entity/component inspection and reuse the future diff
ring buffer for time-travel work.

10. Prepare the worker-host surface for off-main-thread simulation.
The management-sim roadmap still depends on a structured-clone-safe worker host
that is not yet implemented.
Evidence: [doc/SPEC.md](./doc/SPEC.md) lines 590-597, [README.md](./README.md) lines 262-263.
Next step: audit core/persistence APIs for structured-clone assumptions before
building `@domecs/worker`.
