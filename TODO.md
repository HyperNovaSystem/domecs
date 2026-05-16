# DOMECS TODO

Review date: 2026-05-13.

This file tracks upcoming work only. Completed or rejected v0.1 scope decisions
should be documented in `doc/SPEC.md`, `doc/api.md`, `doc/PACKAGING.md`, or a
project-specific `doc/FINDINGS_*.md` file before they are removed from here.

## Next 

- Wire `domecs_template_vite` into the future create flow:
  `npm create domecs@latest my-game` / `pnpm create domecs my-game`.
- Document Vite deployment recipes, including `base` for GitHub Pages, itch.io/subdirectory hosting, and static hosting of `dist/`.
- Wire `pnpm run release:validate` into CI once the packed-package smoke test is stable across the workspace and `HyperNovaSystem` app repositories.
- Confirm Vite workspace interop for pnpm symlinks, dependency de-duplication,
  and component identity if multiple copies of `@domecs/core` are installed.
- Decide asset conventions for CSS sprites, image/audio files, generated
  manifests, and whether any first-party package CSS needs `sideEffects`
  metadata.
- Keep Vitest as the default testing path for templates/examples, with
  `happy-dom` only for DOM-specific tests.

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
