# API surface snapshot

These `*.d.ts` files are the **committed public-API contract** for each `@domecs/*` package, one per
package (`core`, `dom`, `input`, `inspector`, `persist`, `rules`, `scene`).

- **Generated, not hand-written.** Each is every `.d.ts` file in the package's freshly-built
  `dist/`, in path order under `// file:` headers, written by `scripts/api-surface.mjs` — so a
  changed signature shows up, not just a changed export list (O-73). Do not edit them by hand.
- **Regenerate after any public change:** `pnpm -r build && pnpm api:surface`, then commit the diff.
- **The diff IS the review.** A change here means the public surface changed — review it like an API
  change. CI fails (`pnpm api:check` / the no-drift gate) if the committed snapshot is stale.
- Why committed at all, when `dist/` is gitignored: `dist/` can't be the contract (it isn't tracked),
  yet agents and reviewers need a stable, diffable view of the public surface. This is it.
