# DOMECS — Exemplar Applications

Six apps chosen to stress-test the DOMECS design in different directions. Each exemplar lists:

- **What it is** — the concrete product.
- **What it stresses** — the DOMECS subsystem most exercised.
- **Entity scale** — rough order-of-magnitude for live and total entities.
- **Required features** — what the core must expose for this app to be expressible.
- **Anti-features** — what this app *doesn't* need (useful for keeping the core small).

These six define the surface area of the v1 spec. If all six can be built *well* on top of DOMECS, the engine has earned its name.

---

## 1. Roguelike — *"Halls of the Forgotten"*

ASCII-art or tile-sprite dungeon crawler. Turn-based. Procedurally generated 128×128 tile levels. FOV, inventory, status effects, identification, permadeath, meta-progression.

### What it stresses

- **Turn scheduling** — not RAF; a tick advances only when the player acts.
- **Sparse queries over a large grid** — 16,384 tiles, ~50 actors, FOV touches ~200 tiles per turn.
- **Save/load is existential** — the player's 40-hour run is one JSON blob.
- **Rich tooltips and inventory modals** — the reason DOMECS exists.

### Entity scale

- Live entities: ~80 (player, 40 monsters, 30 items, 10 effects).
- Grid cells modeled as entities: up to 16,384 (only if tile metadata is per-cell).
- Rendered DOM elements per frame: ~200 (visible tiles + HUD).

### Required features

- Non-RAF scheduling — a `step()` mode where `world.step()` advances exactly one tick.
- **Unrendered entities** — 16,000+ tile entities must not mount DOM. Renderer must key off a `Visible` or `OnScreen` component, not "does entity have a Sprite".
- Deterministic PRNG — a seed defines the entire run; leaderboards verify runs.
- Snapshot/restore for undo in dev mode; for save/load in prod.
- Query filters `Has`, `Not`, and spatial indexing via plugin (tile coordinate → entity).

### Anti-features

- No animation loop for the main simulation.
- No physics.
- No networking.

---

## 2. Management Sim — *"Harbor Authority"*

City-builder scoped to a single port. 200 ships, 500 workers, 5,000 cargo containers, 40 warehouses, 12 cranes. Real-time with adjustable speed (pause, 1×, 4×, 16×, 64×).

### What it stresses

- **Large-entity-count simulation.** At 64× speed, 20,000 entities update at logical 60 Hz.
- **Selective rendering.** The player looks at one berth at a time; the rest simulate invisibly.
- **Variable time scale.** Systems must respect `time.scaledDelta`, not wall-clock.
- **Autosave under load.** Writing a 20k-entity snapshot without a jank spike.

### Entity scale

- Total: ~20,000.
- Rendered: ~300 (one harbor view at a time).
- Simulation tick budget: 16 ms at 1×, 1 ms at 64×.

### Required features

- **Off-main-thread simulation (Worker host).** Must be considered at v1 even if not implemented — API must be structured-clone-safe.
- Archetype storage with tight inner loops; no per-entity function calls in the hot path.
- Fine-grained query invalidation — when 500 workers each tick, `onAdd` / `onRemove` hooks must not fire unless composition changed.
- **Rendering detached from simulation tick rate.** Simulation may run at 960 Hz (64× × 15 Hz logical); renderer at 60 Hz.
- Event bus with backpressure — if 2,000 events fire in one tick, event systems must see them all without allocating 2,000 objects.

### Anti-features

- No per-entity DOM elements for the 20k background entities — ever.
- No save-state for UI (the user's camera position is not world state).

---

## 3. Visual Novel — *"The Lighthouse Correspondence"*

Branching narrative with ~2,000 dialogue nodes, ~40 characters, character affinity state, multiple endings, CG gallery, save/load at any beat, transcript backlog.

### What it stresses

- **State is mostly narrative, not kinetic.** Ticks are rare; most updates are event-driven user choices.
- **Text rendering.** The *entire* UI is text, layout, fonts. Canvas would be actively harmful here.
- **Branching state machine.** Dialogue is a graph with conditions.
- **Deep save slots.** The player saves before every major choice; 50+ slots is normal.

### Entity scale

- Total: ~100 live (visible characters, current scene props, UI modals).
- Narrative graph: ~2,000 nodes but these are data, not entities.
- Rendered: ~20 at once (1 background, 3 sprites, 12 text components, 4 UI chrome).

### Required features

- **Event-driven `event` systems** dominating over `tick` systems. `tick` may run at 0 Hz if nothing animates.
- **Idle tick suspension** — when no system has work, the RAF loop pauses.
- Rich text components: markup, ruby, furigana, typewriter effect — all DOM-native.
- Script-driven entity spawning — a plugin reads a dialogue DSL and emits spawn events.
- Snapshot/restore is the save system — named slots, thumbnails, JSON export.

### Anti-features

- No physics, no pathfinding.
- No archetype hot path optimization — the engine will sit at <100 entities forever.
- No deterministic PRNG — every RNG call is narrative-salient and deliberate.

---

## 4. Board Game — *"Tessera"*

Abstract strategy on a hex grid. 2–4 local or networked players. Perfect information, discrete turns, full undo/redo, replay export, tournament mode with game clock.

### What it stresses

- **Pure determinism.** Given a seed and move list, game state is bit-identical.
- **Snapshot-per-move.** Undo/redo is navigation through a snapshot list.
- **Clean separation of game rules and presentation.** The same rules layer must run headless for AI search and with DOM for humans.
- **Network rollback.** Two clients simulate the same state from the same inputs.

### Entity scale

- Total: ~100 (board cells) + ~30 (pieces) + ~50 (UI).
- Rendered: all of them (the whole board is visible).
- Ticks: rare. Game clock is the only always-on system.

### Required features

- **Headless mode** — `world.stepN(moves)` with no renderer, no RAF, no DOM.
- **Hermetic snapshots** — `snapshot()` / `restore(s)` produce identical worlds across machines. PRNG state is part of the snapshot.
- **Rollback-safe event bus** — rewinding a turn rewinds the event buffer too.
- Per-component **change detection** (`Changed()` filter) for efficient AI evaluation without running the renderer.

### Anti-features

- No autosave in mid-turn (saves are per-turn).
- No `fixed` scheduling.
- No input polling (discrete click → action).

---

## 5. Control Dashboard — *"Fleet Pulse"*

Operations dashboard monitoring 400 vehicles. WebSocket data feed. Alarms, charts, maps, sortable tables, drill-down detail panes. Must remain responsive under 500 updates per second from the wire.

### What it stresses

- **External events as the tick source.** Data arrives when it arrives.
- **Coalesced reactivity.** 500 updates/s must not mean 500 re-renders/s.
- **Deep UI complexity.** Sortable tables, virtualized lists, live-updating charts.
- **Write-once entity schema with rapidly-changing component values.**

### Entity scale

- Total: ~500 (400 vehicles + 100 infrastructure).
- Rendered: depends on view; a table shows 50 rows, a map shows 400 pins.
- Update rate: 500 events/s coalesced to 60 Hz render.

### Required features

- **Reactive tick mode** — a system runs "when its input query changes, debounced to the next frame."
- **External event injection** — `world.emit()` can be called from a WebSocket handler; delivery still respects tick boundaries.
- Virtualized DOM rendering for long lists — renderer must cooperate with windowing (e.g., only entities in the visible table viewport get rendered).
- Query filters that include **numeric range**, not just component presence — "vehicles with `speed > 80`."
- **Persistence is optional.** Dashboards often have no save state beyond user preferences.

### Anti-features

- No determinism requirement.
- No PRNG.
- No turn-based or fixed-timestep machinery.
- No RAF loop when idle.

---

## 6. Game Editor — *"DOMECS Studio"*

Live-editing tool for DOMECS games. Entity tree, component inspector, prefab library, visual script binding, scene save/load, play/pause/step, time-travel scrubber.

### What it stresses

- **Two worlds simultaneously.** The editor itself runs on DOMECS, and it hosts a *guest* world being edited.
- **Reflection.** The inspector must enumerate every component schema and render an editor for it.
- **Snapshot scrubbing.** Time-travel requires a ring buffer of snapshots.
- **Plugin composition.** The editor *is* a DOMECS plugin that installs into any world.

### Entity scale

- Editor world: ~200 entities (UI panels, selected-entity highlights, tool state).
- Guest world: whatever it is.
- Rendered: ~500 (editor chrome + guest viewport).

### Required features

- **Schema reflection API** — `world.componentTypes()` returns the full schema set; each component schema exposes field types for input-widget generation.
- **Multi-world** — `createWorld()` must be callable multiple times; worlds must not share global mutable state.
- **Snapshot ring buffer** — compact, diff-based, bounded memory. A 60-second buffer at 60 Hz = 3,600 snapshots; must not be 3,600 full copies.
- **Plugin lifecycle hooks** beyond teardown — `onRender` for the inspector overlay, `onSnapshot` for redaction of dev-only state.
- **Selection, hover, and highlight as components** on the editor-side entity referencing the guest-side entity.

### Anti-features

- No determinism requirement for the editor world itself.
- No persistence for the editor's chrome state (beyond user preferences in localStorage).

---

## Requirement intersection

Collating the six, the core must ship:

| Requirement                                   | Driven by                                  | Phase |
|-----------------------------------------------|--------------------------------------------|-------|
| Turn-based `step()` API                       | Roguelike, Board Game                      | v0.1  |
| Unrendered entities                           | Roguelike, Management Sim                  | v0.1  |
| Multi-world                                   | Editor                                     | v0.1  |
| Headless (no DOM) world                       | Board Game, testing                        | v0.1  |
| Seeded PRNG in snapshot                       | Roguelike, Board Game                      | v0.1  |
| Snapshot/restore                              | All six                                    | v0.1  |
| Event-driven systems                          | Visual Novel, Dashboard                    | v0.1  |
| Reactive (change-triggered) systems           | Dashboard                                  | v0.2  |
| Schema reflection                             | Editor                                     | v0.2  |
| Plugin object w/ lifecycle hooks              | Editor, all complex plugins                | v0.1  |
| Idle RAF suspension                           | Visual Novel, Dashboard                    | v0.1  |
| Off-main-thread simulation                    | Management Sim                             | v0.3  |
| Diff-based snapshot ring buffer               | Editor, Board Game replay                  | v0.2  |
| Multi-view per entity                         | Visual Novel, Dashboard, Editor            | v0.1  |
| Virtualized rendering                         | Dashboard                                  | v0.2  |

Rows marked v0.1 are non-negotiable for the first release; anything marked v0.1 that is discovered late is an existential refactor.

---

## What the exemplars kill from the README

- **"Sprites are `<div>`s" as the universal model.** Only ~half the exemplars are sprite-driven. The renderer primitive is a *view*, of which `Sprite` is one kind.
- **`tick` as the default scheduling mode.** For three of six exemplars, `tick` barely runs.
- **"Each entity becomes a `<div data-entity="…">`".** Editor and Visual Novel need an entity to project into multiple DOM locations; Dashboard and Management Sim need most entities to project into *none*.
- **Bundle size claims.** Supporting dashboards, editors, and rollback in one core cannot happen under 4 KB.

---

## What the exemplars confirm from the README

- Framework-agnostic core is worth it — three of six exemplars have zero use for Svelte or React.
- IndexedDB persistence as first-class is correct — four of six need save/load.
- Plugin architecture is correct — four of six want capabilities (spatial index, script DSL, reflection, schema codecs) that belong outside the core.
- DOM-first is correct — every exemplar benefits from native text, layout, focus, or accessibility.
