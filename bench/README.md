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
| 4e | **Cross-entity rules** | `rules` | `@domecs/rules` self-only vs `nearest(Player)` vs memoized `sum(Enemy, Hp.hp)` rule, 1000 entities |
| 5 | **Plain baseline** | `baseline` | Hand-rolled Float64Array loops |
| 6 | **Cross-engine compare** | `compare` | DOMECS vs Koota vs signals |

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
pnpm --filter @domecs/core build
pnpm bench
node --expose-gc bench/run.mjs --workload compare --entities 5000 --ticks 100 --trials 9
pnpm bench:write
```

## Methodology

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
- **Trials:** the compare phase runs `--trials` (default 5) interleaved
  trials and reports median p50/p95 and the p95 range per engine; a win must
  hold in every trial (O-72). `pnpm bench` runs Node with `--expose-gc`.
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

## Sample compare (Node v24, arm64, 5 trials, 100 ticks, warmup 30, gc on, 2026-10-14)

`pnpm bench -- --workload compare` (soak n=5000, windowed n=2000). Medians of
5 interleaved trials; the range is the per-trial min–max.

| Workload | Engine | p50 | p95 (median) | p95 range | DOMECS p95 ÷ engine p95 |
|----------|--------|-----|--------------|-----------|-------------------------|
| soak | **domecs** | 1.04ms | 1.65ms | 1.43–1.84ms | 1.0× |
| soak | koota | 1.22ms | 1.36ms | 0.98–1.60ms | 1.22× (trials 1.07–1.45×) |
| soak | signals | 0.79ms | 0.97ms | 0.76–1.31ms | 1.70× (trials 1.09–2.42×) |
| windowed | **domecs** | 0.065ms | 0.112ms | 0.097–0.124ms | 1.0× |
| windowed | koota | 0.038ms | 0.068ms | 0.032–0.074ms | 1.66× (trials 1.35–3.73×) |
| windowed | signals | 0.021ms | 0.038ms | 0.031–0.050ms | 2.94× (trials 2.48–3.70×) |

**No runtime win.** DOMECS is slower than both baselines on both workloads on
this host. An earlier single-run sample (2026-07-17) showed windowed at 0.65×
Koota; across repeated runs that did not reproduce (the 2026-10-13 review
measured 0.85–2.69× over 15 runs, O-72), so it is withdrawn. A runtime win now
counts only if it clears the bar (≤0.70×) in **every** trial
(`compare-summary.decisiveRuntimeWins`; `verdictRange` has the per-trial
ratios).

The DOMECS rows time a full `world.step()` (scheduler, event flush, change
windows, `markChanged`); Koota and signals time a bare loop — see
COMPARISON.md. Ratios are per host and per N.

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

## Status

- [x] Headless suite + baselines
- [x] Compare summary + honest no-win documentation
- [ ] Multi-machine stability pass
- [ ] README product claims remain gated (no decisive runtime win yet)
