# DOMECS benchmarks (WS-1 / O-14)

Headless-by-default harnesses that measure runtime behavior — not just
correctness. Results feed the honest performance claims in the root README.

## Workloads (from `plan/PLAN.md` WS-1)

| # | Workload | What it stresses |
|---|----------|------------------|
| 1 | **Entity soak** | 20k headless entities at accelerated sim rates; soak + snapshot cycles |
| 2 | **Telemetry firehose** | 500 updates/s across 400–10k assets, coalesced per-frame projection |
| 3 | **Windowed DOM** | 50 visible table rows + schematic projection (happy-dom) |
| 4 | **Snapshot / replay** | snapshot / restore / determinism verification |

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
node bench/run.mjs
node bench/run.mjs --workload soak
node bench/run.mjs --workload snapshot
```

Output is JSON on stdout plus a short human summary. CI may later pin
non-regression thresholds once baselines exist.

## Status

Scaffold only — workloads are minimal but runnable. Expand until numbers are
trustworthy enough for README claims.
