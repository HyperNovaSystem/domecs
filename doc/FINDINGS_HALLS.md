# DOMECS findings from `halls_game`

Notes from fleshing out **Halls of the Forgotten** as a browser roguelike in `../halls_game`, based on exemplar #1 in `doc/exemplars.md`.

This implementation was intentionally dependency-free and data-oriented. That made the game quick to build, but it also exposed places where DOMECS should provide sharper primitives so a full roguelike does not need to hand-roll the same infrastructure.

## Findings and suggestions

### H-0: Static Halls cannot validate DOMECS package releases yet

`halls_game` is still a dependency-free static prototype, so it does not
exercise `@domecs/core`, `@domecs/dom`, packed package metadata, or Vite static
deployment. Treat `domecs/example/roguelike` as the current roguelike release
validator, or rebuild Halls on the scoped DOMECS packages before expecting it to
participate in release validation.

---

### H-1: Tile grids should not require one mounted DOM node per tile

**Observation:** The game uses a 128×128 level (16,384 cells) but renders a fixed 48×32 viewport (1,536 cells). The renderer reuses viewport cells and projects them onto world coordinates.

**Framework implication:** A DOMECS roguelike should not have to choose between:

- modeling each map cell as an entity and accidentally mounting 16k DOM nodes, or
- abandoning ECS for tile rendering.

**Suggestion:** Add/document a `TileMapView` or virtualized grid view for `@domecs/dom` that renders a viewport window over data-backed tiles. It should support camera origin, cell reuse, and per-cell tooltip/accessibility text.

---

### H-2: Some world state wants dense resources, not entities

**Observation:** `map`, `visible`, and `explored` are dense arrays. Treating these as entity components would add query/archetype overhead without improving gameplay logic.

**Framework implication:** Roguelikes naturally mix ECS actors/items/effects with dense tile arrays.

**Suggestion:** Make first-class world resources part of the recommended DOMECS pattern, including snapshot support and change markers for resource-backed views. Example: `world.resource(TileMap)` plus `ChangedResource(TileMap)`.

---

### H-3: Turn systems need an explicit command/action pipeline

**Observation:** Not every attempted input consumes a turn. Bumping a wall logs feedback but does not advance simulation; waiting, moving, attacking, picking up, using, and descending do.

**Framework implication:** A raw event system can deliver `MoveEvent`, but the game still needs an action-resolution contract: validate, mutate, decide whether the turn was consumed, then run enemy/status/FOV systems exactly once.

**Suggestion:** Provide a turn-command helper or documented pattern:

```ts
world.action(Move, payload, {
  validate,
  apply,
  consumesTurn: result => result.ok,
})
```

This would help undo/replay/network determinism because the accepted command stream is explicit.

---

### H-4: Save/load needs versioned app-level persistence, not just ECS snapshots

**Observation:** The save blob includes RNG state, map arrays, actors, items, inventory, identification knowledge, log, floor, and player status. Meta-progression is deliberately outside the active run save.

**Framework implication:** `world.snapshot()` is necessary but not sufficient for production save/load. Games need version tags, migrations, named slots, localStorage/IndexedDB adapters, and a clean split between run state and account/meta state.

**Suggestion:** Add a small persistence package or recipe with:

- versioned snapshot envelopes;
- migration hooks;
- storage adapters;
- transient/redacted fields;
- save-slot metadata;
- deterministic import/export tests.

---

### H-5: Seeded RNG ergonomics matter

**Observation:** Determinism required RNG state in the save blob and all generation/drop/AI decisions to use the same seeded generator. Helpers like `int`, `oneOf`, `weighted`, and `shuffle` were immediately needed.

**Framework implication:** `world.rand.next()` is a good primitive, but exemplar games benefit from standard deterministic helpers.

**Suggestion:** Ship or document RNG utilities tied to world state: integer ranges, weighted tables, shuffles, split streams, and a simple way to expose seed/state for save debugging.

---

### H-6: Spatial indexing should understand occupancy layers

**Observation:** Movement and interaction need different spatial lookups: wall/floor, living monster, item stack, stairs, player occupancy, nearby monsters, and line-of-sight blockers.

**Framework implication:** A generic `at(x, y)` bucket works, but game code still does repeated filtering and layer rules.

**Suggestion:** Extend the spatial-index plugin pattern with optional layers/tags:

- blocking terrain;
- blocking actors;
- pickup items;
- interactables;
- FOV blockers.

The API could offer `firstAt(layer, x, y)`, `allAt(layer, x, y)`, and `isBlocked(x, y, mask)`.

---

### H-7: FOV is a reactive derived view, but it is often resource-sized

**Observation:** FOV recalculates only after player position changes, then updates a dense `visible` array and marks explored cells.

**Framework implication:** Component-level `Changed(Position)` is useful, but the output is not naturally per-entity when visibility is a map resource.

**Suggestion:** Document FOV as a reactive system over `Changed(Position)` that mutates a resource and emits/marks `ChangedResource(VisibilityMap)`. Pair this with the virtualized tile view from H-1.

---

### H-8: Multi-view UI is central, not auxiliary

**Observation:** The same item can appear as a map glyph, inventory row, tooltip text, save blob content, and log message. The player appears in the map, HUD, and end-run modal.

**Framework implication:** DOMECS should continue to treat rendering as views over state, not as one entity = one element.

**Suggestion:** Add a roguelike UI recipe showing multi-view projection for map, HUD, inventory modal, tooltip, and log. This would validate the `@domecs/dom` multi-view story with state-heavy UI.

---

### H-9: Tooltips need first-class view support

**Observation:** Rich hover text was one of the clearest DOM wins. The implementation sets per-cell tooltip text from current world state.

**Framework implication:** Tooltips are not a separate game system; they are derived views that may need access to hidden/explored/visible distinctions.

**Suggestion:** Provide a `tooltip` view helper or example that supports entity/resource-backed hover text, keyboard focus, and accessibility labels.

---

### H-10: Status effects want a small lifecycle convention

**Observation:** Poison, hidden, sleep, regeneration, and temporary strength all needed turn countdowns, stacking rules, and per-turn hooks.

**Framework implication:** This is common across roguelikes, RPGs, board games, and management sims.

**Suggestion:** Keep it out of core, but add an exemplar plugin pattern for duration components/effects:

- merge/refresh stack policy;
- tick-down on accepted turn;
- expiration hooks;
- snapshot-safe effect data.

---

### H-11: Logs and action feedback deserve a standard event pattern

**Observation:** Invalid and valid actions both produce player-facing messages. The log is part of save/load because it helps restore context.

**Framework implication:** The event bus should make it easy to collect durable domain events separately from transient UI events.

**Suggestion:** Document a `GameLogEvent`/durable event pattern and clarify whether event buffers are included in snapshots or whether systems should write log entities/resources explicitly.

---

### H-12: Browser input for turn-based games should avoid an always-on RAF dependency

**Observation:** This implementation handles keydown events directly and calls one action. No animation frame is required for the main simulation.

**Framework implication:** `@domecs/input` examples that poll key state through `requestAnimationFrame` are useful for held movement, but they can obscure the non-RAF turn model.

**Suggestion:** Add a discrete input mode/recipe: DOM key/click event → command → `world.turn(...)`, with optional repeat handling outside the simulation tick.

---

## Summary

The exemplar still supports the original DOMECS direction: deterministic turn scheduling, headless logic, snapshots, DOM-native UI, plugins, and multi-view rendering are the right targets.

The main framework pressure is that roguelikes are hybrid data models: dense tile resources plus sparse ECS actors/items/effects. DOMECS should make that hybrid explicit rather than forcing every cell through the same entity/rendering path.
