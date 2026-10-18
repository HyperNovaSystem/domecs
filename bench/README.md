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

## Status

- [x] Headless suite + baselines
- [x] Compare summary + honest no-win documentation
- [ ] Multi-machine stability pass
- [ ] README product claims remain gated (no decisive runtime win yet)
