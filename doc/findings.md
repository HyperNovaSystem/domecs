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

---

## [F-5] `World.start()` / `World.stop()` declared in api.md but not implemented

**Status:** open — 2026-04-19
**Surfaced by:** `example/dashboard/src/main.ts` — realtime loop setup; previously noted informally by roguelike exemplar.

**Problem.** `api.md` §`World` lists `start(): void` and `stop(): void` as first-class lifecycle methods, and the bottom-of-file worked example ends `world.start()`. The runtime `World` interface in `packages/domecs/src/world.ts` exposes `step(dt)` and `stepN(n, dt)` only — no `start`/`stop`. Both browser exemplars (roguelike, dashboard) have to roll their own `requestAnimationFrame` loop with wall-clock `dt` computation, which is boilerplate every consumer will duplicate and mis-tune (dt clamping, first-frame priming, visibility-change pauses).

**Proposed resolution.** Either (a) implement `start()/stop()` as a thin rAF driver owned by the engine (clamp dt to a configurable max, pause on `document.hidden`, honour `time.scale === 0` as "paused without stopping"), or (b) remove them from `api.md` and explicitly place the realtime loop in user-land. Option (a) is preferred: it eliminates a footgun (mis-computed dt spike on tab-return freezes fixed-step physics) and gives the engine one natural place to emit a `tickStart` signal from user-perspective time. If (a), `start()` returns a handle whose `stop()` cancels the rAF; subsequent `start()` resumes with a fresh reference time.

**Spec impact.** `api.md` §`World` lifecycle block — either add normative semantics for the driver (dt-clamp, visibility-pause, resume behaviour) or delete the two lines and amend the worked example.

---

## [F-6] `world.step(0)` yields `time.scaledDelta === 0`, NaN-hazards derivative consumers

**Status:** open — 2026-04-19
**Surfaced by:** `example/dashboard/src/sim.ts` `pid-controller` — `derivative = (error - lastError) / dt`.

**Problem.** A common realtime-loop pattern is `world.step(0)` to prime derived state before starting the rAF. In the F-3 drift-free scheduler, `step(0)` pushes `totalScaledSeconds` by 0, so the ms-quantized `scaledDelta` is 0. Any tick-schedule system that divides by `time.scaledDelta` (PID, smoothing filters, per-second rate estimators) silently produces `Infinity`/`NaN`. The dashboard PID had to guard with `const dt = world.time.scaledDelta || 1/60` — a workaround every controller author will re-derive.

Separately: even without `step(0)`, the ms-quantization can produce a 0 for a tick whose `dt < 0.5 ms` (very high-rate animation frames at 1000 Hz+), so the hazard is not confined to priming.

**Proposed resolution.** Two options, not mutually exclusive:

1. **`step(0)` is a no-op** (normative in SPEC §4). It runs neither event/tick/fixed/reactive phases; `time.tick` does not advance; change-detection buffers do not swap. Rationale: the user's intent with `step(0)` is "read current state", not "advance time by zero", and no system can do useful work with `dt = 0`.
2. **Floor `scaledDelta` at 1 ms** whenever a tick fires (i.e., `dtMs = Math.max(1, newQuantizedMs - lastQuantizedElapsedMs)`). Preserves wire-format ms-alignment; eliminates divide-by-zero for any consumer.

Preferred combination: (1) for the priming case — cleaner invariant — plus (2) as a backstop for pathological high-rate loops.

**Spec impact.** SPEC §4 (define `step(0)` explicitly) and SPEC §2.7 (add positive-floor rule to the quantization semantics).

---

## [F-7] `world.spawn([[ComponentType, value], …])` forces `as never` casts at call sites

**Status:** open — 2026-04-19
**Surfaced by:** `example/roguelike/src/game.ts` (initial workaround) and `example/dashboard/src/sim.ts` — every spawn tuple literal.

**Problem.** `ComponentBag` entries carry a `ComponentType<T>` alongside a `T` value. The `spawn` signature accepts `ComponentBag = ReadonlyArray<readonly [ComponentType<unknown>, unknown]>` (per F-1). When a caller writes a heterogeneous array of tuples — `[[Position, {x:0,y:0}], [Health, {hp:10}]]` — TS infers the array type as `(readonly [ComponentType<Position> | ComponentType<Health>, {x,y} | {hp}])[]`, which is *not* assignable to the parameter's `ComponentType<unknown>` element because `ComponentType<T>` is invariant in `T`. The working-around every exemplar adopts is `[Position as never, {…}]` at each entry — ugly, untyped, and silences any genuine value-shape mismatch.

**Proposed resolution.** Redeclare the spawn signature to use an existentially-quantified entry type:

```ts
type ComponentEntry = { [K in keyof any]: readonly [ComponentType<K>, K] }[keyof any]
// or, more precisely, a tagged-tuple helper:
type Entry<T = unknown> = readonly [ComponentType<T>, T]
interface World {
  spawn(components?: ReadonlyArray<Entry> | ReadonlyMap<ComponentType<unknown>, unknown>): Entity
}
```

The goal: the value position's `T` is tied to the type position's `T` *within each entry*, while the array itself is heterogeneous. A small helper — `entry<T>(t: ComponentType<T>, v: T): Entry<T>` — lets call sites write `spawn([entry(Position, {x:0,y:0}), entry(Health, {hp:10})])` with full inference and no casts. The bare-tuple form still works but may need an explicit `as const` to preserve the tuple-literal shape.

**Spec impact.** `api.md` §`spawn` + §`ComponentBag` — adopt the `Entry<T>` tagged-tuple form, document the `entry()` helper, and note that `as const` (or the helper) is required for inference.
