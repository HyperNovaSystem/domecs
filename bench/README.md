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
  trials and reports median p50/p95 and the p95 range per engine.
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

## Status

- [x] Headless suite + baselines
- [x] Compare summary + honest no-win documentation
- [x] Frozen protocol: fresh build, like-for-like soak, bootstrap verdict,
      allocation/GC, DOM split, browser projection (2026-10-20)
- [ ] Multi-machine stability pass
- [ ] README product claims remain gated (no decisive runtime win yet)
