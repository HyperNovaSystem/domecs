# DOMECS Specification Critique

Live, open critique of the v0.1 SPEC + `api.md` surface, written from the implementation side. Each entry corresponds to a finding in `findings.md`; resolved findings are summarized at the bottom for traceability and otherwise live in `findings.md` with full rationale.

The bar for an entry here is: an *open* contract or DX issue against `SPEC.md` / `api.md` that warrants a normative response. Engine bugs without spec impact go in `findings.md` only; this file is the spec-side log.

---

## 1. Open issues

*None.* The three findings opened on 2026-04-19 (F-8, F-9, F-10) all closed on 2026-04-20; see §2.

---

## 2. Resolved (link only)

The following critique points were live earlier in v0.1 development and have since been closed by SPEC normative text or `api.md` clarification. Full rationale lives in `findings.md` and the linked SPEC sections; kept here only so newcomers can trace the history.

- **`markChanged` semantics for systems.** Resolved by SPEC §2.9 + Invariant I-2.
- **`Signal<T>` shape and subscription rules.** Resolved by SPEC §2.10.
- **`Where(T, predicate)` complexity.** Resolved by SPEC §2.4 complexity note (unindexed, O(matching-archetype-entities) per tick — model hot-path filters as tag components).
- **`rateHz` vs world-level `fixedStep`.** Resolved by SPEC §3 fixed-rate rule (rateHz must divide `1/fixedStep`).
- **`Capability<K>` empty surface.** Resolved by `api.md` worked example: providers augment `Capability<K>` via TypeScript declaration merging keyed on the capability name.
- **DOM slot-collision policy.** Resolved by SPEC §5.6: mounting is exclusive, view registration is additive in registration order; use named sub-slots for stacking.
- **`reactive` debouncing semantics.** Resolved by SPEC §4 step 6: per-tick coalescing into a single invocation per system; re-triggers caused by step 6 defer to next tick.
- **`ComponentBag` string-keyed form.** Resolved by `findings.md` §F-1: `ComponentBag` is identity-keyed (Map or `[ComponentType, value]` entries); the name-keyed sugar awaits a follow-up `createWorld({ components })` registration option.
- **External `markChanged` between ticks invisible to reactive systems (F-2).** Resolved by SPEC §2.9 buffer-and-swap rule + §4 step 0 wording: between-tick writes land in a pending set and are promoted into the live set at next step 0, symmetric with §2.6 events.
- **`TimeState.scaledDelta` 1 ms quantization caused ~2 % rate drift at `fixedStep = 1/60` (F-3).** Resolved by SPEC §2.7 drift-free quantization rule + §3 fixed-rate-rule cross-link: `scaledDelta` keeps its ms quantization for wire-format determinism, but the fixed-step accumulator advances against the unquantized cumulative scaled-time total.
- **`Not(Has(X))` silently matches all entities (F-4).** Resolved 2026-04-19 by widening `Not`/`And`/`Or` signatures in `packages/domecs/src/query.ts` to accept either `ComponentType<T>` or `QueryNode`. Both `Not(Player)` and `Not(Has(Player))` now compile and run correctly. Commit `f01b939`.
- **`World.start()/stop()` declared but not implemented (F-5).** Resolved 2026-04-19. `start()` is a thin rAF driver with `dtClampMs` + `pauseOnHidden` options; `stop()` cancels and detaches the visibility listener. Dashboard exemplar migrated off hand-rolled rAF.
- **`world.step(0)` produces `scaledDelta = 0`, NaN-hazards derivative consumers (F-6).** Resolved 2026-04-19. `step(0)` is a heartbeat (no system execution, no tick advance); `dt > 0` floors the per-tick quantized ms at 1 to prevent sub-ms divisions.
- **`spawn([[T, v], …])` forces `as never` casts (F-7).** Resolved 2026-04-19. Introduced `entry<T>(t, v)` helper + widened `ComponentBag` to accept `ComponentEntry<any>[]`. All exemplars migrated.
- **`defineEvent` type/runtime mismatch; same-name collision (F-8).** Resolved 2026-04-20. `EventType<T>` now carries a `[eventTag]: unique symbol` populated honestly by `defineEvent` (no `as unknown as` cast); the bus dispatches via `Map<symbol, …>` keyed on `type[eventTag]`, so two `defineEvent('X')` calls produce isolated buckets. Pinned by collision regression in `packages/domecs/test/events.test.ts`.
- **No referential-integrity story for inter-entity component fields (F-9).** Resolved 2026-04-20 by SPEC §2.10 normative despawn ordering rule + `api.md` cross-ref scrub pattern. The required `signals.entityDespawned` already existed in `world.ts`; the gap was normative — SPEC now pins the order (`componentRemoved` per type → reclaim → `entityDespawned`) so subscribers observe a post-reclaim world (`world.has(id, T) === false`). First-class `EntityRef<T>` deferred. Pinned by ordering test in `packages/domecs/test/world.basic.test.ts`.
- **No public entity-iteration helper for a single component type (F-10).** Resolved 2026-04-20 by adding `world.entitiesWith<T>(type): Iterable<{id, value: T}>` in `packages/domecs/src/world.ts` — a generator that walks the type's store directly, cheaper than `query(Has(type))` + per-entity `getComponent`. Used in the F-9 cross-ref scrub example in `api.md`.

---

## 3. Verdict

All v0.1 critique findings (F-2/F-3/F-4/F-5/F-6/F-7/F-8/F-9/F-10) are closed. The 2026-04-19 trio surfaced from the restaurant exemplar build all landed on 2026-04-20:

- **F-8** — identity-keyed event dispatch removes the silent same-name collision and the type/runtime mismatch in one change.
- **F-9** — the load-bearing one (real impossible-state bug `seated = -4` in the restaurant exemplar). The signal pre-existed; the normative ordering rule + canonical scrub pattern give consumers a documented integrity path. First-class `EntityRef<T>` remains deferred for a future revision.
- **F-10** — small ergonomic helper that makes the F-9 scrub pattern a one-liner.

No open critique items against v0.1 at this time.
