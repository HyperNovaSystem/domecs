# DOMECS Roadmap

_Post-v1.0 roadmap. Date: 2026-05-31._

This file covers the **larger directional items + tooling** beyond the v1.0
freeze. Deferred *engine* features (range/spatial indexes, async snapshot,
multi-world `EntityRef`, scene schema registry, redaction, capability typing,
`dispatch` alias, benchmark budgets, etc.) are tracked in
[`../FINDINGS.md` §3](../FINDINGS.md) and are not re-listed here — consult that
ledger for the engine-API deltas; this file is the home for the cross-cutting
directional work and the publishable tooling.

Items are grouped into rough effort tiers. Nothing here is committed scope; it
is the forward-looking design queue.

## Near-term (tooling / additive)

- **`create-domecs` scaffolder** — a separate publishable scaffolding package so
  `npm create domecs@latest my-game` / `pnpm create domecs my-game` works. The
  `domecs_template_vite` template is ready; only the publisher package is
  pending. Must emit a workspace variant (`--workspace <path>` with `file:` deps
  and no `DOMECS_LOCAL_DEV` alias branch), copy only tracked files
  (`git ls-files`, not the dir verbatim, so stale `dist/` isn't seeded), and
  strip `.git/` / `node_modules/`. (See also `../FINDINGS.md` §3.)
- **Browser-durable `Storage` adapter** — `@domecs/persist` ships only
  `createMemoryStorage`; every browser app hand-rolls a `localStorage`/IndexedDB
  adapter. Ship `createLocalStorageStorage(prefix?)` (+ async IndexedDB),
  ideally under a `@domecs/persist/web` entry to keep core DOM-free. (FINDINGS
  O-1.)
- **Input extensions** — beyond the v1.0 raw DOM snapshot: target-relative
  pointer coordinates, hit-tested enter/leave tracking, and high-level action
  mapping, with dedicated tests.

## Larger efforts (new packages / subsystems)

- **First-party framework adapters (Svelte / React)** — out of v1.0 scope
  (design YAGNI); a post-v1.0 directional item.
- **`@domecs/inspector` maturation + diff snapshots** — build out the inspector
  (the `InspectorView.export()` serializable snapshot shipped in v1.0) and add a
  diff-snapshot ring buffer for time-travel / inspector workflows, once the
  persistence and inspector-protocol foundations are stable.
- **Runtime `dev`/`diag` proxy diagnostics** — a mutation-without-`mark`
  warning surface for mark discipline and stale references. **Hard constraint:
  must never change `Changed(T)` / `OnChanged` semantics.** Do not re-add
  proxy-backed `WorldOptions.dev` / `world.diag` to the core contract without
  updating `SPEC.md` first.
- **`@domecs/sprites`** — a DOM renderer extension for sprite sheets and frame
  animation.
- **`@domecs/vite` plugin** — only for higher-level framework value:
  sprite/asset manifests, dev-inspector injection, HMR helpers, build-time
  metadata checks, and persist-migration validation. Not a thin wrapper —
  gated on real framework payoff.

## Long-term (architecture)

- **Networked rollback / Worker host** — `@domecs/worker` after persistence and
  structured-clone messaging contracts are stable. Needs a constrained
  serializable system-definition subset and a documented sim-vs-presentation
  split. Pairs with the async/chunked snapshot and canonical-hash work in
  `../FINDINGS.md` §3 (O-9, O-10, O-11).
- **The v0.2+ engine architecture queue** — range indexes, spatial layers,
  virtualized DOM views, keyed reconciliation, multi-world `EntityRef`, scene
  schema/codec registry, benchmark budgets. Tracked in `../FINDINGS.md` §3.

## Known documented limitations (no fix planned)

- **`defineComponent` dual-overload `Name` duplication** — a documented
  TypeScript limitation: the `const Name` overload infers a string-literal name
  when type args are not explicitly constrained. Both overloads are kept
  intentionally; the dual-overload trade-off is documented in the docstring.
  Not a defect to resolve.

## Open infra items

- **CI release validation** — _shipped in v1.0._ `pnpm test:release`
  (`scripts/validate-release.mjs` via `test/release-validation.test.mjs`)
  discovers org sibling apps, pins local consumers, and runs the packed-package
  smoke test in CI. Listed here only to mark it done.
