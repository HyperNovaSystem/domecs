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
node --expose-gc bench/run.mjs --workload compare --entities 5000 --ticks 100
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
- **Snapshot workload:** repeated warmed snapshots (real percentiles), and
  the `deterministic` flag steps the source and the restored twin forward
  together and compares final snapshots — restore fidelity plus dynamic
  continuation, not just round-trip serialization.
- **Telemetry workload:** 1,000 marks/tick over a 100-entity hot subset, so
  per-tick coalescing actually engages; `coalesceRatio` reports marks issued
  per change delivered (≈10 when coalescing works).

## Sample compare (Node v22, 2k entities, 40 ticks, warmup 20, gc on, 2026-07-17)

| Workload | Engine | p50 | p95 | vs DOMECS p95 |
|----------|--------|-----|-----|---------------|
| soak | **domecs** | 0.31ms | 0.40ms | 1.0× |
| soak | koota | 0.32ms | 0.36ms | DOMECS ~1.13× slower |
| soak | signals | 0.19ms | 0.28ms | DOMECS ~1.46× slower |
| windowed | **domecs** | 0.033ms | 0.072ms | 1.0× |
| windowed | koota | 0.063ms | 0.110ms | DOMECS **0.65×** (decisive) |
| windowed | signals | 0.022ms | 0.048ms | DOMECS ~1.5× slower |

**Decisive runtime wins (≥30% p95):** host- and N-dependent. With warmup and
GC isolation in place, windowed-vs-Koota measured **0.65× p95** on this host
(decisive); soak does not win. Treat as **promising on windowed projection,
not a frozen claim** until multi-machine stability.

**Plumbing:** micro-shapes do not show “half the code” vs Koota; product value is the operable stack (action / snapshot / agent), not soak iteration. See COMPARISON.md.

## Status

- [x] Headless suite + baselines
- [x] Compare summary + honest no-win documentation
- [ ] Multi-machine stability pass
- [ ] README product claims remain gated (no decisive runtime win yet)
