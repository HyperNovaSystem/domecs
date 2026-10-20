# DOMECS benchmarks (WS-1 / O-14)

Headless-by-default harnesses that measure runtime behavior — not just
correctness. Results feed honest performance language in the root README.

See also **[COMPARISON.md](./COMPARISON.md)** for baselines and success-bar
interpretation.

## Workloads

| # | Workload | CLI | What it stresses |
|---|----------|-----|------------------|
| 1 | **Entity soak** | `soak` | Headless entities + fixed systems |
| 2 | **Telemetry firehose** | `telemetry` | Coalesced markChanged updates |
| 3 | **Windowed projection** | `windowed` | 50-row window over large set |
| 4 | **Snapshot / restore** | `snapshot` | Snapshot size/time + determinism |
| 4b | **Snapshot hash** | `hash` | `hashSnapshot` (canonical JSON + FNV-1a-64) over a 1000-entity snapshot |
| 4c | **Deterministic math** | `dmath` | `dmath.sin`/`dmath.cos` vs `Math.sin`/`Math.cos`, 1M calls |
| 4d | **Spatial index** | `spatial` | `@domecs/scene` `createSpatialHash` `refresh()` and `nearest` at 1000 entities |
| 4f | **Contacts** | `contacts` | `@domecs/scene` `installContacts`: one contacts run at 1000 entities × 2 tag pairs |
| 4e | **Cross-entity rules** | `rules` | `@domecs/rules` self-only vs `nearest(Player)` vs memoized `sum(Enemy, Hp.hp)` rule, 1000 entities |
| 5 | **Plain baseline** | `baseline` | Hand-rolled Float64Array loops |
| 6 | **Cross-engine compare** | `compare` | DOMECS vs Koota vs signals |
| 7 | **Browser projection** | `pnpm bench:browser` | Windowed rows in a real DOM, incl. layout |

## Baselines (implemented)

| Engine | Path | Notes |
|--------|------|-------|
| **Koota** | `baselines/koota.mjs` | `koota` package (workspace devDependency) |
| **Signals** | `baselines/signals.mjs` | Hand-rolled per-field fine-grained store |
| **Plain** | in `run.mjs` | Float64Array floor |

## Success bar (PLAN)

Win **one** valuable workload decisively:

- ≈≥30% better p95 **or**
- ≈half the app plumbing for equivalent behavior

Losing is output: claims stay conservative.

## Run

```bash
pnpm bench                  # builds @domecs/core, then every workload
pnpm bench -- --workload compare --trials 9
pnpm bench:write            # also writes bench/results.json
pnpm bench:browser          # builds core + dom, then the browser projection bench
pnpm bench:profile soak     # CPU profile of one workload (bench/profiles/)
```

`bench/run.mjs` refuses to run against a `dist` older than `src`
(`--allow-stale` overrides). The 2026-10-20 audit found the bench had been
measuring a stale build.

## Methodology

Frozen 2026-10-20 (PLAN WS-5 A0). Judge optimizations against this protocol,
not against single runs.

- **Fresh build:** `pnpm bench` builds first. Run directly, `bench/run.mjs`
  refuses a `dist/index.js` older than any file in `src`; that is an mtime
  heuristic (it misses config changes and deleted sources), so the
  build-first script is the real guarantee.
- **Like-for-like soak:** each engine records every change and a reader
  consumes them. DOMECS calls `markChanged` and runs an `OnChanged` reactive
  reader; Koota uses its default `changeDetection: 'auto'` with a
  `world.onChange(Position)` reader (the fastest stable Koota setup we
  found). `compare-summary.soakWorkEqual` asserts both deliver the same
  number of changes, `entities × ticks`, in every trial. Before 2026-10-20 the Koota harness tracked no changes
  at all: a separate `Changed` query does not switch `auto` tracking on.
- **Verdict:** per trial, the paired ratio DOMECS p95 / competitor p95. The
  headline is the median ratio with a seeded bootstrap 95% CI over trials
  (default 7); a decisive win needs the CI's upper bound ≤ 0.70.
  Ratios keep full precision through the decision and are rounded only for
  display. A failed work-equivalence check (soak or windowed, in any trial)
  voids any win. `verdictRange` keeps the per-trial min–max for context.
  This replaces the
  2026-10-14 rule ("≤0.70 in every trial"), which let one noisy pairing
  decide the verdict.
- **Allocation and GC:** every measured tick loop runs through
  `measureTicks()` (`bench/measure.mjs`). With `v8.GCProfiler` it reports
  `allocBytesPerTick` (heap growth plus what each GC inside the window
  reclaimed; approximate, since the heap also holds the samples array),
  `gcCount` and `gcMs`. The snapshot workload times `snapshot()` calls and
  reports no allocation figure.
- **DOM split:** windowed rows report `domSplit` (create / update / remove)
  as well as the `domUpdates` total.
- **Warmup:** every workload (including the Koota/signals/plain baselines)
  runs `--warmup` unmeasured ticks first (default 30), so p50/p95 describe
  warmed steady state, not JIT/IC cold-start. Cold-vs-warm differed by up to
  ~5× per engine before this, enough to flip verdicts on noise.
- **GC isolation:** run with `node --expose-gc` to force a full GC between
  workloads (`gcBetween: true` in the summary). All engines still share one
  process; child-process-per-engine is the stronger isolation if numbers
  look noisy.
- **Equal work check:** the three windowed harnesses mirror each other's
  priming and counting exactly; `compare-summary.windowedWorkEqual` asserts
  the reported `domUpdates` match across engines, and the note carries a
  WARNING when they don't.
- **Verdict scope:** ratios are computed only from the compare-phase rows
  (identical entity counts by construction) — a standalone `soak` at a
  different `--entities` can never leak into the verdict.
- **Trials:** the compare phase runs `--trials` (default 7) interleaved
  trials, rotating the engine order each trial, and reports median p50/p95
  and the p95 range per engine. The browser bench rotates the same way.
  `pnpm bench` runs Node with `--expose-gc`.
- **Browser projection:** `bench/browser/run.mjs` serves the repo, loads
  `bench/browser/page.html` in headless Chromium once per engine per trial
  (DOMECS with `@domecs/dom`; Koota and plain JS with hand-written DOM),
  and times each frame's tick plus a forced layout. The page is
  cross-origin isolated so `performance.now()` has 5 µs resolution, not
  0.1 ms. Long Animation Frames that start inside the measured frames are
  counted (the runner waits for the last frame's entry). Every engine renders
  the same text (the row's logical index). The frame time covers script,
  style and layout, not paint or compositing. The same paired-ratio verdict
  applies, and `workEqual` checks in every trial that the engines did the
  same DOM work (DOMECS's first-paint `update` per created row is
  subtracted).
- **Snapshot workload:** repeated warmed snapshots (real percentiles), and
  the `deterministic` flag steps the source and the restored twin forward
  together and compares final snapshots and clocks (`elapsed`,
  `fixedAccumulator`) — restore fidelity plus dynamic continuation, not just
  round-trip serialization. A sub-rate `fixed` system and frame times that
  are not fixed-step multiples make a lost accumulator visible.
- **Hash workload (O-11):** times the strict `hashSnapshot(snap,
  { includeChanges: true })` over a fixed 1000-entity snapshot (three
  components each, ~168 KB as `JSON.stringify`), warmed, 50 repeats. The
  row reports `canonicalBytes`, `targetP50Ms` (2 ms, the spec §4.1 target;
  informational, not a gate), `withinTarget`, and `deterministic` (every
  repeat produced the same hash).
- **dmath workload (O-75):** 1M seeded inputs (80% in [-4π, 4π], 20% in
  [-1e5, 1e5]), each function timed twice interleaved with its `Math.*`
  counterpart, 15 samples per pass; the row reports ns/call and the
  `dmath ÷ Math` p50 ratio per function, `targetRatio` (3×, spec §4.2 test 5;
  informational, not a gate) and `withinTarget`.
- **Spatial workload (O-8):** 1000 entities spread uniformly over a
  1000 × 1000 field, `createSpatialHash` with cell size 32 (about one
  entity per cell). Each of 200 refresh samples first moves every entity by
  up to 2 units (untimed) so some cross cells; `nearest` is timed over 100k
  seeded query points, 5 samples. The row reports `refreshP50Ms` against
  `refreshTargetMs` (0.1 ms), `nearestUsAvg` against `nearestTargetUs`
  (2 µs; spec §5.1, informational, not a gate), and `deterministic` (a
  second index at cell size 7 returns the same `nearest`, `within` and
  `pairs` results). The scene dist imports the bare `@domecs/core`, so the
  workload registers a resolve hook pointing it at the core dist.
- **Contacts workload (O-85):** 1000 entities spread uniformly over a
  1000 × 1000 field, radii 2–6 from a component, every tenth a `Player`, the
  rest alternating `Enemy` / `Pickup`; `installContacts` with pairs
  `[[Player, Enemy], [Player, Pickup]]`, `stay: true`, cell size 16. A fixed
  system moves every entity by up to 2 units per step; a sample is the
  contacts system alone, timed by fixed systems at priority 149 and 151, over
  300 steps after the warmup. The row reports `p50Ms` against `targetP50Ms`
  (0.5 ms; spec §6.2, informational, not a gate) and `contactEvents`
  (deterministic: 3480 for this setup).
- **Rules workload (O-82):** three single-rule worlds of 1000 entities
  (positions uniform over 1000 × 1000, every fourth an `Enemy`, one
  `Player`), one tick rule over every entity writing a changed value each
  tick: self-only (`Out.a + Pos.x * 0.5`), `Out.a + (nearest(Player).id ??
  0)` (spatial option, cell size 32, including the per-run grid build) and
  `Out.a + sum(Enemy, Hp.hp)` (memoized: the rule writes no `Hp`). Three
  interleaved rounds of 300 timed `stepOnce()`s after the warmup; the row
  reports `nearestRatio` against 3× and `sumMemoRatio` against 1.2× (spec
  §5.2, informational, not a gate). Rules' dist imports the bare
  `@domecs/core`, so it loads through the same resolve hook as scene.
- **Telemetry workload:** 1,000 marks/tick over a 100-entity hot subset, so
  per-tick coalescing actually engages; `coalesceRatio` reports marks issued
  per change delivered (≈10 when coalescing works).

## Sample compare (Node v26.7, i9-11900H, 7 trials, 100 ticks, warmup 30, gc on, 2026-10-20)

`pnpm bench -- --workload compare` on a fresh build of `main` (soak n=5000,
windowed n=2000). Medians of 7 interleaved trials.

| Workload | Engine | p50 | p95 (median) | p95 range | alloc/tick | GCs | DOMECS ÷ engine (median, 95% CI) |
|----------|--------|-----|--------------|-----------|------------|-----|-----------------------------------|
| soak | **domecs** | 1.02ms | 1.19ms | 1.08–1.35ms | 872 KB | 3 | 1.0× |
| soak | koota | 0.83ms | 1.10ms | 0.94–1.34ms | 1.28 MB | 3 | 1.10× (1.04–1.16) |
| soak | signals | 0.33ms | 0.37ms | 0.36–0.45ms | 160 KB | 0 | 3.02× (2.85–3.26) |
| windowed | **domecs** | 0.032ms | 0.046ms | 0.039–0.052ms | 17.7 KB | 0 | 1.0× |
| windowed | koota | 0.022ms | 0.031ms | 0.022–0.057ms | 19.9 KB | 0 | 1.43× (1.24–1.79) |
| windowed | signals | 0.014ms | 0.020ms | 0.015–0.022ms | 17.0 KB | 0 | 2.18× (1.98–2.86) |

Browser projection (`pnpm bench:browser`, Chromium 152 headless, n=2000,
window 50, 300 frames, 7 trials):

| Engine | frame p50 | frame p95 | script p95 | DOMECS ÷ engine frame p95 (median, 95% CI) |
|--------|-----------|-----------|------------|---------------------------------------------|
| **domecs** | 0.98ms | 1.36ms | 0.39ms | 1.0× |
| koota | 0.96ms | 1.21ms | 0.28ms | 1.13× (0.84–1.23) |
| plain JS | 0.79ms | 0.98ms | 0.20ms | 1.38× (1.21–1.62) |

**No runtime win.** With equal work, DOMECS soak is at rough parity with
Koota (1.10×), not the 1.22× of the uneven 2026-10-14 compare. Windowed
headless is 1.43×. In the browser, layout dilutes engine overhead: DOMECS
is 1.13× Koota per frame. Every work-equivalence check passes. These are the
numbers the WS-5 overhead cuts (A1) get judged against.

The DOMECS rows time a full `world.step()` (scheduler, event flush, change
windows, `markChanged`), while Koota and signals time a bare loop; see
COMPARISON.md. Ratios are per host and per N; one host so far.

**Plumbing:** micro-shapes do not show “half the code” vs Koota; product value is the operable stack (action / snapshot / agent), not soak iteration. See COMPARISON.md.

## Hash workload (Node v24.19, x86-64 2-vCPU VM, gc on, 2026-10-18)

`node --expose-gc bench/run.mjs --workload hash`, three runs:

| Snapshot | `JSON.stringify` bytes | canonical bytes | p50 | p95 | target p50 |
|----------|------------------------|-----------------|-----|-----|------------|
| 1000 entities × 3 components | 167,872 | 168,861 | 4.5–4.6ms | 6.9–7.2ms | ≤ 2ms (missed) |

On the same host `JSON.stringify` of that snapshot takes ~1.0 ms, so the
2 ms target asks for a canonical walk plus hash within 2× native
serialization. The measured split is ~3 ms for `canonicalSnapshot` (about a
third of it `Number::toString`) and ~1 ms for FNV-1a-64 over the text.
Recorded as informational (spec §4.1); revisit on the reference host.

## dmath workload (Node v24.19, arm64 2-vCPU VM, gc on, 2026-10-18)

`node --expose-gc bench/run.mjs --workload dmath`, three runs:

| Function | `dmath` ns/call | `Math` ns/call | ratio | target |
|----------|-----------------|----------------|-------|--------|
| `sin` | 63.4–64.5 | 54.3–54.5 | 1.16–1.19× | ≤ 3× (met) |
| `cos` | 65.7–65.9 | 54.3 | 1.21× | ≤ 3× (met) |

Both sides are called through the same function-value loop, so the absolute
numbers include call overhead; the ratio is the figure of merit.

## Spatial workload (Node v24.19, arm64 2-vCPU VM, gc on, 2026-10-19)

`node --expose-gc bench/run.mjs --workload spatial`, three runs:

| Measure | Result | Target |
|---------|--------|--------|
| `refresh()` p50 / p95, 1000 entities | 0.175–0.185 ms / 0.39–0.42 ms | ≤ 0.1 ms (missed) |
| `nearest` average | 0.713–0.716 µs | ≤ 2 µs (met) |

About 0.12 ms of the refresh is `world.iterEntitiesWith` itself (ascending
id selection plus a store lookup per entity); the grid update is the rest.
Recorded as informational (spec §5.1). Faster iteration in core, or an
incremental refresh from change windows, is the follow-up if a consumer
needs it.

## Contacts workload (Node v24.19, arm64 2-vCPU VM, gc on, 2026-10-19)

`node --expose-gc bench/run.mjs --workload contacts`, four runs on a host
shared with other jobs (load average 2–3):

| Measure | Result | Target |
|---------|--------|--------|
| contacts run p50, 1000 entities × 2 pairs | 0.37–0.54 ms | ≤ 0.5 ms (met in 3 of 4) |
| contacts run p95 | 2.6–4.1 ms | — |

The same host measured the `spatial` workload's `refresh()` p95 at 1.2 ms
(0.4 ms recorded above on a quiet host), so the p95 here is mostly host
noise. Of a run, about 0.3 ms is gathering the colliders (the query's
views, one `Map` lookup and one `grid.set` per entity) and about 0.13 ms the
100 anchored `within` queries.

## Rules workload (Node v24.19, arm64 2-vCPU VM, gc on, 2026-10-19)

`node --expose-gc bench/run.mjs --workload rules`, three runs:

| Measure | Result | Target |
|---------|--------|--------|
| self-only rule, p50 per `stepOnce()` | 0.553–0.573 ms | — |
| `nearest(Player)` ÷ self-only | 1.73–1.80× | ≤ 3× (met) |
| memoized `sum(Enemy, Hp.hp)` ÷ self-only | 0.92–0.96× | ≤ 1.2× (met) |

The memoized sum is computed once per run, so its per-entity cost is a
closure call; its expression is slightly cheaper than the self-only one.

## 2.1 release-candidate check (Node v24.19, arm64 2-vCPU VM, gc on, 2026-10-19)

Spec §8 asks the RC for no regression beyond noise on soak, telemetry or
windowed. Each workload ran interleaved against a 2.0.0 checkout (`b425242`,
built the same way), medians of the per-run p50/p95:

| Workload | Runs | 2.1 p50 / p95 | 2.0 p50 / p95 | ratio p50 / p95 |
|----------|------|---------------|---------------|-----------------|
| soak (`--ticks 500 --warmup 100`) | 9 | 1.127 / 1.454 ms | 1.121 / 1.408 ms | 1.01 / 1.03 |
| telemetry (`--ticks 500 --warmup 100`) | 9 | 0.347 / 0.527 ms | 0.346 / 0.538 ms | 1.00 / 0.98 |
| windowed (`--ticks 1000 --warmup 200`) | 15 | 0.0356 / 0.0632 ms | 0.0346 / 0.0611 ms | 1.03 / 1.03 |
| snapshot (default) | 7 | 5.14 / 9.02 ms | 5.84 / 8.90 ms | 0.88 / 1.01 |

The same harness comparing 2.0 with itself gave ratios of 0.995–1.045, so
every difference is within noise. Default-length runs (100 ticks) are
noisier: one 7-run pass showed windowed p95 at 1.9× (0.28 vs 0.15 ms), which
did not reproduce with longer runs.

## 2.2 release-candidate check (Node v24.19, arm64 2-vCPU VM, gc on, 2026-10-19)

Same method as the 2.1 check, against the 2.1 RC (`5cb0290`, extracted with
`git archive` and built the same way), medians of the per-run p50/p95. The
first pass showed soak p50 at 1.11× (9 runs) and 1.08× (15 runs) of 2.1:
`markChanged` called the act-log tap's `tapMutated()` on every mark, even
with no recorder. With the mutation paths testing a plain flag first
(E13.1 `perf(core)`):

| Workload | Runs | 2.2 p50 / p95 | 2.1 p50 / p95 | ratio p50 / p95 |
|----------|------|---------------|---------------|-----------------|
| soak (`--ticks 500 --warmup 100`) | 9 | 1.013 / 1.237 ms | 1.111 / 1.294 ms | 0.91 / 0.96 |
| telemetry (`--ticks 500 --warmup 100`) | 9 | 0.345 / 0.441 ms | 0.345 / 0.524 ms | 1.00 / 0.84 |
| windowed (`--ticks 1000 --warmup 200`) | 15 | 0.0342 / 0.0648 ms | 0.0354 / 0.0619 ms | 0.97 / 1.05 |
| snapshot (default) | 7 | 4.54 / 6.02 ms | 4.72 / 6.87 ms | 0.96 / 0.88 |

Further soak passes (15 runs each) gave p50 ratios of 0.99, 0.99 and 0.97
(the last with 2.1 run first). The host was shared with other test runs, and
two 2.1-vs-2.1 soak controls gave 1.00 and 0.92, so differences under about
8% are noise here. Every pass after the fix has 2.2 at or below 2.1.

## 2.3 release-candidate check (Node v24.19, arm64 2-vCPU VM, gc on, 2026-10-19)

Same method, against the 2.2 RC (`4631095`, extracted with `git archive` and
built the same way), interleaved runs, medians of the per-run p50/p95. The
host was shared with other jobs (load average 3–4.4 on 2 vCPU).

| Workload | Runs | 2.3 p50 / p95 | 2.2 p50 / p95 | ratio p50 / p95 |
|----------|------|---------------|---------------|-----------------|
| soak (`--ticks 500 --warmup 100`) | 15 | 1.081 / 2.297 ms | 1.147 / 3.056 ms | 0.94 / 0.75 |
| telemetry (`--ticks 500 --warmup 100`) | 21 | 0.351 / 1.431 ms | 0.353 / 2.008 ms | 0.99 / 0.71 |
| windowed (`--ticks 1000 --warmup 200`) | 15 | 0.0349 / 0.0724 ms | 0.0352 / 0.0741 ms | 0.99 / 0.98 |
| snapshot (default) | 9 | 5.12 / 9.18 ms | 5.31 / 9.81 ms | 0.96 / 0.94 |

p50 is flat or lower on every workload. p95 swings with the host load: a
first 15-run telemetry pass gave a p95 ratio of 1.34, a 21-run pass 0.71, a
2.2-vs-2.2 control 0.96 and a reversed-order pass (2.2 first) 0.97, so
telemetry p95 differences are noise here. The E18.1 archetype fix sorts
component names once per new archetype, not per entity or tick. The
`contacts` workload (1000 entities × 2 pairs, `stay: true`) gave p50 0.45–0.47
ms over three runs, within the 0.5 ms target.

## Status

- [x] Headless suite + baselines
- [x] Compare summary + honest no-win documentation
- [x] Frozen protocol: fresh build, like-for-like soak, bootstrap verdict,
      allocation/GC, DOM split, browser projection (2026-10-20)
- [ ] Multi-machine stability pass
- [ ] README product claims remain gated (no decisive runtime win yet)
