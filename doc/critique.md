# DOMECS Specification Critique

Live, open critique of the v0.1 SPEC + `api.md` surface, written from the implementation side. Each entry corresponds to a finding in `findings.md`; resolved findings are summarized at the bottom for traceability and otherwise live in `findings.md` with full rationale.

The bar for an entry here is: an *open* contract or DX issue against `SPEC.md` / `api.md` that warrants a normative response. Engine bugs without spec impact go in `findings.md` only; this file is the spec-side log.

---

## 1. Open issues

### 1.1 `Not(Has(X))` silently matches all entities (F-4)

**Where it bites.** Surfaced 2026-04-18 by `example/roguelike/src/game.ts` `enemyCount` helper, which read `world.query(And(Has(Actor), Not(Has(Player))))`. Two of ten roguelike integration tests failed because every `Actor` (including the player) entered the result set.

**Root cause.** `api.md` declares `Not<T>(t: ComponentType<T>): QueryNode`. `Not` takes a *component*, never a *query node*. But `Not` reads as a predicate combinator — the way `And`/`Or` do — so the natural phrasing `Not(Has(Player))` slips past the type system in any call path where the surrounding code erases the precise return type of `Has`. In the failing call site the value flowed through a parameter typed `QueryShorthand`, which already accepts `QueryNode`; `tsc` did not reject it. At runtime `evalStructural` reads `.type.name` off the inner `QueryNode`, gets `undefined`, and `!types.has(undefined)` is `true` for every entity. The query silently returns everything.

**Why a critique-grade issue, not just a bug.** Three independent spec-surface flaws line up to make this happen:

1. **Naming carries a promise the signature breaks.** `And` / `Or` accept `QueryNode` and compose. A user reading the API legitimately expects `Not` to compose the same way.
2. **No symmetry rule in §2.4.** SPEC §2.4 lists the combinators flatly without saying which are *unary node combinators* (`Not`) and which are *component shortcuts* (`Has`, `Changed`, `Added`, `Removed`, `Where`). The implementation distinction (`type` vs `child` on the node) is invisible at the spec level, so neither readers nor implementers know which contract is correct.
3. **No runtime guard.** `evalStructural` does a property read against `.type.name` with no assertion that `.type` is in fact a `ComponentType`. A wrong-shape node degrades silently to a constant-true predicate — the worst possible failure mode for a query language.

**Proposed normative fix.** SPEC §2.4 should split the combinators into two named classes:

- **Component shortcuts** (`Has`, `Changed`, `Added`, `Removed`, `Where`) accept a `ComponentType` and produce a leaf node carrying that type.
- **Predicate combinators** (`Not`, `And`, `Or`) accept other `QueryNode`s and compose them.

`Not` joins `And`/`Or` as a node combinator. By convention and to match user intuition, **`Not` (and the n-ary combinators) also accept a bare `ComponentType` as a one-arg shortcut for `Has(T)`.** That is: `Not(Player) ≡ Not(Has(Player))`. Both compile, both run correctly, and the documented shape becomes the explicit one.

Concretely: change the `not` node shape from `{ kind: 'not'; type: ComponentType }` to `{ kind: 'not'; child: QueryNode }`; widen the `Not` signature to `Not(arg: ComponentType<T> | QueryNode)`; teach `evalStructural`/`evalEntity` to recurse into `child`. Engine implementations MUST reject any node whose payload does not match its declared `kind` (assert at compile time via the discriminated union; assert at runtime in dev builds).

**CI hygiene.** The fact that this slipped through TypeScript means the workspace `test` script does not run `tsc --noEmit`. Adding it would have caught the original miswrite at the call site. Recommend adding it to the alpha CI loop independent of the §2.4 widening.

**Status.** Open. Tracked as Reqall issue #1802 and `findings.md` §F-4. Workaround until merged: write `Not(Player)` (the documented shape), never `Not(Has(Player))`.

### 1.2 External `markChanged` between ticks is invisible to reactive systems (F-2)

**Where it bites.** Surfaced 2026-04-18 by the initial draft of the reactive-system test (`packages/domecs/test/scheduler.test.ts`). A caller who mutates component data and calls `world.markChanged` *between* `world.step()` calls — outside any system — writes into the change-detection sets, but those writes are wiped by the next tick's step 0 before any system can read them.

**Why a critique-grade issue.** SPEC §4 step 0 ("Clear change-detection flags") and §4 step 8 ("Commit … for next tick's step 0") together describe the within-tick scoping. SPEC §4 step 6 says reactive systems "see queries that changed in steps 3–5." Read together, between-tick mutations are silently dropped. But `markChanged` is a public method on the `World` interface with no constraint on when it may be called, and SPEC §2.5 does not say "calls outside a running system are erased before the next tick." A user who reads the surface area without reading every step in §4 has no way to know.

This is *probably* the intended ECS discipline — mutate inside systems, not between them — but the spec must say so explicitly, or the implementation must honor between-tick marks. Neither is true today.

**Proposed normative fix.** Two viable paths:

1. **Document and enforce the discipline.** Add a normative note to SPEC §2.5 and §4 step 0: *Mutations performed outside a running system are not observable to reactive systems. `markChanged` calls outside any system MAY be dropped at the start of the next tick.* Optionally add a dev-mode warning when `markChanged` is called with no system on the stack.
2. **Buffer-and-swap symmetric with events.** SPEC §2.6 buffers events emitted between ticks and flushes them at step 1 of the next tick — between-tick emits survive. Apply the same rule to change-detection sets: step 0 swaps the live set with a fresh empty one, so externally-set marks are observed by the next tick's step-3-through-6 systems exactly as if they had been set at step 0 by an internal source.

Option 2 preserves the plural-worlds axiom without coupling to dev-mode telemetry, and matches the existing event semantics. Option 1 is safer (less behavior change) but adds a normative restriction that did not exist before. Recommend option 2; the symmetry argument is strong.

**Status.** Open. `findings.md` §F-2. No engine code change pending until SPEC chooses a path.

### 1.3 `TimeState.scaledDelta` 1 ms quantization causes ~2% rate drift at `fixedStep = 1/60` (F-3)

**Where it bites.** Surfaced 2026-04-18 by `packages/domecs/test/scheduler.test.ts` "accepts divisor rates and runs each Nth fixed step". With `scale = 1` and the documented default `fixedStep = 1/60 ≈ 16.667 ms`, `quantizeMs` rounds to 17 ms per tick. Sixty ticks of `dt = 1/60` yield 60 × 17 ms = 1020 ms of scaled time → 1020 ms / (1/60 s) = 61.2 fixed steps per *intended* second. A "60 Hz physics" system actually fires at ≈61.2 Hz of wall clock.

**Why a critique-grade issue.** The drift is silent. Per-tick determinism is fine — every world reproducing the same input sequence runs the same number of fixed steps. But the *rate contract* — "this system fires `rateHz` times per second" — does not hold. The 1 ms quantization rule in SPEC §2.7 was added to make `scaledDelta` cross-machine deterministic; it accidentally entangles the fixed-step scheduler in §3 / §4 step 3 with the same quantization, where exact rate matters more than wire-format compactness.

**Proposed normative fix.** Three options, all in SPEC §2.7 + §3:

1. **Pick a ms-exact default `fixedStep`.** `1/50 = 20 ms` and `1/100 = 10 ms` are exact; `1/60` is not. Make `1/50` the default; document `1/60` as opt-in with a warning that aggregate rates may drift up to ~2%.
2. **Quantize to µs instead of ms.** Removes the drift; tightens the snapshot wire format slightly.
3. **Compute fixed-step accumulation against integer ms since world start, independent of `scaledDelta`.** Preserves §2.7 user-visible quantization while removing scheduler drift entirely. Recommended.

Option 3 is the smallest behavior change for users: `TimeState.scaledDelta` keeps its 1 ms quantization, the snapshot wire format does not change, and the only thing that moves is the fixed-step accumulator's source of truth (from `scaledDelta` to `Math.round(elapsed_ms)`).

**Status.** Open. `findings.md` §F-3. Tests currently sidestep the issue by using `fixedStep = 1/50`.

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

---

## 3. Verdict

The original load-bearing v0.1 critique is closed. Three open items remain — one is a query-language surface bug with a clear normative fix (§1.1, F-4), the other two are previously-known design ambiguities that the v0.1 implementation work made concrete (§1.2 markChanged scoping, §1.3 quantization drift). All three are scoped to a single SPEC section each and do not block the v0.1 alpha milestone, but should land before v0.1 is published as stable.
