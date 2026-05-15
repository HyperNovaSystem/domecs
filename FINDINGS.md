# DOMECS — Consolidated Findings Ledger

This file is the canonical cross-package tracker for code-review findings and exemplar follow-ups.
Detailed writeups remain in `doc/FINDINGS_*.md`; this ledger consolidates status, ownership, and next actions.

_Last updated: 2026-05-14._

## Sources consolidated here

- Core engine + renderer + input review: `doc/FINDINGS_DOMECS.md`
- Exemplar follow-ups:
  - `doc/FINDINGS_HARBOR.md`
  - `doc/FINDINGS_FLEET.md`
  - `doc/FINDINGS_LIGHTHOUSE.md`
  - `doc/FINDINGS_LIGHTHOUSE_NOVEL.md`
  - `doc/FINDINGS_HALLS.md`
  - `doc/FINDINGS_STUDIO.md`
  - `doc/FINDINGS_TESSERA.md`
  - `doc/FINDINGS_WE.md`
  - `doc/FINDINGS_DOMECS_TEMPLATE_VITE.md`

## Status legend

- **Resolved**: landed with tests.
- **Active**: accepted issue, not fully addressed.
- **Planned**: queued for a future milestone.

## Consolidated status

### Core runtime & renderer (from `doc/FINDINGS_DOMECS.md`)

| ID | Finding | Status | Notes |
|---|---|---|---|
| P-1 | `EntityView` construction scanned all stores | **Resolved** | View build now iterates the entity archetype types only; regression tests added. |
| P-2 | `query.entities` allocation churn | **Resolved** | EntityView caching added with invalidation on archetype/despawn/restore transitions. |
| P-3 | DOM default update path redrew all entities every tick | **Resolved** | `changedOn` auto-derivation from `Has(T)` query leaves; explicit `[]` retains legacy always-update mode. |
| P-4 | Pending destroy data shape stores unused payload | **Active** | Low-risk cleanup candidate (`Set<Entity>` instead of `Map<Entity, EntityView>`). |
| P-5 | Query membership scan on every move/add/remove | **Active** | Needs archetype↔query membership index or batched structural moves. |
| P-6 | `archetypeKeyFor` sort/join on hot mutation path | **Active** | Requires key caching/delta-key strategy. |
| P-7 | Type-set cloning during composition edits | **Active** | Requires mutation-path optimization; preserve immutability guarantees. |

### Cross-exemplar themes (from `doc/FINDINGS_*.md`)

| Theme | Status | Seen in |
|---|---|---|
| Packed-tarball release validation for scoped packages | **Resolved (policy)** | Harbor, Fleet, other app findings |
| Range/index strategy for large `Where(...)` workloads | **Planned** | Fleet, Harbor |
| Feed/backpressure observability and policy | **Planned** | Fleet, Harbor |
| View/window virtualization without archetype churn | **Planned** | Fleet, Harbor, Lighthouse-family |
| One-shot selection/query helpers (`count/select/iterate`) | **Planned** | Fleet, Studio |
| Snapshot ergonomics: async/chunked saves + preference split | **Planned** | Harbor, Fleet, Studio |
| Worker-hosting constraints and serializable system boundaries | **Planned** | Harbor, Lighthouse-family |
| Benchmark harnesses tied to exemplar budgets | **Active** | Harbor, Fleet, Halls/Studio family |

## Priority queue (updated)

### v0.1 stabilization

1. **Close active core hot-path items (P-4..P-7)** with focused microbench + regression tests.
2. **Codify release validation** with packed tarballs in CI (policy is adopted; enforce automatically).
3. **Add diagnostics** for query count growth, event pressure, and renderer mount/update/destroy counters.

### v0.2 design track

1. Secondary index guidance/plugin APIs (`indexBy`, optional range indexes).
2. One-shot query/select APIs to avoid live-query leaks in projection code.
3. Async snapshot and worker-host readiness constraints.
4. Virtualized renderer primitives (row/window/panel helpers).

## Process update

Going forward, new findings should be recorded in the domain-specific file under `doc/` and then reflected here as a status row update, so this file stays the single “what is open vs resolved” checkpoint.
