# DOMECS — Critical Evaluation, Reconciled Against SPEC v0.1

This file began as an adversarial reading of `README.md`. On 2026-04-17 it was re-evaluated against `SPEC.md` v0.1 and `api.md`. The original 11-point critique is reduced to a resolution table below; most objections are now baked into the spec. The live material is in *New issues*.

---

## 2. New issues surfaced during SPEC review

These were not in the README so they did not appear in the original critique. They appear now because they live in SPEC/`api.md`.

### ~~2.5 `rateHz` vs world-level `fixedStep`~~ — RESOLVED (SPEC §3 "Fixed-rate rule", 2026-04-18)

Closed by SPEC §3 "Fixed-rate rule (normative)": all `fixed` systems share the single world-level accumulator driven by `TimeState.fixedStep`; `rateHz` is a **subsampling divisor** over that shared step, required to satisfy `(1/fixedStep) % rateHz === 0`. Non-divisor rates are rejected at `world.system(...)` registration time. This keeps step 3 fully determined by a single accumulator and lines up with §8 determinism.

### ~~2.6 `Capability<K>` surface is empty~~ — RESOLVED (api.md Capability surface convention, 2026-04-18)

Closed by the worked example added to `api.md` alongside the `Capability<K>` declaration: providers augment the `Capability<K>` interface via TypeScript declaration merging, keyed on the capability name via conditional types. The `@domecs/physics` / `spatial-index` example shows the full shape — module augmentation in the provider package, typed consumer calls through `world.capability(name)`. Single-provider-per-name is stated; dependency ordering via the plugin DAG is stated.

### ~~2.7 Slot-collision policy unspecified~~ — RESOLVED (SPEC §5.6, 2026-04-18)

Closed by SPEC §5.6 "Slot-collision policy (normative)": slot *mounting* is exclusive (second `mountDOM` root to the same name throws); view *registration* is additive — views from any number of plugins targeting the same slot append in registration order. Plugins that want stacking discipline use named sub-slots (`chrome:menu`, `chrome:toasts`) rather than racing on a shared name.

### ~~2.8 `reactive` debouncing is underspecified~~ — RESOLVED (SPEC §4 step 6, 2026-04-18)

Closed by SPEC §4 step 6 "Debouncing rule (normative)": multi-hit mutations within a tick coalesce into **one** invocation per reactive system with a combined delta (union of added/removed/changed sets across steps 3–5); a reactive system sees each entity at most once per tick. Re-triggers caused by step 6 execution are **deferred to the next tick's step 6** — no fixed-point iteration within a tick. Matches the event-buffering rule in §2.6.

---

## 3. Verdict

The original load-bearing corrections — bundle size, determinism, renderer model, plugin interface — are all in SPEC v0.1 and `api.md`. All eight new issues surfaced during the 2026-04-17 SPEC review are now closed as of 2026-04-18: §2.1 (`markChanged`) → SPEC §2.9 + Invariant I-2; §2.2 (`Signal<T>` shape) and §2.3 (signals × I-1) → SPEC §2.10; §2.4 (`Where` complexity) → SPEC §2.4 complexity note; §2.5 (`rateHz` vs `fixedStep`) → SPEC §3 fixed-rate rule; §2.6 (`Capability<K>` surface) → api.md worked example; §2.7 (slot collision) → SPEC §5.6 slot-collision policy; §2.8 (reactive debouncing) → SPEC §4 step 6 debouncing rule. The SPEC v0.1 contract is now complete against this critique; remaining work is implementation (roguelike exemplar) and the two still-open items that were never contract issues — dev-only HMR ergonomics and large-N snapshot cost — both tracked separately.
