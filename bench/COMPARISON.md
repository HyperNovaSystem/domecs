# Benchmark comparison notes (WS-1)

Headless characterization of DOMECS vs baselines on the same machine.
**Not product marketing** until multi-machine stability is confirmed.

## Engines

| Label | What it is |
|-------|------------|
| **domecs** | `@domecs/core` systems + queries + markChanged |
| **koota** | [koota](https://github.com/pmndrs/koota) traits + `query().updateEach` |
| **signals** | Hand-rolled per-field signals (fine-grained reactive style) |
| **baseline-plain** | Bare `Float64Array` loops (floor, not feature-equivalent) |

## Workloads compared

1. **Soak** — N entities with position/velocity; advance positions for T ticks.
2. **Windowed** — N entities; maintain a sliding window of W visible rows with
   mount/update/unmount bookkeeping (fleet-shaped projection).

Run:

```bash
pnpm --filter @domecs/core build
pnpm bench -- --workload compare --entities 5000 --ticks 100
```

## Plumbing complexity (implementation cost)

Approximate lines of application code for the **soak** shape (components +
spawn + tick loop), counted in the bench harness implementations:

| Engine | Soak harness LOC (approx) | What you get beyond the loop |
|--------|---------------------------|------------------------------|
| baseline-plain | ~25 | Nothing (no queries, snapshots, actions) |
| signals | ~45 | Per-field subscriptions |
| koota | ~30 | ECS traits + queries |
| domecs | ~40 | ECS + schedules + snapshots + `action` + describe |

Approximate lines for **windowed** structural visibility:

| Engine | Windowed harness LOC (approx) |
|--------|-------------------------------|
| signals | ~70 (mount/unmount + subscribe) |
| koota | ~55 (add/remove Visible trait) |
| domecs | ~60 (add/remove Row + markChanged) |

**Plumbing takeaway:** DOMECS is not half the plumbing of Koota for these
micro shapes — both are thin. The DOMECS *product* advantage is not raw
iteration; it is the **operable stack** (determinism, typed `action`,
snapshot branch/replay, multi-view DOM, agent bridge) measured in Plantroom
and the agent legibility mini-app, not in soak p95.

## Success bar (from PLAN)

Win **one** valuable workload decisively:

- **Runtime:** ≈≥30% better p95 on a flagship workload, **or**
- **Plumbing:** ≈half the app code for equivalent behavior

If neither clears after honest measurement: correct README claims (already
“performance-oriented… characterization in progress”), do not invent wins.

## Interpreting results

- Soak p95 favors raw data layout. Plain arrays and Koota SoA may beat DOMECS
  AoS component maps — that is expected and **not** a kill signal for the
  operable-sim thesis.
- Windowed p95 is closer to product shape (projection churn).
- Prefer `compare-summary.decisiveRuntimeWins` and Plantroom episode
  complexity over single-number soak bragging.
