# Review of the 2026-07-16 tranche (Claude)

_Reviewed 2026-07-17. Scope: the 8 commits `06ca1b9..b38f5e7` — plan
consolidation, WS-0 positioning, WS-1 benchmark suite, WS-2 adoption fixes
(O-2 / O-28 / O-32 + trap docs), WS-3 agent bridge + skill, WS-4 Plantroom
flagship, Pages deploy._

This file is **review feedback**, separate from the engineering ledger
(`plan/FINDINGS.md`). Items worth tracking should be promoted into the
O-ledger; the rest can be closed with this file.

**Method.** Eight parallel review passes (core/agent bridge, persist, dom,
plantroom sim, plantroom UI, bench, infra, docs/plan coherence) with
adversarial cross-verification, plus direct runtime reproduction against the
built dist for the highest-severity claims. Verification labels below:

- **repro** — reproduced at runtime during this review (probe output in hand)
- **code** — confirmed by direct code reading / arithmetic
- **reported** — reviewer claim, plausible mechanism, not independently re-run

**Gate status on this machine (2026-07-17):** full test suite, typecheck
(all 5 packages), build, `api:check`, `doctest:check`, `test:legibility`,
and `test:plantroom` all pass. The findings below are about what the green
gates don't cover.

---

## Fix status (2026-07-17, same PR)

Fixes were applied on this branch after the review. Per-item disposition:

- **Fixed** — R-1, R-2, R-3, R-4, R-5, R-6, R-9, R-10, R-11, R-12, R-13,
  R-14, R-15, R-16, R-17, R-19, R-20, R-24, R-25, R-26, R-27, R-28, R-29,
  R-30, R-31, R-32, and **R-34** (pending events leaked across
  `world.restore()` — the review finding this file initially mis-refuted;
  see the re-check section below; `restore()` now clears pending events,
  SPEC §7.1 updated, regression test added). All notes except the two below
  were also addressed (proposal ids, approve atomicity, HI-TEMP alarm,
  manifest field cloning, publish filter, cold-install stage message,
  pages.yml pattern, README `reactive` bullet, AGENTS.md caveats, PLAN
  citations, persist README gaps).
- **Partially fixed** — R-18 (GC between workloads under `--expose-gc` +
  documented; child-process-per-engine isolation deferred), R-21 (`stop()`
  now relinquishes an owned pause; the hidden-tab ownership-epoch limit is
  documented on `StartOptions.pauseOnHidden` rather than re-engineered).
- **Fixed (second pass, 2026-07-17)** — R-7 (→ O-38 closed:
  `WorldSnapshot.nextId` + restore honoring it, regression test, SPEC
  §7.1) and R-8 (→ O-39 closed: `action()` validates payloads against a
  declared event schema — no emit, no tick on rejection; Plantroom command
  events now declare schemas as the dogfood example; the `CommandResult`
  resolver remains the domain-adjudication layer on top).
- **Documented only** — R-22 and R-23 (bridge `reset()`/`step(0)`
  semantics documented at the bridge, api.md, and AGENTS.md).
- **Left for the maintainer** — R-33: editing the v1.0.0 GitHub Release is
  policy-blocked for this session type (the API returns 403 "Creating,
  editing, or deleting releases is not permitted" regardless of scopes).
  The corrected body is committed at `doc/release-notes/v1.0.0.md`; run
  `gh release edit v1.0.0 --notes-file doc/release-notes/v1.0.0.md`.

**Verdict.** This is a strong, honest tranche: the plan is coherent, the
WS-2 fixes are real and well-documented, the agent surface is genuinely thin,
and the bench writeups resist the temptation to claim unearned wins. The two
clusters that need attention before this tranche's artifacts are load-bearing:
(1) the Plantroom checkpoint/timeline machinery undermines the exact
trust story the flagship exists to demonstrate, and (2) the benchmark
harness has methodology gaps (warmup, row selection, GC isolation) that make
its `compare-summary` verdict — the input to kill gate 1 — unreliable as-is.

---

## High

### R-1 · Plantroom checkpoint ring restores abandoned timelines — `repro`
`example/plantroom/src/session.mjs:49` · `example/plantroom/src/browser/main.js:142`

Checkpoints are keyed by `world.time.tick` and deduped with
`checkpoints.some(c => c.tick === tick)`, but `world.restore()` rewinds the
tick, so tick numbers are not unique across timelines. After any branch
compare or checkpoint restore, re-visited ticks keep the **old** timeline's
snapshots and silently drop the new one.

Reproduced end-to-end: fault at tick 30 → `compareBranches(40, naive, smart)`
→ world left on branch B (trip cleared, temp 26.0) → `restoreHistorianCheckpoint(60)`
restores **branch A** state (pump still tripped, temp 56.4) and reports
success. The browser shell has the identical pattern, so "Restore checkpoint
@ scrub" after "Branch compare" lands the operator on a timeline that never
happened — in the flagship whose demo moment is precisely branch + scrub +
restore.

**Fix:** suspend checkpointing during speculative rollouts, and on every
`world.restore()` truncate checkpoints with `tick >= restored tick` (and
replace rather than skip on tick collision). Add an episode test:
branch-compare, then assert `restoreHistorianCheckpoint(post-branch tick)`
reproduces the branch the world was left on. Applies to both `session.mjs`
and `main.js` (see also R-24 — the two hand-copied rings have already
diverged).

### R-2 · Bench `compare-summary` mixes entity counts in `all` mode — `code`
`bench/run.mjs:88` · `bench/run.mjs:339`

In the default `--workload all`, `runSoak` first runs at the **unclamped**
`--entities` value, then the compare block runs a second soak clamped to
`compareN = min(entities, 5000)`. `summarizeComparison` picks rows via
`all.find(r => r.workload === 'soak')` — the *first* row. For any
`--entities > 5000` (the file's own usage header suggests
`--entities 20000`) the verdict divides DOMECS p95 at N entities by Koota
p95 at 5,000 — a fabricated ratio feeding `decisiveRuntimeWins`, the
machine-readable input to kill gate 1. `all` mode also emits duplicate
`soak`/`windowed` rows into `results.json`, so any consumer keying on
workload name is ambiguous.

**Fix:** collect compare-block rows into a local array and summarize only
those (or give compare rows distinct names); skip the duplicate standalone
runs when compare also runs.

### R-3 · No warmup discard — p95 and the decisive-win detector measure JIT cold-start — `repro` (reviewer)
`bench/run.mjs:150`

Every workload times ticks from the first iteration. With 100 samples,
p95 = `sorted[94]`, i.e. the top-5 samples — which *are* the JIT/IC warmup
ticks — sit at/above p95. Measured on this host: koota-windowed p95 drops
0.349 → 0.193 → 0.065 ms across three back-to-back in-process runs (5.4×
cold-vs-warm); DOMECS windowed 0.161 → 0.059 ms (2.7×). Because the cold
penalty is engine-specific, the ≤0.70 ratio threshold can flip in either
direction on noise the suite itself injects. The multi-machine stability
pass (WS-1's open box) will inherit this unless fixed first.

**Fix:** discard a fixed warmup prefix per workload (30–50 unmeasured
ticks), enforce a minimum sample count (≥200), repeat each configuration
k times and report median-of-runs. Re-derive the "windowed looks promising"
narrative from warmed numbers.

---

## Medium

### R-4 · O-2 first-paint `update()` double-fires for created-and-marked entities — `repro` (reviewer)
`packages/domecs-dom/src/mount.ts:206`

`commit()` now calls `update()` inline at create (first paint) and then
again in the change-gated phase for the same entity: the changed-set loop
excludes `readded` ids but not just-created ids. The exact pre-O-2
workaround pattern — `spawn(); addComponent(...); markChanged(...); step` —
now yields `updateCalls === 2` in one commit (verified against dist;
control without markChanged is 1). Non-idempotent `update` callbacks
(counters, appends, transitions) regress.

**Fix:** don't call `update()` inline in the create loop; collect created
ids into a set and merge with `readded` in the update phase — one loop,
exactly one `update()` per entity per commit. This also fixes R-5.

### R-5 · First paint passes a stale onAdd-time view — later same-window components invisible, never heals — `repro` (reviewer)
`packages/domecs-dom/src/mount.ts:206`

The first-paint `update()` receives the `view` captured when the query
first matched, not a fresh view at commit time. Components added later in
the same window are absent from it: a `Has(Sprite)` view whose `update`
reads `e.Meta?.label` renders the missing-case on first paint after
`world.spawn([entry(Sprite,…), entry(Meta,…)])` — and for a static entity
no later Changed mark ever heals it.

**Fix:** drive first paint from the update phase using fresh
`state.query.entities` views (same mechanism as the O-16 `readded` set) —
one change fixes R-4 and R-5 together. Add a spawn-bag regression test that
reads a second component in `update()`.

### R-6 · SPEC §5.3 normative gating rule not updated for the O-2 exception — `code`
`doc/SPEC.md` §5.3 · `doc/api.md` ViewDef/changedOn block · `packages/domecs-dom/README.md`

The shipped behavior (update fires once at node creation under
`auto`/`explicit`) contradicts SPEC §5.3's normative "update fires only on
redraw-trigger Changed marks" and its mount carve-out (create/destroy
only). `view.ts` JSDoc is correct; the three authoritative doc surfaces
were not updated. For a repo whose SPEC is pitched as the runtime contract,
a normative section that fails against the shipped tests is a legibility
bug.

**Fix:** mirror the view.ts wording into SPEC §5.3, api.md, and the dom
README.

### R-7 · Snapshots don't carry `nextId` — entity ids diverge between live and post-reset episodes — `repro`
`packages/domecs/src/agent.ts:77` · `packages/domecs/src/world-state.ts` (applySnapshot)

`applySnapshot` derives the id cursor as `maxAliveId + 1`. If setup
despawned the highest-id entity before `captureBaseline()` (scratch
entities in setup are common), episode 1 — run directly on live state per
the AGENTS.md canonical flow — assigns different entity ids than every
post-reset episode. Reproduced: live spawn → id 2; after `reset()` the same
spawn → id 1. Snapshot comparisons across episodes are silently
incomparable.

**Fix:** persist the id cursor in the snapshot envelope (meta field), or
make "call `bridge.reset()` before the first episode" normative in
AGENTS.md/the bridge JSDoc (the agent.ts docstring example already happens
to do this; AGENTS.md's minimal-episode does not).

### R-8 · `bridge.act()` / `world.action()` accepts malformed payloads as `accepted: true` — `code`
`packages/domecs/src/agent.ts:100` · `packages/domecs/src/events.ts` (schema is reflection-only)

`defineEvent`'s `schema` is never enforced. With the default resolver, a
typo'd payload (`{ byy: 3 }`) returns `{ accepted: true, consumedTurn: true }`
— the turn is spent, nothing happened, no signal reaches the agent — and
`c.n += e.by` with `undefined` NaN-poisons component state and every later
snapshot comparison. For an LLM-facing "typed command boundary" (the WS-3
wedge), silent acceptance of malformed commands is the exact failure class
the boundary exists to prevent.

**Fix:** when a schema exists, validate the payload in `action()` and
surface failure as `{ accepted: false, reason }` (consistent with the
ActionResult data model); otherwise document loudly in AGENTS.md/SKILL.md
that `act()` is unvalidated and resolvers must adjudicate.

### R-9 · Plant has no steady state — the healthy plant self-trips its own alarm — `repro` (reviewer)
`example/plantroom/src/buildPlant.js:142`

Nominal operation gains 1.2 level/tick (inflow 2.0 vs outflow 0.8
effective) with no level controller — despite the tag being named LIC-101
("Level Indicating **Controller**"). An untouched run hits HI-LEVEL at
~tick 25 and clamps at level 100 by ~tick 42 with the alarm permanently
active. Worse for the demo narrative: the "competent" recovery branch ends
at level 100 **in alarm**, while the naive tripped branch drains to ~23
with no level alarm — an operator reading alarms concludes the naive branch
looks healthier. The branch-compare test only asserts `temp`, so this
ships.

**Fix:** balance nominal mass flow (or add the level loop the tag name
promises) so healthy operation holds ~50%; then assert
`alarmHiLevel === false` on the competent branch in the episode test.

### R-10 · `compareBranches` applies unapproved actions to the live world and leaves it on branch B — `code`
`example/plantroom/src/session.mjs:127`

The compare executes strategies via `bridge.act` — bypassing the approval
queue the same flagship exists to demonstrate — and returns without
restoring `base`: the live world is left in branch B's terminal state,
40+ ticks ahead (confirmed: preTick 7 → postTick 49). It also runs
`maybeCheckpoint()` during both rollouts, feeding R-1. The browser copy at
least prints "world left on branch B"; the session API says nothing.

**Fix:** restore `base` at the end so `compareBranches` is a pure
evaluator (caller applies the winner through the approval flow), or
document the leave-on-B semantics and pin them with a test. Suspend
checkpointing during rollouts either way.

### R-11 · Browser branch compare while paused compares nothing — `repro` (reviewer)
`example/plantroom/src/browser/main.js:393`

`dispatch('branch')` never resumes the world. If the user pressed Pause
(button or Space — both in the README manual path), `time.scale === 0`, so
all 80+ `world.step(fixedStep)` calls fire **zero** fixed steps
(scale-0 gating, per O-3/O-19); both outcomes read identical state and the
panel prints "? Unexpected: B not cooler". The scrub path is guarded
(`returnToLive`), the plain-Pause path is not.

**Fix:** capture paused state at the top of the handler, `world.resume()`
for the compare, re-pause after.

### R-12 · Tags/Alarms/Plant panels show stale pre-restore state after "Restore checkpoint @ scrub" — `code`
`example/plantroom/src/browser/main.js:452`

`mountDOM` commits only inside a tick, and the restore-cp handler restores
the snapshot, keeps the world paused, and never ticks. The status line and
canvas (redrawn imperatively) show the restored state while the three
mounted DOM panels — the multi-view showcase — keep displaying pre-restore
values until the user presses Run. The boot path already knows the idiom:
`world.step(0)` heartbeat.

**Fix:** call `world.step(0)` after `world.restore()` in the `restore-cp`
and `reset` handlers.

### R-13 · Checkpoint coverage is frame-rate-dependent and covers ~45% of the scrubber — `code`
`example/plantroom/src/browser/main.js:37`

Checkpoints are keyed to render ticks (every 20 ticks ≈ 0.33 s at 60 Hz,
capacity 40 → ~13 s of coverage) while historian samples are keyed to fixed
steps (0.1 s sim time, capacity 300 → ~30 s). In steady state the older
~55% of the scrubber has no checkpoint at-or-before it ("no checkpoint ≤
scrub tick") — ~78% on a 120 Hz display, since tick cadence scales with
refresh rate.

**Fix:** key checkpoint cadence to fixed steps / sim time and size the ring
so checkpoint coverage ≥ historian window.

### R-14 · Plantroom determinism test is inert — `code`
`example/plantroom/test/episode.test.mjs:96`

The test compares `JSON.stringify(readOutcome())` — six scalars from
vessel/pump/alarms. The 200-sensor fleet (the scale showcase), tags, and
historian are never compared, and the plant consumes **no** seeded
randomness at all (drift is index arithmetic), so the seeds the test varies
are inert and the test cannot fail for the regression class it names. A
`Math.random()` slipped into the sensor loop would pass.

**Fix:** deep-compare `world.snapshot()` between the two runs — one line,
covers sensors, tags, historian, and RNG state.

### R-15 · `doc/error-handling.md` retry example re-introduces the O-28 anti-pattern — `code` (verifier-confirmed ×2)
`doc/error-handling.md:63` · `packages/domecs/src/errors.ts:30`

The canonical documented retry pattern hard-codes
`case 'persist_io': return true`. After O-28, empty-slot `load()` is
`retryable: false`, so a caller (or agent) copying the project's own guide
retries a deterministic first-run failure forever — exactly what O-28 says
it eliminated. The `DomecsError` union's doc comment makes the same flat
"persist_io: true" claim, and `getErrorRepairHint` for `persist_io` points
at backend reachability, which is wrong for the empty-slot case.

**Fix:** `case 'persist_io': return e.retryable` in the example + one
sentence pointing boot paths at `loadIfPresent`; reword the errors.ts
rationale bullet; branch the repair hint on `retryable`.

### R-16 · `loadIfPresent` error leg untested — `code`
`packages/domecs-persist/test/save-load.test.ts`

Tests cover `ok(false)` (missing) and `ok(true)` (round-trip) but not the
third leg: a real storage failure must surface as `err(...)`, not
`ok(false)`. A future simplification conflating read-error with missing
would pass the whole suite; the consequence shape is data loss (flaky
localStorage read → app "boots fresh" and overwrites the save).

**Fix:** stub Storage whose `read()` errs; assert `loadIfPresent`
propagates the err.

### R-17 · WS-3 legibility gate (and all root-level tests) never run in CI — `code`
`.github/workflows/ci.yml`

`pnpm -r --parallel test` excludes the workspace root, and CI has explicit
steps only for `test:release` / `api:check` / `doctest:check` — so
`test/agent-legibility.test.mjs` (the WS-3 "falsifiable legibility gate")
and `test/cold-install.test.mjs` run nowhere in CI. A change that breaks
`createAgentBridge` or the skill-shaped episode keeps CI green while
PLAN/README advertise the gate.

**Fix:** add a `pnpm test:legibility` step after Build (core dist already
built); decide explicitly whether plantroom runs via the workspace step
(today it does — document that).

### R-18 · Bench engines share one process with no GC isolation — `code`
`bench/run.mjs:87`

In compare/all mode six workloads run sequentially in one Node process;
nothing collects between them (no `--expose-gc`, no child processes).
signals-soak alone allocates ~30k closures that become garbage attributed
to whichever engine runs next. Compounds R-3.

**Fix:** child process per engine+workload, or `global.gc()` between
workloads under `--expose-gc`, and record run order in results.json.

### R-19 · Telemetry workload never exercises the coalescing it is named for — `code`
`bench/run.mjs:165`

README/PLAN call workload 2 "telemetry firehose (coalesced marks)", but the
implementation touches 8 *distinct* entities per tick (cursor stride =
updatesPerTick), so no two `markChanged` calls in a tick ever hit the same
entity+component and per-tick coalescing never triggers. At the defaults
the cursor doesn't even wrap. The workload measures scheduler overhead + 8
map writes.

**Fix:** many updates/tick over a hot subset (e.g. 1000 updates over 100
entities); report marks-issued vs changes-delivered so the coalescing ratio
is visible.

---

## Low

- **R-20 · api.md structure** — the agent-bridge block is physically inside
  the `## @domecs/persist` section, splitting save/load from their option
  interfaces; `AgentBridgeOptions` / `AgentObservation` are referenced but
  never declared. Move it into `@domecs/core` and declare both. `code`
- **R-21 · O-32 residuals** — (a) `stop()` clears `visibilityOwnedPause`
  without resuming: driver-owned pause orphaned by a stop()+startLoop()
  cycle while hidden is never auto-resumed (behavior regression vs pre-O-32
  for that interleaving); (b) app `pause()` taken *while hidden* after the
  driver claimed ownership is still trampled on re-show (stale ownership
  bit). Worth a JSDoc/ledger note on O-32's closure rather than "Closed"
  unqualified. `code`
- **R-22 · `bridge.reset()` doesn't restore `time.scale` or input** — an
  episode ending paused/rescaled silently alters all later episodes, and
  scale/input aren't serialized so snapshot comparison can't reveal it.
  Restore scale alongside the baseline or document the carve-out. `code`
- **R-23 · `bridge.step(0)` silently degrades to a heartbeat** (no systems
  run) while `bridge.step()` runs a full tick — an agent whose computed dt
  rounds to 0 gets a silent no-op turn. Throw or document non-positive dt
  at the bridge surface and in api.md. `code`
- **R-24 · `restoreHistorianCheckpoint` violates its own contract** — when
  no checkpoint ≤ tick exists it restores `checkpoints[0]` (a *future*
  checkpoint) and returns `true`; the browser twin correctly refuses. The
  two hand-copied rings have already diverged — extract the shared ring.
  `repro`
- **R-25 · `AcknowledgeAlarm` is a silent no-op** for anything except the
  hardcoded `PUMP-TRIP && reset` path; there is no acked/latched state, and
  the default resolver reports `accepted: true` for acks that did nothing —
  the opposite of the legibility thesis, discoverable by any agent reading
  the manifest. Implement ack semantics or return `accepted: false` with a
  reason. `code`
- **R-26 · `plantroom:build:pages` is byte-identical to `plantroom:build`**
  — it sets neither `PLANTROOM_BASE` nor anything else, so a local "Pages
  build" gets base `/` and 404s under `/domecs/`. Set the base or delete
  the script. `code`
- **R-27 · cold-install drift** — the test docstring claims "release paths
  set the env var" but nothing does (`RUN_COLD_INSTALL` is referenced
  nowhere in release scripts/CI); PLAN's "published packages only" is
  actually packed tarballs (a good pre-publish proxy — say so); the
  `.tgz` stdout regex truncates on temp paths containing spaces (the
  Windows default), on exactly the platform the script otherwise supports.
  `code`
- **R-28 · `pnpm bench` from a fresh clone dies with raw
  `ERR_MODULE_NOT_FOUND`** — no dist guard, unlike
  `example/agent-legibility/run.mjs` which prints an actionable one-liner
  for the identical precondition. Copy the guard. `code`
- **R-29 · Bench `domUpdates` not comparable across engines** — DOMECS
  subtracts priming and advances the window during prime; Koota/signals
  count prime mounts and don't advance (measured 1590 vs 1637 for identical
  logical work). It's the one number meant to prove work-equivalence —
  align the priming and assert equality in compare mode. `repro` (reviewer)
- **R-30 · Bench snapshot workload** — `deterministic` only checks
  round-trip serialization fidelity (never steps the restored world), and a
  single cold sample is reported as both p50 and p95. Step both worlds N
  ticks and compare; time repeated snapshots. `code`
- **R-31 · Version arithmetic** — the persist README says "product contract
  hardening via 1.0.x" while this same tranche adds new public API
  (`loadIfPresent`, `createAgentBridge`): semver-honest shipping needs
  1.1.0, not 1.0.x. Rephrase ("additive hardening via minor releases") and
  release accordingly. `code`
- **R-32 · Ledger/PLAN staleness** — O-33 still lists import-map docs +
  cold-install as fully open (docs shipped in `doc/PACKAGING.md`, script
  landed); O-14 reads as a pure wish though `bench/` now exists; PLAN WS-1
  "Metrics" promises heap growth / GC pressure / per-frame DOM
  mount/update/remove splits / dropped frames that the suite doesn't record
  — with no unchecked box covering the gap. Annotate both. `code`
- **R-33 · v1.0.0 GitHub Release notes have mangled markdown** — backticks
  rendered as backslashes (`\@domecs/*\`, broken code fence). It's the
  WS-0 public positioning artifact; re-edit the body. `repro` (reviewer,
  via API)

---

## Notes (recorded, no action forced)

- **Agent-bridge tests avoid the risky state classes** — no episode test
  emits follow-up events, spawns entities, or consumes `ctx.rand` across
  `reset()`. The event case turns out safe (see "Not confirmed" below), but
  the spawn case is R-7 and the RNG case is untested. Add the three
  episode-shape tests.
- `observe().manifest` shares live `FieldSchema` value objects with the
  world's schema metadata (`describeComponent` shallow-copies `fields`) — a
  JS consumer mutating the manifest corrupts reflection world-wide; clone
  one level deeper. (`packages/domecs/src/world.ts`)
- `makeProposal`'s module-global `proposalSeq` makes proposal ids
  non-reproducible across sessions/resets in one process — spurious diffs
  for any harness logging them. Scope per session.
- `approveProposal` validates step event names only as it executes — a
  malformed second step leaves the world half-applied with the proposal
  still pending; re-approving re-applies step 1. Resolve all names first.
- `Vessel.highTemp` (90) is a dead field — the fault's actual consequence
  (temp runaway to the 120 clamp) raises no alarm, while HI-LEVEL fires
  during healthy operation (R-9). A HI-TEMP alarm would strengthen the
  branch-compare story.
- `publish:npm`'s `@domecs/*` filter now matches
  `@domecs/example-plantroom`; only `private: true` prevents publishing an
  example app to the scope. Filter by directory instead.
- `cold-install` leaks its temp stage on any failure (cleanup only on the
  success path) — fine if intentional, but print "left for inspection:
  <path>" so it's a feature.
- `pages.yml`: `cancel-in-progress: true` deviates from GitHub's
  recommended Pages pattern (in-flight prod deploys should complete);
  adding `actions/configure-pages` with `enablement: true` would remove the
  one-time manual Pages-enablement failure mode the README documents.
- README "Scheduling modes" omits the `reactive` schedule that SKILL.md and
  the shipped `SystemSchedule` union include.
- AGENTS.md's determinism checklist teaches the
  `JSON.stringify(snapshot())` idiom that the ledger's own O-11 flags as
  fragile — add the caveat or a pointer to O-11.
- PLAN.md's WS-1 heading cites `plan/BENCHMARK.md` (and the header
  `plan/NOTES.md`) — both gitignored, invisible to repo readers; §8
  discloses it, the WS-1 heading doesn't.
- Persist README's "Main API" omits `createLocalStorageStorage(prefix?)`
  (exported, in api-surface, referenced by the root README quick start).

---

## Claims re-checked — one initial refutation was wrong

- **"`bridge.reset()` leaks pending events into the next episode" — the
  review finding was CORRECT; this file originally recorded it as refuted
  and that was a probe error.** The first probe inserted an extra
  `bridge.step()` between the act and the reset, which delivered the
  follow-up event *before* the reset — testing the wrong window. A
  regression test resetting while the follow-up was still pending showed
  the leak immediately: the abandoned episode's event fired into the first
  tick of the next episode (`echoes === 1`), exactly as the reviewer
  described. **Fixed in this PR (R-34):** `world.restore()` now discards
  pending events before applying the snapshot (events a plugin emits during
  `onRestore` survive), SPEC §7.1 states the contract normatively, and the
  regression test pins it. Lesson recorded on purpose: a refutation probe
  must reproduce the *claimed* timing before it counts as a refutation.

---

## What's strong (worth keeping as-is)

- **WS-0 discipline is real.** Every PLAN checkbox spot-checked is backed by
  a verifiable artifact; README leads with measured-claim language and
  links to an honest no-decisive-win writeup. `bench/COMPARISON.md`'s
  "plumbing takeaway" openly concedes DOMECS is *not* half of Koota's
  plumbing — rare candor in a benchmark doc.
- **The O-28 fix is textbook.** `loadIfPresent` shares `applyLoadedBytes`
  with `load()` so error semantics can't drift; the missing-vs-IO
  distinction is sound on both shipped adapters; docs updated across seven
  surfaces consistently; api-surface regenerated, not hand-edited.
- **The O-2 fix is well-tested where it's tested** — the regression test
  asserts rendered DOM content and its persistence across a quiet tick, and
  the legacy-mode guard (`changedQueries !== null`) correctly avoids
  double-painting there (the residuals are R-4/R-5).
- **The agent bridge is genuinely the thin facade it claims** — pure
  delegation, no new runtime semantics, `observe()` builds fresh
  arrays/records (one shared-ref edge noted above), exports kept in
  lockstep across barrel / api-surface / api.md.
- **Plantroom's architecture teaches the right patterns**: single shared
  domain factory consumed identically by headless and browser; checkpoints
  deliberately held *outside* the world so snapshots never nest; every
  mutation flows through `bridge.act` with typed events; the approval gate
  is real (proposals are inert data until Approve); the trip latch makes
  the naive-vs-competent compare a genuine teaching moment; zero
  `Math.random`/`Date.now` anywhere in sim state paths; all numeric updates
  clamped and finite under fault injection.
- **Deploy hygiene**: pages.yml pins actions to full SHAs with
  least-privilege permissions; the pnpm lockfile was regenerated for the
  new workspace importer so `--frozen-lockfile` CI holds;
  `bench/results.json` is gitignored so machine-local numbers can't
  silently become committed claims; `escapeHtml` on all proposal-derived
  strings before `innerHTML`.
- **Koota is used idiomatically, not as a strawman** (pinned 0.6.6,
  `trait()` + `query().updateEach()` hot path), and the DOMECS side is
  honestly timed at its full real cost (whole `world.step()` including
  scheduler/event/change machinery, per-entity `markChanged`).
- **`scripts/cold-install.mjs` is a faithful consumer simulation** —
  os.tmpdir staging defeats ancestor `node_modules` shadowing, `pnpm pack`
  exercises the real publishConfig pipeline, and the probe covers the new
  API surface including `loadIfPresent`'s missing-slot path.

---

## Suggested order of attack

1. **R-1 + R-10 + R-24** (one change): make the checkpoint ring
   restore-aware, make `compareBranches` a pure evaluator, extract the
   shared ring — then add the branch-then-restore episode test (R-14's
   snapshot-compare upgrade fits the same test file).
2. **R-2 + R-3 (+ R-18)** before the WS-1 multi-machine pass — otherwise
   that pass launders cold-start noise into "stability".
3. **R-4/R-5** (single mount.ts change) + R-6 doc sync.
4. **R-9** so the flagship's alarms tell the story the demo narrates.
5. **R-17** CI wiring — cheap, and it's the difference between having the
   WS-3 gate and advertising it.
6. R-7/R-8 as ledger entries (design decisions, not patches).
