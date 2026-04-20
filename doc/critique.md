# DOMECS Specification Critique

Live, open critique of the v0.1 SPEC + `api.md` surface, written from the implementation side. Each entry corresponds to a finding in `findings.md`; resolved findings are summarized at the bottom for traceability and otherwise live in `findings.md` with full rationale.

The bar for an entry here is: an *open* contract or DX issue against `SPEC.md` / `api.md` that warrants a normative response. Engine bugs without spec impact go in `findings.md` only; this file is the spec-side log.

---

## 1. Open issues

### 1.1 `defineEvent` runtime object doesn't match the declared type; dispatch is name-keyed (F-8)

**Where it bites.** Surfaced 2026-04-19 by the restaurant exemplar (`example/restaurant/src/sim.ts`) — four `defineEvent` declarations + reading `packages/domecs/src/events.ts` while debugging dispatch. Not a runtime failure today; latent risk that compounds as the event surface grows.

**Root cause.** `EventType<T>` is declared in `events.ts:3-7` as `{ readonly name: string; readonly [__eventTag]: symbol; readonly __t?: T }` — a unique-symbol property key meant to provide nominal typing per event. The factory at `events.ts:9-11` returns `{ name, __tag: Symbol(name) }` — a *string-keyed* `__tag` field — and casts through `unknown` to silence the type system. The promised symbol slot is missing at runtime; the constructed `Symbol(name)` is dead state because dispatch (`events.ts:37,41,53,59,73`) only ever reads `type.name`.

**Why a critique-grade issue, not just a bug.** Three distinct spec-surface flaws line up:

1. **The type lies about identity.** A unique-symbol property key in TypeScript is the canonical idiom for nominal typing — readers reasonably infer events are identity-keyed. They are not.
2. **`as unknown as` hides the construction error.** The cast was added to make the wrong-shape literal compile. It's the smell that made the bug invisible. Any spec that relies on a property the impl never writes is a spec drift waiting to happen.
3. **Name-keyed dispatch has no documented collision policy.** Two `defineEvent<A>('Reset')` calls — common in re-export chains or polyrepos — share a single dispatch bucket. Subscribers of one type receive payloads of the other; TS doesn't catch it because both views see `EventType<A>` and `EventType<B>` as nominally distinct (the symbol promise!) even though dispatch merges them.

**Proposed normative fix.** SPEC §2.6 should pick one and commit:

- **Option A (preferred):** Make dispatch identity-keyed via a real symbol stored on the type object. Export the `__eventTag` symbol from the events module, fix the factory to set the property at the symbol key, key the bus's internal Maps by `EventType` reference (or by the symbol). Drop the `as unknown as` cast — the construction now matches the type.
- **Option B:** Drop the symbol from `EventType<T>` entirely. Document `name` as the dispatch key and require globally unique names. Add a dev-build assertion in `defineEvent` that throws on second registration of an existing name.

Either option closes the hole; A keeps the type honest and makes intra-process collisions impossible.

**Status.** Open. Tracked as `findings.md` §F-8. Workaround until merged: name events with package-qualified strings (`'restaurant:Reset'`, `'dashboard:Reset'`).

### 1.2 No referential-integrity story for inter-entity component fields (F-9)

**Where it bites.** Surfaced 2026-04-19 by the restaurant exemplar phantom-customer regression. Browser smoke test at tick 4522 showed `seated = -4` (impossible counter) because a queued customer was bound to a table by the dispatcher (`t.customerId = queuedId; c.tableId = freeTable`), then despawned by the patience system before seating completed. The table ran the rest of its lifecycle pointing at a dead customer id; `served++` and `walked++` both fired for the same human.

**Root cause.** Components carry cross-entity references as bare `number | null` fields. `world.despawn(id)` reclaims the entity but does not notify any component that pointed to it. The reverse-index — "who referenced entity 17?" — does not exist. A despawn leaves dangling pointers in every other component, and the engine offers no idiom to keep them in sync.

**Why a critique-grade issue, not just a bug.** Bare-id references are the *only* documented way to model multi-entity relationships in DOMECS. The pattern is universal — any sim with pickups, vehicles holding passengers, sockets holding connectors, parent/child hierarchies — and the engine punts on the consistency problem entirely. Three spec-surface gaps:

1. **SPEC §2.6 is silent on despawn ordering vs cross-references.** Consumers can't know whether handlers run before or after data reclaim, or whether despawning during another despawn handler is safe.
2. **No first-class `EntityRef` type.** Every consumer rolls their own discipline, every consumer gets it slightly wrong eventually. The phantom-customer bug is the canonical failure mode.
3. **No built-in cleanup signal.** `signals.entityDespawned` would be a one-line addition that lets consumers centralise integrity logic. Its absence forces per-system guards.

**Proposed normative fix.** SPEC §2.6 should normatively define one of:

- **Lightweight (preferred for v0.1):** `signals.entityDespawned: Signal<Entity>` that fires once per despawn, after data reclaim is committed but before the next system runs. Consumers register one global listener that scrubs cross-refs. No engine-side reverse-indexing cost.
- **Heavier (post-v0.1):** First-class `EntityRef<T>` field type tracked by the engine. On despawn, all `EntityRef`s pointing at the dying id are nulled before any handler runs.

Either way, SPEC §2.6 must commit to a despawn-handler ordering rule so consumers can reason about what state they'll see.

**Status.** Open. Tracked as `findings.md` §F-9. Workaround until merged: gate cross-component reads on a state-flag held by the *referent*, not on "field is non-null". The patience-skip fix in `example/restaurant/src/sim.ts:128-134` is the canonical pattern.

### 1.3 No public entity-iteration helper (F-10)

**Where it bites.** Surfaced 2026-04-19 by `example/restaurant/test/sim.test.ts` `countCustomersByState`. The test had to write `world.query({ kind: 'has', type: Customer })` because `Has(Customer)` *reads* as a system-declaration combinator, not an inspection idiom — and `world.componentTypes()` looks like the iteration helper but isn't.

**Why a (small) critique-grade issue.** Less load-bearing than 1.1/1.2 but still a spec-surface issue: the API exposes pieces (`world.query`, `Has`, `world.componentTypes`) that the user must compose for the most common test/inspection pattern, and the closest-named method (`componentTypes`) returns the wrong thing. Either rename `componentTypes` to disambiguate or add a one-liner `world.entitiesWith(T)` shortcut. SPEC impact is in `api.md` only; no normative-text change.

**Status.** Open. Tracked as `findings.md` §F-10.

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

---

## 3. Verdict

The original v0.1 critique (F-2/F-3/F-4/F-5/F-6/F-7) is closed. Three new open items surfaced 2026-04-19 from the restaurant exemplar build:

- **§1.1 (F-8)** — `defineEvent` type/runtime mismatch; latent collision risk. Fix is small but normative.
- **§1.2 (F-9)** — no referential-integrity story for inter-entity component fields. Affects every multi-entity sim. Lightweight fix (`signals.entityDespawned` + ordering rule) recommended for v0.1; first-class `EntityRef<T>` deferred.
- **§1.3 (F-10)** — minor `api.md` ergonomics gap; one-liner helper.

§1.2 is the load-bearing one — it surfaced as a real impossible-state bug in the restaurant exemplar (`seated = -4`) before being patched in the consumer. It should land before v0.1 is published as stable. §1.1 and §1.3 are both quick wins that should accompany it.
