# DOMECS TODO

Review date: 2026-05-13.

This file tracks upcoming work only. Completed or rejected v0.1 scope decisions
should be documented in `doc/SPEC.md`, `doc/api.md`, `doc/PACKAGING.md`, or a
project-specific `doc/FINDINGS_*.md` file before they are removed from here.

## Next 

- Wire `domecs_template_vite` into the future create flow:
  `npm create domecs@latest my-game` / `pnpm create domecs my-game`.
  (Template itself is ready — only the `create-domecs` publisher package is
  pending.)
- Wire `pnpm run release:validate` into CI once the packed-package smoke test is stable across the workspace and `HyperNovaSystem` app repositories.

### Resolved 2026-05-16 (template/Vite interop)

- Documented Vite deployment recipes (GitHub Pages project + user sites,
  itch.io, generic static hosts, subdirectory installs) in the template
  README; build now reads `BASE_PATH` from the env.
- Confirmed workspace interop: template `vite.config.ts` sets
  `resolve.dedupe` for `@domecs/{core,dom,input}` so component identity is
  stable across hoisted pnpm graphs, and keeps `preserveSymlinks: false`.
- Settled asset conventions on Vite's native graph (`src/assets/`, `?url`,
  `?inline`, `?raw`, `import.meta.glob`); marked `@domecs/{core,dom,input}`
  as `"sideEffects": false` so bundlers can tree-shake without dropping
  required styles (no first-party CSS ships today).
- Vitest now defaults to the `node` environment in the template; DOM-only
  specs opt in via `*.dom.test.ts` + `environmentMatchGlobs` → `happy-dom`.

## Future

- Design a post-v0.1 diagnostics surface for mark discipline and stale
  references.  Do not re-add proxy-backed `WorldOptions.dev` or `world.diag` to
  the v0.1 core contract without updating the spec first.
- Extend input beyond the v0.1 raw DOM snapshot: target-relative pointer
  coordinates, hit-tested enter/leave tracking, high-level action mapping, and
  dedicated tests.
- Build `@domecs/persist` with IndexedDB slots, component codecs, migrations,
  import/export helpers, and restore validation once schema metadata exists.
- Add metadata-backed restore and reflection tooling for unknown components,
  strict validation, editor widgets, and migration diagnostics.
- Add a diff snapshot ring buffer for time-travel and inspector workflows after
  persistence and inspector protocol foundations are stable.
- Build `@domecs/sprites` as a DOM renderer extension for sprite sheets and
  frame animation.
- Build `@domecs/inspector` after persistence and diff snapshot foundations
  exist.
- Review and decide on implementing Phase 5 of BETTER_ERRORS.md
- Build `@domecs/worker` after persistence and structured-clone messaging
  contracts are stable.
- Add an optional `@domecs/vite` plugin only for higher-level framework value:
  sprite/asset manifests, dev inspector injection, HMR helpers, build-time
  metadata checks, and persist migration validation.
