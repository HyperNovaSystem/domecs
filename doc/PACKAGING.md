# DOMECS Packaging and Vite Interop

Review date: 2026-05-13.

DOMECS is intended to be a full browser app framework for rich DOM-first apps and games.
Vite should be the blessed development, build, and deployment path for DOMECS applications, while the runtime packages remain normal ESM libraries with no bundler lock-in.

## Decision

Use Vite as the official app scaffold and deployment story, but do not make Vite a runtime dependency of the core framework packages.

Recommended split:

```txt
@domecs/core / @domecs/dom / @domecs/input  = runtime libraries, bundler-agnostic
HyperNovaSystem/<app> repos                 = Vite applications
create-domecs template(s)                    = Vite by default
@domecs/vite                                 = optional advanced Vite plugin
```

The `@domecs` npm organization/scope has been officially reserved for this project.
Use `@domecs/*` for all first-party runtime packages. The first public release
publishes core as `@domecs/core`, the DOM renderer as `@domecs/dom`, and the
input collector as `@domecs/input`. The older unscoped names (`domecs`,
`domecs-dom`, `domecs-input`) are not official first-release package names.

The GitHub organization is `HyperNovaSystem`. The engine repository is
`HyperNovaSystem/domecs`, and the example applications live as separate
downstream app repositories in the same GitHub organization
(`HyperNovaSystem/dashboard`, `/restaurant`, `/roguelike`, `/railroad`, `/fleet`).

This keeps DOMECS pleasant for app authors without preventing use from other
bundlers, embedded pages, React/Svelte shells, or plain browser module graphs.


## Current repository and org state

The standalone example app repos already validate the intended direction:

- `HyperNovaSystem/restaurant` uses `vite`, `vite build`, and `vite preview`.
- `HyperNovaSystem/dashboard` uses the same pattern.
- `HyperNovaSystem/roguelike` also has Vite configuration.
- each app depends on the runtime packages via `file:../domecs/packages/*`,
  cloned alongside this repo, so it resolves the engine's TypeScript source directly.

Separate example app repositories under `HyperNovaSystem` should validate the
published-package path: fresh installs from npm or packed tarballs, template
defaults, static deployment recipes, and compatibility with real app repo
layouts.

That is the right app shape.
The framework packages intentionally expose TypeScript source directly in the workspace, e.g. `"exports": { ".": "./src/index.ts" }`, so examples and local development keep working immediately after `pnpm install`.
For npm publication, `publishConfig` rewrites the package metadata to built `dist` JavaScript and declaration exports.


## Release validation

Release validation has two tiers:

1. **Source interop.** The standalone example app repos depend on `@domecs/*`
   through `file:../domecs/packages/*`, resolving the engine's TypeScript
   source directly. Running their normal `test`, `typecheck`, and `build`
   scripts catches source-level breakage while the engine packages are edited
   in place.
2. **Packed-package smoke tests.** Before publishing a new engine version, run
   `pnpm run release:validate`. The harness builds `packages/*`, packs all five
   published packages — `@domecs/core`, `@domecs/dom`, `@domecs/input`,
   `@domecs/inspector`, and `@domecs/persist` — stages clean copies of the
   example apps, rewrites their `@domecs/*` dependencies to the generated
   tarballs, runs a **Node ESM import probe** (`node --input-type=module -e`)
   that dynamically imports each packed package the app uses, then runs each
   app's `test` and `build` scripts from that staged install. This catches
   missing `dist` files, bad `publishConfig`/`exports` metadata, CJS/ESM
   interop breakage, stale import names, package-manager assumptions, and
   static Vite build regressions before npm publish.

The staged smoke test must not rewrite source imports. Applications validate
the public API by importing the scoped packages exactly as published:
`@domecs/core`, `@domecs/dom`, and `@domecs/input`. The old unscoped package
names (`domecs`, `domecs-dom`, `domecs-input`) are treated as a release
validation failure.


## App packaging model

A DOMECS application should be a Vite app with scripts like:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@domecs/core": "^1.0.0",
    "@domecs/dom": "^1.0.0",
    "@domecs/input": "^1.0.0"
  },
  "devDependencies": {
    "vite": "^5.4.0",
    "typescript": "^5.6.0"
  }
}
```

The default deployment artifact is Vite's `dist/` directory. This makes static
hosting on GitHub Pages, Netlify, Vercel, Cloudflare Pages, S3, itch.io, or any
ordinary web server straightforward.


## Runtime package publishing model

Core packages should remain bundler-agnostic and publish built ESM plus types.
In the repository, top-level `main` / `types` / `exports` may continue pointing
at `src` for workspace/Vite development. For npm publication, each package's
`publishConfig` rewrites those fields to `dist` exports:

```json
{
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist", "README.md"]
}
```

Packages build with plain `tsc -p tsconfig.build.json`. `tsup` or Rollup may be
useful later if packages need bundled subpath artifacts, minified browser
builds, or more elaborate export maps.

Release from the workspace root with:

```bash
pnpm run publish:npm
```

The script builds all packages first, then runs:

```bash
pnpm -r --filter './packages/*' publish --access public
```


## Official template

The initial official Vite-powered app template lives in the sibling
`domecs_template_vite` repository and should eventually be exposed as
one of:

```bash
npm create domecs@latest my-game
pnpm create domecs my-game
```

Recommended starter layout:

```txt
my-game/
  index.html
  package.json
  tsconfig.json
  vite.config.ts
  src/
    main.ts
    components.ts
    systems.ts
    views.ts
    style.css
```

The template should include:
- vanilla DOM mounting with `@domecs/dom`;
- a minimal tick loop / fixed-step example;
- a basic `once` / `event` / `reactive` system example;
- CSS import and asset usage through Vite;
- `dev`, `build`, `preview`, `typecheck`, and `test` scripts;
- a short deployment note for static hosts;
- optional variants later for React/Svelte shells or PWA/offline play.


## Optional `@domecs/vite` plugin

A Vite plugin should be optional and added only when it provides framework-level value beyond normal Vite usage.

Candidate features:
- sprite atlas or asset manifest generation (roadmap — no sprite package ships in v1.0);
- automatic dev inspector injection in development builds;
- hot-reload helpers for views, systems, and data tables;
- validation of component/view metadata at build time;
- save-schema and migration checks for `@domecs/persist`;
- conventions for game assets, generated imports, and cache-busted manifests;
- build-time warnings for browser-incompatible imports in app code.

The plugin must not be required to run DOMECS. Plain Vite apps should continue
to work with normal package imports.

## Vite interop requirements

Status of the original ten-item checklist:

1. **Package exports** — `publishConfig` rewrites `main` / `types` / `exports`
   to built `dist` ESM and declarations. **Resolved.**
2. **Workspace behavior** — examples resolve `workspace:*` cleanly under pnpm
   with `resolve.preserveSymlinks: false`. **Resolved.**
3. **Dependency de-duplication** — the official template sets
   `resolve.dedupe: ['@domecs/core', '@domecs/dom', '@domecs/input']`. This
   guarantees a single `@domecs/core` instance so `defineComponent` identity
   stays stable when an app also depends on a third-party package that
   transitively pulls in `@domecs/core`. **Resolved (template).**
4. **Browser boundaries** — core stays node-importable (tests run under the
   `node` Vitest environment); DOM/input packages access `document`/`window`
   only inside mount and plugin entry points. **Resolved.**
5. **Static assets** — use Vite's first-class asset graph: import from
   `src/assets/` and let the bundler hash and emit. Use the `?url`, `?inline`,
   and `?raw` suffixes for explicit handling, and `import.meta.glob` for
   sprite/animation manifests. No first-party CSS ships from `@domecs/*`
   packages, so apps own all stylesheets. **Resolved.**
6. **Base paths** — the template reads `BASE_PATH` from the build env and the
   README documents recipes for GitHub Pages, itch.io, and subdirectory
   hosting. **Resolved (template).**
7. **CSS side effects** — all five published packages — `@domecs/core`,
   `@domecs/dom`, `@domecs/input`, `@domecs/inspector`, and `@domecs/persist`
   — ship no CSS and are marked `"sideEffects": false`, so bundlers can
   tree-shake unused exports without dropping required styles. Each also
   ships a `README.md` + `LICENSE` (advertised in `files`). Future packages
   that ship CSS must override this with a `sideEffects: ["**/*.css"]` array.
   **Resolved.**
8. **SSR/non-browser use** — `@domecs/core` is pure logic; `@domecs/dom` and
   `@domecs/input` only touch the DOM inside `mountDOM` / plugin `install`.
   Module-load is safe in node. **Resolved.**
9. **Testing** — the template defaults the Vitest `environment` to `node` and
   opts files into `happy-dom` via
   `environmentMatchGlobs: [['**/*.dom.test.ts', 'happy-dom']]`. Workspace
   examples use the same default and tag DOM specs explicitly.
   **Resolved (template).**
10. **Deployment docs** — README ships copy-paste recipes for generic static
    hosts, GitHub Pages (project + user sites), itch.io, and arbitrary
    subdirectory installs, plus `npm run preview` for local verification.
    **Resolved (template).**


## Bottom line

DOMECS should feel like a full app framework by offering a Vite-first scaffold, examples, and deployment documentation.
The engine itself should remain a small, portable ESM runtime that happens to work especially well in Vite apps.
