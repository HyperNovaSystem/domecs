# DOMECS — Consolidated Plan (post-v1.0)

_Consolidated 2026-07-16 from: `plan/NOTES.md` (direction), `plan/FINDINGS.md`
(the O-ledger), `plan/BENCHMARK.md`, `doc/ROADMAP.md`, and three independent
external engine reviews (2026-07; synthesized here, originals removed after
capture)._

This file is the **governing plan**. `plan/FINDINGS.md` remains the
engineering ledger and `doc/ROADMAP.md` the itemized feature queue; where this
file and ROADMAP disagree on priority, this file wins.

---

## 1. Thesis

> **DOMECS is a deterministic, inspectable browser simulation runtime with DOM
> projections — built so humans and AI agents can operate the same live
> world.**

- The product is the **operable simulation**: deterministic scheduling,
  headless stepping, structured `action()`, snapshots/branching/replay,
  reflection (`world.describe()`), and retained projection of one model into
  many DOM views.
- **Games stay** — as the test bed, because games are an excellent general
  stress of a framework — but they are not the market.
- Value workloads: dashboards, ops/control-room tooling, digital twins,
  trainers, management sims — anywhere the evolving model *is* the product.
- Primary customer: the author's own applications. External adoption is a
  gated bonus (§7), not a goal to chase.
- The AI-age wedge is **agents operating DOMECS worlds** (observe / act /
  step / snapshot through the typed action boundary) — not "AI can write
  DOMECS code", which is table stakes and already served by incumbents.

### Why (review consensus)

Three independent external reviews converged on the same reading:

1. The architecture is genuinely good — deterministic kernel, Result-based
   error model, persistence/replay, inspector — but the *generic-framework*
   ambition is not worth pursuing: that lane is crowded (Koota; fine-grained
   reactivity + TanStack Virtual) and DOMECS has zero external adoption
   signal.
2. "High-performance" is currently unearned — behavioral tests prove
   correctness, not frame/tick budgets (ledger O-14). Claims must follow
   measurements.
3. Tokens should buy **evidence** (benchmarks, one flagship reference, the
   agent surface), not **completeness** (adapters, sprites, workers,
   scaffolding).
4. The O-ledger is **fuel, not a work queue** — engine changes happen when a
   real app or benchmark hits an item.

## 2. Operating principles

1. **Evidence before features.** No new subsystems until the benchmark suite
   exists and says something.
2. **The ledger is fuel, not a queue.** `plan/FINDINGS.md` items get built
   when real work collides with them, never for completeness.
3. **Prune the standard anchors.** No framework adapters, no sprite package,
   no elaborate mechanisms. CSS is the supported animation story.
4. **Dogfood.** The engine must make the author's real projects faster to
   build; revealed preference is the honest metric.
5. **Cooperate, don't rebuild.** Where the ecosystem already paid the tuition
   (virtual lists → TanStack Virtual), integrate via a small adapter or
   recipe instead of building our own (reframes O-5).
6. **Honest labeling.** "API-stable" with corrective 1.0.x releases — not
   "stable product" while first-hour traps remain open.

## 3. Workstreams

Ordered. WS-0 is immediate; WS-1–WS-3 can interleave; WS-4 is the capstone
bet. No date-driven milestones — the order is the only ordering.

### WS-0 — Positioning & repo hygiene (hours; do now)

- [x] README: replace "high-performance" with measured-claim language —
  *"performance-oriented, deterministic ECS runtime for DOM-heavy
  simulations; benchmark characterization in progress."*
- [x] Reframe v1.0 as **API-stable** (semver honored; product contract still
  hardening via 1.0.x).
- [x] Lead the pitch with operable simulation + agent operation; keep games as
  the demo section, not the headline.
- [x] GitHub Issues already enabled; published GitHub Release for `v1.0.0`
  (https://github.com/HyperNovaSystem/domecs/releases/tag/v1.0.0).

### WS-1 — Benchmark suite (O-14 + `plan/BENCHMARK.md`; the evidence buy)

Scaffold: `bench/` (`pnpm bench` / `node bench/run.mjs`) — soak, telemetry,
and snapshot workloads are runnable headless. Expand until numbers are
trustworthy enough for README claims; add Koota / reactive baselines.

Workloads (from the ledger's own budgets):

1. 20k headless entities at accelerated sim rates (soak + snapshot cycles).
2. Telemetry firehose: 500 updates/s across 400–10k monitored assets,
   coalesced into per-frame projection (fleet-shaped).
3. 50 visible table rows + map/schematic projection (windowed DOM).
4. Snapshot / restore / replay / determinism verification.

Metrics: p50/p95 tick and update time; DOM mounts/updates/removes per frame;
heap growth + GC pressure; snapshot duration + serialized size; dropped
frames.

Baselines: **Koota**; one fine-grained-reactive implementation (Solid or
hand-rolled signals + TanStack Virtual); a plain hand-written store+DOM app.

Success bar: DOMECS wins **one valuable workload decisively** — on runtime
behavior (≈≥30% better p95) or on implementation complexity (≈half the app
plumbing). It does not need to win everything.

Output: a public headless-by-default `bench/` in-repo, results table in the
README. Losing is also output: claims get corrected to match.

### WS-2 — Adoption-killer fixes (bounded engine tranche)

Only the first-hour traps; everything else stays demand-driven (§5).

| Item | Ledger | Type | Status |
|---|---|---|---|
| First paint under default `changedOn: auto` | O-2 | code (A-tier) | **done** |
| Pause semantics: document scale-0 gating; provenance-aware `pauseOnHidden` resume | O-3, O-32 | code + doc | **done** (O-3 `runWhilePaused` still fuel) |
| Browser-importable ESM dist for no-build consumers | O-33 | packaging | npm already ships `dist/`; import-map docs added; cold-install CI open |
| `loadIfPresent` + empty-slot non-retryable | O-28 | code | **done** |
| Document traps: spawn shallow-copy; keyDelta scope; stepOnce vs fixed | O-34, O-35, O-37 | docs | **done** |
| Cold-install test from an empty repo (published packages only) | — | infra | open |

### WS-3 — Agent operability surface (the wedge; thin facade only)

- `AGENTS.md` + an installable **DOMECS skill** (SKILL.md + the recipe
  patterns from the ledger §2).
- Compact machine-readable world manifest — package the shipped
  `world.describe()`; nothing new.
- Minimal agent bridge over existing APIs: `reset / observe / act / step /
  snapshot`. Deterministic episode tests.
- **Falsifiable legibility test (cheap; run early):** a cold agent session
  with only the published packages + skill must build a small working app.
  Pass ⇒ ship-the-knowledge is a real distribution channel. Fail ⇒ the
  legibility story needs repair before any marketing. Cost: ~one afternoon.

### WS-4 — One flagship operable-simulation reference (the bet)

One **product-grade** application — not a sixth exemplar. It must exercise
the distinctive stack *together*: determinism, typed actions, snapshot
branching, replay/fast-forward, multi-view DOM projection, agent-in-the-loop.

Reference shape (working title **Plantroom** — a simulated industrial
process cell):

- live PLC-style tags + alarms; several hundred active entities;
- trends + historian playback; deterministic fault-injection scenarios;
- human controls and an agent proposing typed control actions for approval;
- the demo moment: a fault develops → the agent proposes a control sequence →
  the user branches the snapshot → both strategies fast-forward → outcomes
  compared side by side → one branch committed.

Acceptable substitute: one of the author's real applications adopted as
daily-use dogfood — the revealed-preference test. Either way: one app,
product depth, agent in the loop.

## 4. Stop-doing list (frozen until a kill gate clears)

- `@domecs/sprites` — CSS animation is the supported story.
- React / Svelte adapters — already indefinitely deferred; keep it that way.
- Network rollback; generalized Worker host (O-10).
- `create-domecs` scaffolder and the `@domecs/vite` plugin.
- New demos that don't test a commercial or technical thesis.
- More architecture prose — documentation already outruns market validation.

ROADMAP items in these lanes are superseded by this list.

## 5. Demand-driven backlog (fuel)

`plan/FINDINGS.md` §2/§3 stays the ledger. Items are pulled **only** when
WS-1–WS-4 or a real application hits them. Expected early pulls:

- **O-1** — async IndexedDB `Storage` adapter (+ the `createPersistence`
  facade, SPEC §7.2–7.3): the first real-app persistence need.
- **O-5 / O-6** — as *recipes/adapters* (TanStack Virtual integration, keyed
  reconciliation helper): benchmark workload 3 will hit these.
- **O-9** — async/chunked snapshot: benchmark workload 1 will quantify it.
- **O-30** — eager component registration: agent/editor tooling (WS-3) hits
  it.

Everything else waits for a real collision.

## 6. Cadence

- Engine releases: demand-driven corrective 1.0.x from WS-2 and §5 pulls.
- Re-evaluate this plan when WS-1 results land or WS-4 ships — whichever
  comes first.

## 7. Kill gates

Continue **public framework** investment only if at least **two of three**
clear:

1. **Objective win** — WS-1 shows a decisive advantage in ≥1 flagship
   workload (≈30% p95, or ≈half the plumbing).
2. **Independent adoption** — someone outside the org ships something
   nontrivial on the published packages without cloning engine source.
3. **Unique reference case** — WS-4 is materially cleaner than the
   equivalent build without DOMECS, because of determinism + actions +
   snapshots + projection *together*.

If the gates don't clear: freeze DOMECS as the author's personal application
substrate — packages stay published, the engine stays in use, ecosystem
ambitions end. That is a planned-for, acceptable outcome — not a failure
mode.

## 8. Document map

- **`plan/PLAN.md`** (this file) — governing direction and priorities.
- **`plan/FINDINGS.md`** — engineering ledger (shipped / open O-items /
  deferred); moved from the repo root 2026-07-16.
- **`doc/ROADMAP.md`** — itemized feature queue; subordinate to this plan.
- `plan/NOTES.md`, `plan/BENCHMARK.md` — raw inputs; deliberately untracked
  (public repo), superseded by this file. The three external review notes
  were removed 2026-07-16 after their content was captured here.
