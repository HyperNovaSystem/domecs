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

**Status:** resolved — 2026-04-18
**Surfaced by:** `packages/domecs/test/scheduler.test.ts` — initial draft of the reactive-system test.

**Problem.** SPEC §4 step 0 said "Clear change-detection flags" and step 8 said "Commit … for next tick's step 0", but a caller who invoked `world.markChanged` or mutated component data *between* `step()` calls (outside any system) wrote into the change-detection sets — and those writes were erased by the next `step()`'s step 0 before any system ran. Such external mutations were silently invisible to reactive systems.

**Resolution.** Adopted the buffer-and-swap design (option 2 from the original proposal), symmetric with the §2.6 event buffer:

- Engine maintains a `pending` set distinct from the live tick set, plus an `inTick` flag set true for the duration of steps 1–8.
- `addComponent`, `removeComponent`, `despawn`, `markChanged` route writes to the live set when `inTick === true` and to the pending set otherwise.
- Step 0 first clears the live set, then drains pending into it. Reactive systems at step 6 observe between-tick writes from the previous tick boundary and in-tick writes from steps 3–5 indistinguishably.

Verified by [`packages/domecs/test/scheduler.test.ts`](../packages/domecs/test/scheduler.test.ts) "observes markChanged calls made between ticks" and the change-detection filter tests in [`packages/domecs/test/query.test.ts`](../packages/domecs/test/query.test.ts).

**Spec impact.** Landed in SPEC §2.9 (buffer-and-swap rule, normative), §2.5 (cross-link), §4 step 0 (clear-then-drain wording).

---

## [F-3] `TimeState.scaledDelta` quantization at 1 ms breaks `fixedStep = 1/60`

**Status:** resolved — 2026-04-18
**Surfaced by:** `packages/domecs/test/scheduler.test.ts` — "accepts divisor rates and runs each Nth fixed step".

**Problem.** SPEC §2.7 required `scaledDelta` to be quantized to 1 ms precision for cross-machine determinism. The default `fixedStep = 1/60 ≈ 16.667 ms` rounded to 17 ms per tick. Sixty ticks of `dt = 1/60` yielded total scaled time `60 × 17 ms = 1020 ms → 61.2` fixed steps. A nominal 60 Hz physics system fired ≈61 Hz of wall-clock — a silent ~2 % rate drift, even though per-tick determinism remained intact.

**Resolution.** Adopted option 3 from the original proposal (decouple the fixed-step accumulator from `scaledDelta`):

- Engine maintains a cumulative *unquantized* scaled-time total (`totalScaledSeconds`).
- Per-tick `scaledDelta` is derived from the *difference* between the cumulative total's ms-rounded value and the previous tick's ms-rounded value — preserves the §2.7 wire-format guarantee, but the running total stays exact.
- The fixed-step driver fires until `fixedStepsFired >= floor(totalScaledSeconds / fixedStep)`, so the count of fired steps in any time window equals the unquantized truth.

Verified by [`packages/domecs/test/scheduler.test.ts`](../packages/domecs/test/scheduler.test.ts) "fires exactly N times per N seconds at fixedStep=1/60" — sixty `1/60`-second steps now fire exactly 60 fixed steps (was 61).

**Spec impact.** Landed in SPEC §2.7 (drift-free quantization rule, normative) + §3 fixed-rate-rule cross-link.

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
