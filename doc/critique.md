# DOMECS — Critical Evaluation, Reconciled Against SPEC v0.1

This file began as an adversarial reading of `README.md`. On 2026-04-17 it was re-evaluated against `SPEC.md` v0.1 and `api.md`. The original 11-point critique is reduced to a resolution table below; most objections are now baked into the spec. The live material is in *New issues*.

---

## 2. New issues surfaced during SPEC review

These were not in the README so they did not appear in the original critique. They appear now because they live in SPEC/`api.md`.

### 2.1 ~~`world.markChanged` is explicit~~ — RESOLVED (SPEC §2.9, 2026-04-17)

Closed by SPEC §2.9 "Change tracking" + Invariant I-2. Production stays proxy-free (O(1) mark append, O(1) `Changed(T)` read). Dev builds reuse the I-1 proxy to warn on **mutation-without-mark** (default `'warn'`, `'throw'` for CI) and can optionally hint on **mark-without-mutation** for optimizers. Counters + recent-offenders ring exposed at `world.diag.markChanged` for the inspector. Not hand-holdy — the contract still requires explicit marking — but bug-hunters and optimizers get loud, actionable feedback.

### 2.2 `Signal<T>` subscription shape is undefined

`World.signals` is declared in `api.md`, but the `Signal<T>` type has no subscribe/unsubscribe surface in the reference. Consumers cannot write an adapter against it as written.

*Recommend:* declare `interface Signal<T> { subscribe(fn: (e: T) => void): () => void }` (or equivalent) in `api.md`, and state that subscribers run synchronously within the tick phase that emitted the signal.

### 2.3 Signals × Invariant I-1 is unspecified

Can a subscriber stash a component reference received via `componentAdded` or read via `tickStart` and use it at `tickEnd`? The dev-mode proxy (§2.2) poisons at step 8 — does it poison signal-delivered references too? Answering "yes" implies proxy wrapping for signal payloads; "no" means signals carry data/ids only.

*Recommend:* state the rule in §2.2 or §9.4. The cheap answer is "signals carry entity id + component type only; consumers re-read via `getComponent` within the same tick." This keeps I-1 uniform.

### 2.4 `Where(T, predicate)` cannot be archetype-cached

SPEC §2.4 claims queries are archetype-cached. A value-predicate requires O(n) scan over the archetype's entities each tick — no index can satisfy it without a user-provided hash.

*Recommend:* note `Where` as O(matching-archetype-entities) in §2.4, and recommend modeling filterable state as a tag component so archetype caching applies. Otherwise users will reach for `Where` in hot paths.

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

The original load-bearing corrections — bundle size, determinism, renderer model, plugin interface — are all in SPEC v0.1 and `api.md`. Residual risk has migrated from "architecture wrong" to "contract incomplete" and now concentrates on the signal surface (§2.2–§2.3) and query-complexity honesty (§2.4). §2.1 (`markChanged`) is resolved by SPEC §2.9 + Invariant I-2. Close the signals contract before the roguelike exemplar lands, or it will calcify.
