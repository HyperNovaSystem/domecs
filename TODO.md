# DOMECS TODO

Review date: 2026-05-13.

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

## Top 10 Outstanding (Dispositioned)

0. ✅ **Completed** — JSDoc quality sweep + TODO typo fix.
   - Added complete but terse API JSDoc to world observation APIs that are
     central for AI-assisted usage discovery.
   - Fixed `documentatio` typo in this TODO stream as part of the cleanup.

1. 🛠️ **Implemented** — Dev diagnostics scope de-scoped for v0.1.
   - Decision: remove proxy-backed diagnostics/counters from the v0.1
     contract, and do not expose `WorldOptions.dev` in the current API surface.
   - Action: track a future diagnostics API as post-v0.1 roadmap work.

2. ⛔ **Wontfix (for v0.1)** — Snapshot restore rich reflection/signals.
   - Reason: adding snapshot-carried type metadata now would harden an unstable
     schema surface too early.
   - Decision: keep current name-keyed restore behavior and require registry
     rehydration by user code until a formal schema format lands.

3. ⛔ **Wontfix (for v0.1)** — Restore-time validation.
   - Reason: restore is intentionally trust-boundary based for authored
     snapshots; validating without stable type metadata produces partial and
     potentially misleading guarantees.
   - Decision: document trust model and defer strict validation to the future
     metadata-backed restore path.

4. ⛔ **Wontfix (for v0.1)** — Deep schema reflection.
   - Reason: runtime schema format is still under design and should not be
     prematurely frozen.
   - Decision: keep `componentTypes()`-level reflection only.

5. 🛠️ **Implemented** — Input contract explicitly deferred from v0.1.
   - Decision: target-relative coordinate normalization and enter/leave
     tracking are moved to the next input milestone.
   - Action: keep raw DOM coordinates in v0.1 and mark advanced semantics as
     roadmap work with dedicated tests later.

6. ⛔ **Wontfix (for v0.1)** — Build `@domecs/persist` now.
   - Reason: package-level persistence/migrations is substantial and would
     delay runtime stabilization.
   - Decision: prioritize runtime contract stability before adding persistence.

7. ⛔ **Wontfix (for v0.1)** — Diff snapshot ring buffer.
   - Reason: depends on persistence substrate and inspector protocol shape.
   - Decision: defer until `@domecs/persist` and inspector MVP exist.

8. ⛔ **Wontfix (for v0.1)** — Build `@domecs/sprites` now.
   - Reason: renderer extension can iterate independently once core/plugin APIs
     are stable.
   - Decision: defer to post-v0.1 package phase.

9. ⛔ **Wontfix (for v0.1)** — Build `@domecs/inspector` now.
   - Reason: inspector quality depends on the deferred diff snapshot substrate.
   - Decision: defer until persistence + diff foundations land.

10. ⛔ **Wontfix (for v0.1)** — Worker-host surface.
   - Reason: structured-clone-safe design should follow stable persistence and
     messaging contracts.
   - Decision: postpone until after first release hardens cloning boundaries.

## Packaging and Vite Interop

Vite should be the blessed app packaging/deployment path, while DOMECS runtime
packages remain bundler-agnostic ESM libraries. See
[doc/PACKAGING.md](./doc/PACKAGING.md).

- Add an official Vite-powered app template, eventually exposed through
  `npm create domecs@latest my-game` / `pnpm create domecs my-game`.
- Add an optional `@domecs/vite` plugin only for higher-level framework value:
  sprite/asset manifests, dev inspector injection, HMR helpers, build-time
  metadata checks, and persist migration validation.
- Verify the npm publish path before first release: workspace packages use
  source exports for local dev, while `publishConfig` rewrites published
  metadata to built `dist` ESM + `.d.ts` exports.
- Document Vite deployment recipes, including `base` for GitHub Pages,
  itch.io/subdirectory hosting, and static hosting of `dist/`.
- Decide asset conventions for CSS sprites, image/audio files, generated
  manifests, and whether any first-party package CSS needs `sideEffects`
  metadata.
- Confirm Vite workspace interop for pnpm symlinks, dependency de-duplication,
  and component identity if multiple copies of `domecs` are installed.
- Keep Node/headless use healthy: core must stay importable without browser
  globals, and DOM packages should not require a live `document` at import time.
- Keep Vitest as the default testing path for templates/examples, with
  `happy-dom` only for DOM-specific tests.
