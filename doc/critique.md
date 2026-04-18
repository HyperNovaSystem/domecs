# DOMECS — Critical Evaluation, Reconciled Against SPEC v0.1

This file began as an adversarial reading of `README.md`. On 2026-04-17 it was re-evaluated against `SPEC.md` v0.1 and `api.md`. The original 11-point critique is reduced to a resolution table below; most objections are now baked into the spec. The live material is in *New issues*.

---

## 2. New issues surfaced during SPEC review

These were not in the README so they did not appear in the original critique. They appear now because they live in SPEC/`api.md`.

### ~~2.4 `Where(T, predicate)` cannot be archetype-cached~~ — RESOLVED (SPEC §2.4, 2026-04-18)

Closed by SPEC §2.4 "Complexity (normative)": indexed operators (`Has` / `Not` / `Or` / `Added` / `Removed` / `Changed`) are O(matching-entities) amortized via the archetype cache; `Where(T, predicate)` is explicitly called out as unindexed, O(matching-archetype-entities) per tick, and users are directed to model filterable state as a tag component so archetype caching applies.  The "reach for `Where` in hot paths" trap is now labeled in the spec itself.

### 2.5 `rateHz` vs world-level `fixedStep`

`api.md` `SystemDef.rateHz` implies per-system fixed rates; SPEC §4 step 3 runs *the* fixed accumulator against `TimeState.fixedStep`. If two fixed systems have `rateHz: 60` and `rateHz: 10`, do they share an accumulator (and the 10 Hz one simply runs every 6th step), or do they each carry their own accumulator?

*Recommend:* pick one. "Shared accumulator + integer divisor" is simpler, preserves the single `fixedStep` story, and lines up with §8 determinism. Document the rule; reject non-divisor rates at registration time.

### 2.6 `Capability<K>` surface is empty

`api.md` declares `interface Capability<K>` as a marker; SPEC §9.3 says providers expose surfaces. No example shows how. The intent is module augmentation, but unwritten intent is a contract smell.

*Recommend:* ship one worked example in `api.md` (e.g., `@domecs/physics` augments `Capability<'spatial-index'>` with `query(bounds): Entity[]`) so third-party plugin authors have a template.

### 2.7 Slot-collision policy unspecified

`mountDOM` accepts a `slots` record and `views` keyed to slot names. If two plugins each register a view targeting `slot: 'chrome'`, does the renderer append, replace, or throw? SPEC §5.6 lists the standard slots but not conflict semantics.

*Recommend:* append (multiple views per slot are already legal per §5.1 entity→multi-view), and state it in §5.6. Throw only on duplicate slot *mounting*, not on view registration.

### 2.8 `reactive` debouncing is underspecified

SPEC §3 calls reactive systems "debounced to tick" and §4 step 6 runs them. Unstated: does the debounce coalesce multiple hits per tick (expected: yes); and if a reactive system mutates state that would re-trigger a reactive system earlier in the priority order, does it fire this tick or next?

*Recommend:* state that (a) multi-hit within a tick coalesces to one invocation per reactive system with a combined delta, and (b) re-triggers caused by step 6 execution are deferred to the next tick's step 6. This matches the event-buffering rule in §2.6 and keeps the tick free of fixed-point iteration.

---

## 3. Verdict

The original load-bearing corrections — bundle size, determinism, renderer model, plugin interface — are all in SPEC v0.1 and `api.md`. Residual risk has migrated from "architecture wrong" to "contract incomplete" and now concentrates on scheduling arithmetic (§2.5), capability-surface conventions (§2.6), renderer slot semantics (§2.7), and reactive debouncing (§2.8). §2.1 (`markChanged`) is resolved by SPEC §2.9 + Invariant I-2; §2.2 (`Signal<T>` shape) and §2.3 (signals × I-1) are both closed by SPEC §2.10; §2.4 (`Where` complexity) is closed by the SPEC §2.4 complexity note. The remaining open items are mechanical — none of them block the roguelike exemplar, but §2.5 (`rateHz` vs `fixedStep`) should land before a second `fixed` system is written.
