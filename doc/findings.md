# DOMECS v0.1 — Implementation Findings

Log of SPEC/API ambiguities, contradictions, or gaps surfaced while building the alpha engine + roguelike exemplar. Each entry proposes a resolution. Decisions roll into a spec update after the alpha cycle.

Format: `## [F-N] Title` — status (`open` | `resolved` | `deferred`) — date.

---

## [F-1] `ComponentBag` string-keyed form has no registration path

**Status:** resolved — 2026-04-18
**Surfaced by:** `packages/domecs/test/world.basic.test.ts` — "spawn accepts a ComponentBag keyed by ComponentType.name".

**Problem.** `api.md` declares `type ComponentBag = Record<string, unknown>` with keys being `ComponentType.name`. SPEC §2.3 says worlds own their component stores and that *no global mutable state* survives between worlds. There is no specified moment at which a string key (`"Position"`) is bound to its `ComponentType<T>` inside a given world. If `spawn(bag)` is the first mention of the type, the world has never seen the `ComponentType` object, so it cannot look up the type from the string name without either (a) a process-global name→type registry (violates plural-worlds axiom), or (b) an eager registration step the SPEC does not describe.

**Resolution.** Redefine `ComponentBag` as identity-keyed, not name-keyed:

```ts
type ComponentBag =
  | ReadonlyMap<ComponentType<unknown>, unknown>
  | ReadonlyArray<readonly [ComponentType<unknown>, unknown]>
```

This removes the lookup ambiguity and keeps worlds self-contained. The `Record<string, unknown>` sugar can return post-alpha once a `createWorld({ components: [...] })` eager-registration option is specified. For alpha we use the identity form exclusively; the quick-start example in `api.md` (`Position: { x, y }`) should be treated as pseudocode pending that follow-up.

**Spec impact.** `api.md` §`World.spawn` + `ComponentBag` type. No SPEC normative-text impact beyond §2.3 staying intact.

---

## [F-2] External `markChanged` between ticks is invisible to reactive systems

**Status:** open — 2026-04-18
**Surfaced by:** `packages/domecs/test/scheduler.test.ts` — initial draft of the reactive-system test.

**Problem.** SPEC §4 step 0 says "Clear change-detection flags (Added/Removed/Changed sets)" and step 8 says "Commit change-detection sets for next tick's step 0." SPEC §4 step 6 says reactive systems "see queries that changed in steps 3–5." Taken together, the tick-scoped sets describe mutations made *during* a tick by systems in steps 3–5, observed by reactive systems in step 6 of the same tick, then wiped at step 0 of the next tick.

A caller who invokes `world.markChanged` or mutates component data *between* ticks (outside any system) writes into the change-detection sets — but those writes are erased by the next `step()`'s step 0 before any system runs. Such external mutations are effectively invisible to reactive systems.

This is *probably* intended (ECS discipline: mutations happen inside systems), but SPEC does not say so explicitly, and `markChanged` is exposed on the public `World` interface with no constraint on when it may be called.

**Proposed resolution.** Add a normative note to SPEC §2.5 (or §4 step 0) stating that component mutations and `markChanged` calls made outside any system between ticks are *captured* into the current tick's sets and observed by the *next* tick's systems. Implementation options:

1. **Accept as-is** (external markChanged is lost). Document the constraint; add a dev-mode warning when `markChanged` fires outside a running system.
2. **Buffer-and-swap**: `step 0` swaps the live change-detection sets with fresh empty ones, so externally-set marks survive into the tick. This matches the existing event-buffering semantics (§2.6) and is symmetric.

Option 2 preserves the plural-worlds axiom without adding dev-mode telemetry coupling. Recommend it, pending review.

**Spec impact.** SPEC §4 step 0/step 8 phrasing; possibly §2.5 (`markChanged` contract).

---

## [F-3] `TimeState.scaledDelta` quantization at 1 ms breaks `fixedStep = 1/60`

**Status:** open — 2026-04-18
**Surfaced by:** `packages/domecs/test/scheduler.test.ts` — "accepts divisor rates and runs each Nth fixed step".

**Problem.** SPEC §2.7 requires `scaledDelta` to be quantized to 1 ms precision so determinism across machines is independent of float drift. But the default `fixedStep = 1/60 ≈ 0.016667 s ≈ 16.667 ms` is not representable in integer ms. With `scale = 1`, `quantizeMs(1/60)` yields `round(16.666…) / 1000 = 0.017` s. Sixty ticks with dt = 1/60 yield total scaled time of `60 × 0.017 = 1.02` s → `1.02 / (1/60) = 61.2` fixed steps, a 2 % drift.

A 60 Hz world with a "run 60 times per second" physics system actually fires 61 times per second of wall-clock time. This is a silent determinism quirk: nothing is wrong about any individual tick, but aggregate rates drift.

**Proposed resolution.** Pick one:

1. **Prescribe a ms-exact default `fixedStep`** (e.g., `1/50 = 0.020 s` or `1/100 = 0.010 s`). 60 Hz becomes opt-in with a warning that rates over it may drift.
2. **Quantize to µs instead of ms** (or keep doubles). Removes the drift at the cost of a tighter wire format for snapshots.
3. **Compute fixed-step accumulation against integer ms since world start**, not against `scaledDelta`. The accumulator becomes integer-arithmetic determined, independent of `scaledDelta` quantization.

Option 3 preserves the SPEC's 1 ms quantization story for user-visible time and removes drift from the scheduler. Recommend it.

**Spec impact.** SPEC §2.7 (quantization rule) + §3 fixed-rate rule + §4 step 3. Tests should exercise a ms-exact `fixedStep` for now.

---

## [F-4] `Not(Has(X))` silently returns true for all entities

**Status:** open — 2026-04-18
**Surfaced by:** `example/roguelike/src/game.ts` — `enemyCount` helper; initial roguelike test run (2/10 failures).

**Problem.** `api.md` documents `Not<T>(type)` with signature `Not(Player)` (taking a `ComponentType`). But `And(Has(Actor), Not(Has(Player)))` is an extremely natural phrasing — `Not` reads as a predicate combinator the way `Or`/`And` do, not as a shortcut for "without component". Because `Has(Player)` returns a `QueryNode` (not a `ComponentType`), the literal `.type.name` read inside `evalStructural` falls through to `undefined`, and `!types.has(undefined)` is always `true`. The query silently returns every entity that satisfies the sibling clause — no type error at runtime, no loud failure; just wrong counts.

TypeScript *should* reject passing a `QueryNode` where `ComponentType<T>` is expected, but the test harness runs vitest directly (no `tsc --noEmit` in the test command), so the mistake survives into runtime. The roguelike integration tests caught it — unit tests of `Not` alone (passing the documented shape) did not.

**Proposed resolution.** Widen `Not` (and by symmetry `Has`) to accept *either* `ComponentType<T>` or `QueryNode`:

```ts
export function Not<T>(arg: ComponentType<T> | QueryNode): QueryNode {
  const inner = 'kind' in arg ? arg : Has(arg)
  return { kind: 'not', child: inner }
}
```

…plus a `not` node shape change from `{ kind: 'not'; type }` to `{ kind: 'not'; child: QueryNode }`, with `evalStructural` / `evalEntity` recursing into the child. This makes `Not(Player)` and `Not(Has(Player))` both valid (and equivalent), matching reader intuition and closing the footgun.

Alternative: keep the narrow signature but add a `tsc --noEmit` typecheck step to the workspace `test` script so miswrites fail loudly in CI. Preferred path is widening + typecheck — runtime forgiveness *and* static guard.

**Spec impact.** `api.md` §`Not` signature; no SPEC normative-text impact.
