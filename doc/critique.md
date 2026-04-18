# DOMECS — Critical Evaluation of the Proposal

This is an adversarial reading of `README.md` as of 2026-04-17. The goal is to find the claims that are load-bearing, the claims that are wishful, and the claims that are internally inconsistent — *before* any code is written to defend them.

---

## 1. The thesis is strong

> "The DOM already solves layout, text, input, accessibility, and scaling."

This is correct and it is the single most important sentence in the README. Any game genre whose hard problem is *"compose a huge, coherent, responsive, accessible UI over a live simulation"* — management sim, roguelike inventory, visual novel, board game, dashboard, editor — is fighting the wrong battle on canvas. DOMECS is right to lean here.

However, the thesis has **two hidden dependencies** the README does not acknowledge:

1. **Style recalc, not compositing, is usually the bottleneck.** "Sprites are `<div>`s with `background-image` + `transform`" is only GPU-composited if the mutation is confined to `transform` and `opacity`. Toggling classes, changing `background-position` for frame animation, or mutating any layout-affecting property (width, z-index, `display`) drops the element out of the compositor fast-path. The renderer spec must make this policy explicit.
2. **DOM scales with *visible* elements, not *entities*.** A management sim can easily have 20,000 entities but only render 200 at a time. The README implies a 1:1 entity↔element mapping via `data-entity="…"`. That is wrong for two-thirds of the target genres. The renderer must support **unrendered entities** as a first-class concept.

---

## 2. The `<4KB` core budget is aspirational marketing, not a design constraint

The reqall context (#1466) carries this target over from `ecs-core`. A realistic component-store + archetype index + query cache + event bus + scheduler + input collector comes to ~8–12 KB min+gzip in TypeScript even with aggressive minification. Keeping it under 4 KB requires cutting features that the README then claims to have (archetype caching, event buffering, scheduling modes, input normalization).

Recommendation: **drop the number from the public spec.** Replace with "tree-shakeable, pay-for-what-you-import." Publish size budgets per module in the package docs and let them be measured, not asserted.

---

## 3. The tick order as written has a subtle ordering bug

From the README:

> 1. Collect input → snapshot
> 2. Flush events buffered last tick
> 3. Run `fixed` systems (zero or more accumulator steps)
> 4. Run `tick` systems in priority order
> 5. Run `event` systems for any events emitted in steps 3–4
> 6. Renderer diffs and commits to DOM

The problem: `event` systems run in step 5 and can mutate components, but the renderer in step 6 has no opportunity to re-enter the event loop. Any event system that emits a new event leaves it undelivered until next tick's step 2 — which is *fine and deterministic* but contradicts a naive reader's expectation. It must be documented explicitly, and the API must make it impossible to `await` event delivery within a tick.

A second issue: step 5 runs after step 4, so a `tick` system cannot react to an event produced by a `fixed` system in the same tick. That may be desired for determinism but should be stated as a **rule**, not emerge as a surprise.

---

## 4. "Same inputs → same state" is a promise the core cannot keep alone

Determinism requires:

- A seeded PRNG policy. `Math.random()` is not deterministic; the core must ship `world.rand()` with a documented algorithm (recommend **splitmix64** or **xoshiro128**\*\*) and seed it at world creation.
- A policy on floating point. JS engines now converge on IEEE-754 semantics, but transcendentals (`Math.sin`, `Math.cos`) are *not* bit-identical across engines. A deterministic world must either avoid them in authoritative systems or ship a fixed-point trig table.
- A policy on `Date.now()` and `performance.now()`. Authoritative systems see `time.tick` (integer) and `time.scaledDelta` (quantized). Wall-clock is forbidden.
- A policy on iteration order. `Map`/`Set` are insertion-ordered; `Object.keys` is insertion-ordered for string keys. Archetype storage must not use `WeakMap` or `WeakSet` in the hot path.

Without these, "replay, networked rollback, and time-travel debugging all become tractable" is marketing.

---

## 5. Retained-mode renderer: the 1:1 mapping is too simple

> "Each entity with a `Sprite` and `Position` becomes a `<div data-entity="…">`"

Real games need:

- **Multi-element entities.** An NPC has a portrait, a nameplate, a status icon row, and a speech bubble — four DOM subtrees, one entity.
- **Layer-aware rendering.** Tooltips sit in a document-level portal. Dialogue choices sit in the `<dialog>` stack. A sprite sits on the stage. Same entity may project into multiple layers.
- **Unrendered entities.** Items in a merchant's 400-slot inventory, off-screen tiles, cached pathfinding graphs. These are entities but must never mount DOM.

The renderer spec must model this as **entity → zero-or-more *views*** with named slots, not **entity → element**. Dismiss this now and it metastasizes into an unfixable wart by v0.3.

---

## 6. IndexedDB persistence and tick-loop coupling is underspecified

- IndexedDB transactions are async and auto-close on the next macrotask. A naive snapshot that walks 20k entities while the main thread yields will see a half-mutated world.
- Autosave every 30 s is fine at 500 entities. At 50k it is a 200 ms jank.
- Migrations need more than `(from, to, snapshot) => snapshot`. They need per-component codecs, because one component is rarely broken in isolation.
- "Saves are entity snapshots — components only, no DOM, no closures" forbids storing function references in components, which is good, but also forbids `Map`/`Set` unless the serializer handles them. State this.

Recommendation: snapshot takes a **structural clone** of a frozen view of component stores synchronously, then writes to IndexedDB off-tick. Specify this.

---

## 7. Svelte and React adapters are not symmetric and should not pretend to be

- Svelte 5 runes wrap component stores in `$state` proxies → fine-grained reactivity with zero diffing.
- React's `useSyncExternalStore` gives one coarse "world changed" notification. Using it per-query means one `useSyncExternalStore` per `useQuery` — workable, but the UX is worse.

The README lists both as peers. The spec should be honest: **Svelte is the first-class adapter**; React is supported but has a higher per-render cost and loses the fine-grained reactive story.

---

## 8. The plugin interface is too thin

`(world) => teardown?` is elegant but insufficient for plugins that need:

- **Schema-level extension** — the inspector needs to know *every* component type at mount.
- **Lifecycle hooks beyond teardown** — `onTickStart`, `onRender`, `onSnapshot`, `onRestore`.
- **Plugin-to-plugin dependencies** — physics needs a spatial index; pathfinding needs physics.

A plugin is not a function; it is an object with metadata:

```ts
interface Plugin {
  name: string
  depends?: string[]
  provides?: string[]
  install(world: World): void | (() => void)
}
```

Ship this shape on day one; upgrading later breaks every plugin in the ecosystem.

---

## 9. "Framework-agnostic" conflicts with "DOM-first"

The README says framework-agnostic, then specifies a DOM renderer, then claims optional React/Svelte adapters. The actual layering is:

```
Core (framework-agnostic, renderer-agnostic)
 └─ DOM renderer (DOM-specific, framework-agnostic)
     ├─ Vanilla (direct)
     ├─ Svelte adapter (reactive wrapper)
     └─ React adapter (useSyncExternalStore wrapper)
```

Getting this right in the module graph *now* avoids a messy v1.0. The spec must publish the dependency DAG.

---

## 10. "DOMECS" vs "domecs" vs "Domecs" — pick one

README and package names alternate capitalizations (`DOMECS`, `@DOMECS/persist`, `'DOMECS'` in the import string). npm is case-insensitive-ish but package names are conventionally lowercase-kebab. Decide:

- Display name: **DOMECS**
- npm name: **domecs**, **@domecs/persist**, etc.
- Import: **`import {…} from 'domecs'`**

Commit 45b8db9 already aligned the README text; align the code.

---

## 11. Missing concerns the README does not mention

- **Testing story.** How does a user test a system without the DOM? There must be a headless world mode.
- **Hot module reload.** For an engine that targets game dev, HMR on systems and components is table-stakes. Design for it or concede that the inspector covers the gap.
- **Worker off-loading.** Listed in the roadmap but not in the architecture. Workers change the model: systems become message-passing actors, components must be structured-cloneable. Decide whether Workers are a v1 concern (then they shape the API) or a v2 concern (then document the breaking change expected).
- **Network rollback.** Listed as "long-term." It is architecturally load-bearing: if the snapshot system isn't rollback-safe on day one, it will never be. Document the invariants the snapshot layer preserves.
- **Memory ownership.** If components are plain objects and systems mutate them in place, who owns them? The world. Components returned from queries must never be stashed across ticks without a copy.

---

## Verdict

The positioning is excellent. The architecture is mostly right. The README is slightly over-promising on four specific axes:

1. **Bundle size** — remove the number.
2. **Determinism** — define what it costs.
3. **Renderer model** — upgrade from 1:1 to entity-views.
4. **Plugin interface** — upgrade from function to object.

All four are cheap to fix *before* code is written, catastrophic to fix *after*. The specification in the rest of `doc/` bakes these corrections in.
