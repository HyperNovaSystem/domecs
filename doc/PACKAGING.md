# DOMECS Packaging and Vite Interop

Review date: 2026-05-10.

DOMECS is intended to be a full browser app framework for rich DOM-first apps
and games. Vite should be the blessed development, build, and deployment path
for DOMECS applications, while the runtime packages remain normal ESM libraries
with no bundler lock-in.

## Decision

Use Vite as the official app scaffold and deployment story, but do not make Vite
a runtime dependency of the core framework packages.

Recommended split:

```txt
domecs / domecs-dom / domecs-input  = runtime libraries, bundler-agnostic
example/*                           = Vite applications
create-domecs template(s)           = Vite by default
@domecs/vite                        = optional advanced Vite plugin
```

This keeps DOMECS pleasant for app authors without preventing use from other
bundlers, embedded pages, React/Svelte shells, or plain browser module graphs.

## Current repository state

The examples already validate the intended direction:

- `example/restaurant` uses `vite`, `vite build`, and `vite preview`.
- `example/dashboard` uses the same pattern.
- `example/roguelike` also has Vite configuration.
- examples depend on local workspace packages via `workspace:*`.

That is the right app shape. The framework packages themselves currently expose
TypeScript source directly, e.g. `"exports": { ".": "./src/index.ts" }`,
which works well inside the workspace and with Vite, but is not the final shape
for published npm packages.

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
    "domecs": "^0.1.0",
    "domecs-dom": "^0.1.0",
    "domecs-input": "^0.1.0"
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
For npm publication, move from source-only exports to `dist` exports:

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
  "files": ["dist", "README.md", "LICENSE"]
}
```

Open decision: choose the library build tool. Plain `tsc` is enough if the
packages only need ESM output and declarations. `tsup` or Rollup may be useful
later if packages need bundled subpath artifacts, minified browser builds, or
more elaborate export maps.

## Official template

DOMECS should ship an official Vite-powered app template, eventually exposed as
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

- vanilla DOM mounting with `domecs-dom`;
- a minimal tick loop / fixed-step example;
- CSS import and asset usage through Vite;
- `dev`, `build`, `preview`, `typecheck`, and `test` scripts;
- a short deployment note for static hosts;
- optional variants later for React/Svelte shells or PWA/offline play.

## Optional `@domecs/vite` plugin

A Vite plugin should be optional and added only when it provides framework-level
value beyond normal Vite usage. Candidate features:

- sprite atlas or asset manifest generation for `@domecs/sprites`;
- automatic dev inspector injection in development builds;
- hot-reload helpers for views, systems, and data tables;
- validation of component/view metadata at build time;
- save-schema and migration checks for `@domecs/persist`;
- conventions for game assets, generated imports, and cache-busted manifests;
- build-time warnings for browser-incompatible imports in app code.

The plugin must not be required to run DOMECS. Plain Vite apps should continue
to work with normal package imports.

## Vite interop requirements

Track the following before calling Vite support first-class:

1. **Package exports** — publish runtime packages as ESM JavaScript plus
   declaration files, not only TypeScript source.
2. **Workspace behavior** — keep examples resolving workspace packages cleanly
   under pnpm. Current `resolve.preserveSymlinks: false` is appropriate.
3. **Dependency de-duplication** — document or encode any Vite `resolve.dedupe`
   needs if multiple copies of `domecs` can break component identity.
4. **Browser boundaries** — ensure DOM packages do not leak Node-only imports,
   and core packages do not require browser globals.
5. **Static assets** — define a convention for CSS sprites, image/audio assets,
   and generated manifests.
6. **Base paths** — document Vite `base` for subdirectory deployment such as
   GitHub Pages or itch.io.
7. **CSS side effects** — decide whether first-party packages ship CSS and, if
   so, mark package metadata so bundlers do not tree-shake required styles.
8. **SSR/non-browser use** — keep core importable in Node and tests; keep DOM
   APIs lazy enough that importing `domecs-dom` does not immediately require a
   live document.
9. **Testing** — keep Vitest as the default test runner for templates and
   examples, with `happy-dom` only where DOM APIs are required.
10. **Deployment docs** — add copy-paste recipes for Vite static output on the
    supported hosts.

## Bottom line

DOMECS should feel like a full app framework by offering a Vite-first scaffold,
examples, and deployment documentation. The engine itself should remain a small,
portable ESM runtime that happens to work especially well in Vite apps.
