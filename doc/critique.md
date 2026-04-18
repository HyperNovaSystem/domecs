# DOMECS — Critical Evaluation, Reconciled Against SPEC v0.1

This file began as an adversarial reading of `README.md`. On 2026-04-17 it was re-evaluated against `SPEC.md` v0.1 and `api.md`. The original 11-point critique is reduced to a resolution table below; most objections are now baked into the spec. The live material is in *Still open* and *New issues*.

---

## 2. Still open from the original read

### 2.1 Snapshot cost at large N

SPEC §7.2 defers the *write* off-tick, but `snapshot()` itself remains a main-thread, O(entities × components) structural clone. At the 50k-entity scale flagged in the original §6, the sync snapshot is still the long pole. Candidates: archetype-chunked snapshotting, a streaming `snapshot(entityRange)` variant, or a published per-tick budget ceiling that autosave must respect. Ring-buffer diff snapshots (§7.4) do not solve this — they are about time-travel, not slot writes.

---

## 3. New issues surfaced during SPEC review

These were not in the README so they did not appear in the original critique. They appear now because they live in SPEC/`api.md`.

### 3.1 `world.markChanged` is explicit

`api.md` Quick-start note states: *"`world.markChanged` is explicit. Automatic change-detection via `$state` proxies is available in the Svelte adapter; vanilla requires the explicit mark so the core stays proxy-free and worker-ready."*

Consequence: `Changed(T)` query correctness depends on caller discipline in vanilla and React paths. Miss a `markChanged` call and a dependent reactive system silently no-ops. This is an ergonomics regression vs Svelte and a correctness footgun outside it.

*Recommend:* add a dev-mode write-trap that wraps component stores in a proxy (reusing the I-1 machinery) and warns on mutation-without-mark, or downgrade `Changed` to "best-effort outside the Svelte adapter" and say so in §2.4.

### 3.2 `Signal<T>` subscription shape is undefined

`World.signals` is declared in `api.md`, but the `Signal<T>` type has no subscribe/unsubscribe surface in the reference. Consumers cannot write an adapter against it as written.

*Recommend:* declare `interface Signal<T> { subscribe(fn: (e: T) => void): () => void }` (or equivalent) in `api.md`, and state that subscribers run synchronously within the tick phase that emitted the signal.

### 3.3 Signals × Invariant I-1 is unspecified

Can a subscriber stash a component reference received via `componentAdded` or read via `tickStart` and use it at `tickEnd`? The dev-mode proxy (§2.2) poisons at step 8 — does it poison signal-delivered references too? Answering "yes" implies proxy wrapping for signal payloads; "no" means signals carry data/ids only.

*Recommend:* state the rule in §2.2 or §9.4. The cheap answer is "signals carry entity id + component type only; consumers re-read via `getComponent` within the same tick." This keeps I-1 uniform.

### 3.4 `Where(T, predicate)` cannot be archetype-cached

SPEC §2.4 claims queries are archetype-cached. A value-predicate requires O(n) scan over the archetype's entities each tick — no index can satisfy it without a user-provided hash.

*Recommend:* note `Where` as O(matching-archetype-entities) in §2.4, and recommend modeling filterable state as a tag component so archetype caching applies. Otherwise users will reach for `Where` in hot paths.

### 3.5 `rateHz` vs world-level `fixedStep`

`api.md` `SystemDef.rateHz` implies per-system fixed rates; SPEC §4 step 3 runs *the* fixed accumulator against `TimeState.fixedStep`. If two fixed systems have `rateHz: 60` and `rateHz: 10`, do they share an accumulator (and the 10 Hz one simply runs every 6th step), or do they each carry their own accumulator?

*Recommend:* pick one. "Shared accumulator + integer divisor" is simpler, preserves the single `fixedStep` story, and lines up with §8 determinism. Document the rule; reject non-divisor rates at registration time.

### 3.6 `Capability<K>` surface is empty

`api.md` declares `interface Capability<K>` as a marker; SPEC §9.3 says providers expose surfaces. No example shows how. The intent is module augmentation, but unwritten intent is a contract smell.

*Recommend:* ship one worked example in `api.md` (e.g., `@domecs/physics` augments `Capability<'spatial-index'>` with `query(bounds): Entity[]`) so third-party plugin authors have a template.

### 3.7 Slot-collision policy unspecified

`mountDOM` accepts a `slots` record and `views` keyed to slot names. If two plugins each register a view targeting `slot: 'chrome'`, does the renderer append, replace, or throw? SPEC §5.6 lists the standard slots but not conflict semantics.

*Recommend:* append (multiple views per slot are already legal per §5.1 entity→multi-view), and state it in §5.6. Throw only on duplicate slot *mounting*, not on view registration.

### 3.8 `reactive` debouncing is underspecified

SPEC §3 calls reactive systems "debounced to tick" and §4 step 6 runs them. Unstated: does the debounce coalesce multiple hits per tick (expected: yes); and if a reactive system mutates state that would re-trigger a reactive system earlier in the priority order, does it fire this tick or next?

*Recommend:* state that (a) multi-hit within a tick coalesces to one invocation per reactive system with a combined delta, and (b) re-triggers caused by step 6 execution are deferred to the next tick's step 6. This matches the event-buffering rule in §2.6 and keeps the tick free of fixed-point iteration.

---

## 4. Verdict

The original load-bearing corrections — bundle size, determinism, renderer model, plugin interface — are all in SPEC v0.1 and `api.md`. Residual risk has migrated from "architecture wrong" to "contract incomplete" and concentrates in three areas: change-tracking ergonomics (`markChanged`, §3.1), the signal surface (§3.2–§3.3), and query-complexity honesty (§3.4). Close those three before the roguelike exemplar lands, or they will calcify.
