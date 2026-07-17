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
pnpm bench -- --workload compare --entities 5000 --ticks 100
pnpm bench:write
```

## Sample compare (Node v24, 5k soak / 2k windowed, 80 ticks, 2026-07-17)

| Workload | Engine | p50 | p95 | vs DOMECS p95 |
|----------|--------|-----|-----|---------------|
| soak | **domecs** | 0.68ms | 1.35ms | 1.0× |
| soak | koota | 0.41ms | 1.34ms | ~same |
| soak | signals | 0.38ms | 1.15ms | DOMECS ~1.18× slower |
| windowed | **domecs** | 0.025ms | 0.075ms | 1.0× |
| windowed | koota | 0.040ms | 0.097ms | DOMECS ~0.77× (faster) |
| windowed | signals | 0.019ms | 0.049ms | DOMECS ~1.54× slower |

**Decisive runtime wins (≥30% p95):** host- and N-dependent. A second pass
(2k entities, 40 ticks) showed **windowed vs Koota at 0.42× p95** (decisive).
The 5k/80-tick pass above was only ~0.77× (not decisive). Treat as
**promising on windowed projection, not a frozen claim** until multi-machine
stability.

**Plumbing:** micro-shapes do not show “half the code” vs Koota; product value is the operable stack (action / snapshot / agent), not soak iteration. See COMPARISON.md.

## Status

- [x] Headless suite + baselines
- [x] Compare summary + honest no-win documentation
- [ ] Multi-machine stability pass
- [ ] README product claims remain gated (no decisive runtime win yet)
