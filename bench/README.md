# DOMECS benchmarks (WS-1 / O-14)

Headless-by-default harnesses that measure runtime behavior — not just
correctness. Results feed the honest performance claims in the root README.

## Workloads (from `plan/PLAN.md` WS-1)

| # | Workload | CLI | What it stresses |
|---|----------|-----|------------------|
| 1 | **Entity soak** | `soak` | Headless entities + fixed systems |
| 2 | **Telemetry firehose** | `telemetry` | Coalesced markChanged updates |
| 3 | **Windowed projection** | `windowed` | 50-row window over large set |
| 4 | **Snapshot / restore** | `snapshot` | Snapshot size/time + determinism |
| 5 | **Plain baseline** | `baseline` | Hand-rolled Float64Array loops |

## Metrics

- p50 / p95 tick and update time
- DOM mounts / updates / removes per frame (workload 3)
- Heap growth (where the host exposes it)
- Snapshot duration + serialized size
- Determinism: identical seeds → identical snapshot digests

## Baselines (planned)

- Koota
- Fine-grained reactive + TanStack Virtual (or hand-rolled signals)
- Plain store + DOM

## Success bar

Win **one** valuable workload decisively — ≈≥30% better p95 runtime, **or**
≈half the app plumbing. Losing is also output: claims get corrected.

## Run

```bash
# from repo root (after pnpm install + build of packages)
pnpm --filter @domecs/core build
pnpm bench
pnpm bench -- --workload soak --entities 20000 --ticks 200
pnpm bench:write   # also writes bench/results.json (gitignored)
```

Output is JSON on stdout plus a short human summary.

### Sample results (illustrative — re-run on your machine)

Host Node v24, 2k entities, 40 ticks (2026-07-16):

| Workload | p50 | p95 | Notes |
|----------|-----|-----|-------|
| soak | 0.25ms | 0.80ms | fixed move systems |
| telemetry | 0.01ms | 0.02ms | 8 marks/tick |
| snapshot | 3.4ms | 3.4ms | ~189KB JSON; deterministic restore |
| windowed | 0.03ms | 0.11ms | window=50 over 2k |
| baseline-plain | 0.01ms | 0.21ms | Float64Array; not feature-equivalent |

Koota / Solid baselines not wired yet — next measurement pass.

## Status

Runnable characterization suite. Numbers are **not** yet a product claim;
use them to correct README language when they stabilize across machines.
