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

---

## 3. Verdict

The original load-bearing v0.1 critique is closed. One open item remains — a query-language surface bug with a clear normative fix (§1.1, F-4). It is scoped to a single SPEC section and does not block the v0.1 alpha milestone, but should land before v0.1 is published as stable. F-2 (markChanged scoping) and F-3 (quantization drift) closed 2026-04-18 with normative SPEC text and shipped engine implementations.
