# DOMECS Findings — prism_app (template create-flow validation)

`prism_app` exists to test the `domecs_template_vite` create flow from scratch as the seventh HyperNova app.

## 2026-05-16 — workspace-internal create flow forks the template

The template ships with `@domecs/core` / `@domecs/dom` / `@domecs/input` declared at the scoped public versions (`^0.1.0-alpha.0`), as documented in `FINDINGS_DOMECS_TEMPLATE_VITE.md`. Until the first npm publish, a fresh `npm install` against the unmodified template 404s.

To scaffold `prism_app` inside the HyperNova workspace, two template files had to diverge from what the template ships:

- `package.json`: rewrote the three `@domecs/*` deps to `file:../domecs/packages/...`, matching the sibling exemplars.
- `vite.config.ts`: removed the `DOMECS_LOCAL_DEV` alias branch (it points one directory up from the template's own location; a peer-of-template app would need to either adjust the relative paths or drop the branch entirely).

Suggested follow-up:

- Treat workspace-internal usage as a first-class flow, not a side door. Either ship a second template (`domecs_template_vite_workspace`) with `file:` deps and no alias branch, or document the exact `package.json` + `vite.config.ts` diff that workspace consumers must apply.
- Once `create-domecs` lands, have it accept a `--workspace <relative-path>` flag that emits the workspace variant automatically.

## 2026-05-16 — `tsc --noEmit` against template strict config surfaces an engine-side `noUnusedParameters` regression

The template's `tsconfig.json` ships `"strict": true` plus `"noUnusedLocals": true` and `"noUnusedParameters": true`. Because the workspace apps consume `@domecs/*` via `file:` source paths (not built `.d.ts` files), `tsc --noEmit` in a consuming app typechecks the engine sources directly.

`prism_app`'s first `npm test` failed with:

```
../domecs/packages/domecs-dom/src/mount.ts(124,19): error TS6133: 'view' is declared but its value is never read.
```

The loop in `commit()` destructured `[id, view]` from `state.pendingDestroy` but only used `id`. The engine's own typecheck did not catch this because its package-local config (or vitest's transform) does not run with `noUnusedParameters` against destructured tuple positions. Fix was to iterate `state.pendingDestroy.keys()`.

Suggested follow-up:

- Align engine package `tsconfig`s with the strictest consumer config the template advertises, or run the template's exact `tsc --noEmit` invocation against engine sources in CI. Otherwise the next regression of this kind ships and only breaks at first downstream `npm test`.
- Consider documenting in `doc/PACKAGING.md` that *every* engine source file is part of the public API surface while apps consume it via `file:` deps — currently the line between "engine internals" and "public surface" is implicit.

## 2026-05-16 — template's `.gitignore` ignores `dist/` but the template ships `dist/`

`domecs_template_vite/.gitignore` excludes build output, but the template directory itself contains a `dist/` from a prior build. Copying `src/`, `index.html`, `tsconfig.json`, etc. into `prism_app/` works cleanly only if the operator skips `dist/`, `node_modules/`, and `.tmp/` by hand. A copy-everything operator would carry stale artifacts forward.

Suggested follow-up:

- When `create-domecs` lands, have it copy only tracked files (e.g. via `git ls-files`) rather than mirroring the directory verbatim, so stale build output never gets seeded into a new app.

## 2026-05-16 — template ships its own `.git`, complicating in-place clone

`domecs_template_vite` is itself a standalone repository (`.git/` present). Copying it via `cp -r template new_app` therefore pulls the template's history along with it; the operator must remember to `rm -rf new_app/.git` before `git init`. None of the other six HyperNova apps tripped this because they were authored in-place, not cloned.

Suggested follow-up:

- `create-domecs` should always strip `.git/` and `node_modules/` from the scaffold output. Until it ships, the template README should call this out in the "Scripts" section so manual copy users do not inherit the template's commit log.
