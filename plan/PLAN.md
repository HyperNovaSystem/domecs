# DOMECS — Consolidated Plan (post-v1.0)

_Consolidated 2026-07-16 from: `plan/NOTES.md` (direction; local, untracked),
`plan/FINDINGS.md` (the O-ledger), `plan/BENCHMARK.md` (local, untracked),
`doc/ROADMAP.md`, and three independent external engine reviews (2026-07;
synthesized here, originals removed after capture)._

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
  gated bonus (§7), not a goal to chase. **DOMECS Studio** (`../studio`) is
  both the author's tool for building those applications and the reference
  application (WS-5, §7 gate 3).
- The AI-age wedge is **agents operating DOMECS worlds** (observe / act /
  step / snapshot through the typed action boundary). The same operating
  surface is also the **coding agent's verification loop**: an agent that
  writes DOMECS code checks its work by stepping, snapshotting and replaying
  the world, not by reading it. "AI can write DOMECS code" on its own stays
  table stakes. (Widened 2026-10-20, WS-5.)

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
6. **Honest labeling.** "API-stable" with corrective 2.x releases — not
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

### WS-1 — Benchmark suite (O-14; the evidence buy)

- [x] Headless suite: soak, telemetry, snapshot, windowed projection, plain
  baseline (`pnpm bench` / `pnpm bench:write`).
- [x] Sample results table in `bench/README.md` (machine-local; not a product claim).
- [x] Koota + hand-rolled signals baselines (`bench/baselines/*`, `--workload compare`).
- [x] First compare documented in `bench/COMPARISON.md` + `bench/README.md`.
  Windowed vs Koota looked promising in one run, but did not reproduce
  across repeated runs (O-72: 0.85–2.69× over 15 runs; 1.35–3.73× over 5
  trials on 2026-10-14); soak does not win. No runtime win is claimed; the
  compare phase now reports medians and per-trial ranges.
- [x] Methodology hardening (2026-07-17): warmup discard, GC isolation under
  `--expose-gc`, compare verdict scoped to same-N rows, cross-engine
  `domUpdates` work-equivalence check, real coalescing pressure in the
  telemetry workload.
- [ ] Multi-machine stability pass (re-run compare on second host / CI).
- [x] Memory metrics: allocation per tick and GC count/time for every
  measured loop, the DOM mount/update/remove split, and Long Animation
  Frame counts in the browser bench (O-76, 2026-10-20).
- [x] README product claims stay gated — no unearned win language.

Workloads:

1. Entity soak (fixed systems).
2. Telemetry firehose (coalesced marks).
3. Windowed projection (50-row window over large set).
4. Snapshot / restore / determinism.
5. Plain Float64Array baseline (overhead narrative).

Metrics: p50/p95 tick and update time (shipped); snapshot duration +
serialized size (shipped); coalescing ratio (shipped). Still open (tracked
above): per-frame DOM mount/update/remove split, heap growth + GC pressure,
dropped frames.

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
| Cold-install test from an empty repo (published packages only) | — | infra | **scripted** (`pnpm cold-install`; opt-in `RUN_COLD_INSTALL=1`) |

### WS-3 — Agent operability surface (the wedge; thin facade only)

- [x] `AGENTS.md` + installable **DOMECS skill** (`skills/domecs/SKILL.md` +
  recipe patterns from the ledger §2).
- [x] Compact machine-readable world manifest — package the shipped
  `world.describe()` via `bridge.observe()`; nothing new.
- [x] Minimal agent bridge: `createAgentBridge` → `reset / observe / act /
  step / snapshot`. Deterministic episode tests in
  `packages/domecs/test/agent-bridge.test.ts`.
- [x] **Falsifiable legibility test:** `example/agent-legibility/run.mjs` +
  `pnpm test:legibility` — skill-shaped observe/act/step/snapshot/reset
  episode against built dist (score=7, deterministic). Full *human-out-of-loop*
  cold agent session still a marketing-time check.

### WS-4 — One flagship operable-simulation reference (the bet) — **done**

In-repo flagship: **`example/plantroom/`** (`@domecs/example-plantroom`).

- [x] PLC-style tags + alarms + vessel/pump dynamics (fixed schedule)
- [x] Typed actions: inject fault, set pump, ack/reset trip
- [x] Snapshot branch + fast-forward compare (naive restart vs reset+start)
- [x] Agent bridge session (`createPlantSession`)
- [x] Deterministic episode tests (`pnpm test:plantroom` — branch, approval,
  historian restore, scale, determinism)
- [x] Browser multi-view chrome (tags / alarms / plant + historian canvas)
  — `pnpm plantroom:dev`
- [x] Historian: sample ring + external snapshot checkpoints; scrub UI +
  restore-to-checkpoint
- [x] Operator approval UX: agent proposals queue; Approve/Reject before acts
- [x] Scale: ~200 field sensors + critical tags (~207 entities)
- [x] **Dogfood decision:** keep in monorepo as flagship reference; promote to
  standalone app repo only if daily product use outgrows the workspace

Demo moment (headless + UI): fault → agent proposal → operator approve/reject
**or** branch-compare naive vs reset+start → historian scrub/restore.

### WS-5 — Engine performance and agent DX (adopted 2026-10-20)

From the 2026-10-20 performance/DX proposal (local
`plan/PROPOSAL-perf-dx.md`, with its evidence in
`plan/proposal-perf-dx-evidence/`; reviewed by Codex, Reqall #9178/#9179).
Two findings drive it. First, `pnpm bench` measured a stale `dist`. Second,
the soak compare was uneven: DOMECS tracked every change, while Koota's
harness tracked none. Profiling a fresh build put ~70% of soak time in
constant overheads (change marking, component lookup, per-query arrays), and
a throwaway prototype cut soak step time 35–40%.

Decisions (2026-10-20):

- **Bench:** always a fresh build of the latest source. One headline
  comparison does the same work on both engines (each with a change reader).
  The verdict is the median ratio with a bootstrap confidence interval,
  replacing the worst paired ratio.
- **Components stay mutable plain objects** (SPEC §2.2), as the single
  storage model. No opt-in columnar or strict-marks modes; performance comes
  from removing overhead. History sharing compares before it shares, with
  no new mutation contract.
- **Mark only what is read** goes ahead. The spec work comes first:
  disabled, sub-rate and event readers; snapshot carry-over; restore.
- **Studio is the reference app and the product.** Agent tooling lands
  where Studio needs it. The MCP transport stays in Studio until a second
  consumer appears.
- **Evals run on demand**, with each improvement run. There are no nightly
  runs.
- **The API-surface gate keeps every emitted `.d.ts`.** Internal
  declarations still reach the public surface (for example
  `ChangesSnapshot`), and nothing else checks them.

Phase 1 (committed):

- [x] Honest bench: build first, the like-for-like soak, projection measured
  in a real browser, allocation/heap metrics, and the frozen verdict
  protocol (O-76). Baseline: soak 1.10× Koota, windowed 1.43×, browser
  frame 1.13×. Multi-machine runs are still open.
- [ ] Port the prototype's overhead cuts to `src`. Query caching is for
  structural queries only.
- [ ] First-hour traps:
  - [x] `action()` rejects non-event tokens, and the docs stop pairing every
    `act()` with `step()` (O-75, PR #20);
  - [x] Studio Save keeps live edits (Studio FINDINGS 2026-10-20, studio
    PR #3);
  - [ ] `reset()` scale/input, O-30, and explicit bans on nondeterministic
    APIs.
- [ ] Full canonical world hash (closes O-11).
- [ ] Episode record/replay, as the oracle for agents.
- [ ] Spec for mark-only-what-is-read.
- [ ] An eval baseline, run on demand.

After Phase 1, each item starts only when a named consumer (usually Studio)
needs it *and* the bench or an eval shows the benefit. Candidates: preorder
scene layout, history sharing, `domecs check`, docs inside the npm package,
and the Studio cockpit (fork → diff → replay under approval).

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
- **O-11** — canonical world hash, and **O-14** memory metrics: WS-5 Phase 1.

Everything else waits for a real collision.

**Pulled by DOMECS Studio (record, 2026-10-14).** Studio — the in-house
editor — pulled three engine surfaces that this plan did not schedule:

- **`@domecs/scene`** — `Parent` hierarchy, `despawnTree`, transform
  composition (M4). Published in 2.0.0.
- **`@domecs/rules`** — a safe expression language and data-defined rules
  installed as systems (M6). Published in 2.0.0.
- **Persist component-schema I/O** — `serializeComponentType` /
  `registerComponentTypes` in `@domecs/persist`, for user-authored component
  types in documents.

They follow the same rules as everything else here: hardened by the
2026-10-13 review (FINDINGS O-61–O-69), published with the 2.0.0 engine
release (O-70), and grown only when a real application needs more.

## 6. Cadence

- Engine releases: demand-driven corrective 2.x from WS-2 and §5 pulls.
- Re-evaluate this plan when WS-1 results land or WS-4 ships — whichever
  comes first.

## 7. Kill gates

Continue **public framework** investment only if at least **two of three**
clear:

1. **Objective win** — WS-1 shows a decisive advantage in ≥1 flagship
   workload (≈30% p95, or ≈half the plumbing).
2. **Independent adoption** — someone outside the org ships something
   nontrivial on the published packages without cloning engine source.
3. **Unique reference case** — WS-4, and since 2026-10-20 Studio (WS-5), is
   materially cleaner than the equivalent build without DOMECS, because of
   determinism + actions + snapshots + projection *together*.

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
