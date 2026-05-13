# DOMECS Findings — Lighthouse Correspondence Exemplar

Notes from building `../lighthouse_novel`, based on visual-novel exemplar #3 in `doc/exemplars.md`.

## Summary

DOMECS was expressive enough for an event-driven visual novel: the script graph stayed as plain data, the ECS world held only live story/UI state, event systems drove choices and save/load, DOM views handled text-heavy UI, and transient components kept rendering projections out of snapshots.

The implementation also exposed framework gaps around save-slot ergonomics, transient view lifecycle, text-centric DOM helpers, and script-driven spawning.

## Findings

### 2026-05-13: Release validation must use packed scoped packages

Lighthouse now imports `@domecs/core` and `@domecs/dom`, so it can smoke-test
the public package names. For local development the app can still point at
`file:../domecs/packages/*`, but release validation should stage the app
against packed tarballs. Folder-based npm lockfiles preserve workspace
internals such as `workspace:*`, while packed tarballs prove the publish
metadata, `dist` files, and static Vite build path.

### 1. Transient-only view entities leave empty snapshot records

`lighthouse_novel` spawns DOM view entities whose components are all marked `transient`. DOMECS correctly omits those components from `world.snapshot()`, but the snapshot still includes the entity record with an empty `components` object. For a UI-heavy visual novel (choices, transcript lines, save slot cards, gallery cards), that adds save-file noise and can revive empty entities on restore.

The app worked around this with an app plugin that prunes empty entity records in `onSnapshot`.

Suggestion:

- Have core snapshot serialization skip entities that have no non-transient components after filtering, or
- Provide a documented `pruneTransientOnlyEntities` plugin/recipe so UI-heavy apps do not each rediscover the pattern.

### 2. Save slots need first-class metadata envelopes

The exemplar needs named slots, labels, thumbnails/current scene ids, tick/time metadata, JSON export, and eventually IndexedDB persistence. `world.snapshot()` is a good primitive, but every app currently has to define its own save-slot envelope and storage adapter.

Suggestion:

- Add a persistence recipe/package around `WorldSnapshot` with slot metadata, version tags, migrations, IndexedDB/localStorage adapters, and import/export helpers.
- Keep the ECS snapshot pure, but standardize the surrounding application-level save envelope.

### 3. Restore needs a post-restore transient-view rebuild convention

Loading a save restored persistent story state, but transient DOM projection entities had to be manually despawned/rebuilt after `world.restore(...)`. This is correct for transient state, but the lifecycle is easy to forget and should be a documented pattern.

Suggestion:

- Add a documented `onRestore`/`afterRestore` recipe for rebuilding transient views from persistent state.
- Consider a helper plugin for derived transient projections: `deriveViews(world, sourceQuery, buildViewEntities)`.

### 4. Event-driven apps need an ergonomic “dispatch and step” story

Visual-novel progress is entirely event-driven (`AdvanceText`, `ChoiceSelected`, `SaveRequested`, `LoadRequested`). In headless tests, events must be emitted and then `world.step()` called to flush event systems. This is semantically sound, but repetitive in tests and app helpers.

Suggestion:

- Document `world.turn(event, payload)` as the preferred pattern for discrete UI/story actions, not only board games/roguelikes.
- Consider a clearer alias such as `world.dispatch(...)` / `world.flushEvents()` for non-turn-based event-driven apps where “turn” reads game-specific.

### 5. Text-first DOM UI wants renderer helpers beyond entity-per-element views

The visual novel UI is mostly text: dialogue, speaker labels, choices, transcript backlog, save slots, and gallery entries. `@domecs/dom` views worked, but the app still hand-wrote common text UI plumbing such as escaping, list ordering, button handlers, and sidebar chrome outside retained views.

Suggestion:

- Provide text/UI recipes for ordered list views, button views that emit events, transcript/backlog rendering, and accessible dialogue markup.
- Consider `@domecs/dom` utilities for keyed ordered child projection where the view order is part of component data.

### 6. Rich text/typewriter support belongs in a DOM-oriented example or plugin

The exemplar spec calls out markup, ruby/furigana, and typewriter effects. The implementation models typewriter fields (`revealedCharacters`, `totalCharacters`) but renders text fully revealed to keep the app event-driven and idle-friendly.

Suggestion:

- Add a DOM text plugin/example that supports rich text markup, ruby/furigana, and typewriter reveal without forcing a permanent RAF loop.
- The typewriter system should wake only while text is revealing, then let idle RAF suspension resume.

### 7. Script-driven entity spawning needs an official plugin pattern

The script graph is ordinary data, not entities, which is the right shape for 2,000+ narrative nodes. But the app hand-wrote the bridge from script node → transient scene/dialogue/choice entities.

Suggestion:

- Document a script/DSL plugin pattern that consumes external narrative data and emits DOMECS events or derived view entities.
- Include examples for condition checks, choice effects, affinity/flag mutation, and validation of missing target nodes.

### 8. Multi-view rendering is essential for narrative UI

One story state fans out into multiple DOM regions: background, portraits, dialogue, choices, transcript, gallery, and save slots. This confirms DOMECS should continue treating rendering as views over state rather than one entity = one DOM element.

Suggestion:

- Keep multi-slot/multi-view projection central in `@domecs/dom` docs.
- Add a visual-novel example to renderer docs demonstrating one persistent story entity driving many transient view entities/slots.

### 9. Event buffers are intentionally not durable; docs should say how to persist durable history

The transcript backlog is durable story state, so it is stored in a component rather than relying on event history. This distinction is important: UI/domain events are transient delivery mechanisms, while transcript/log history must be explicit world state.

Suggestion:

- Document a durable-log pattern: event system receives transient events, then appends persistent transcript/log records to a component/resource.
- Clarify snapshot semantics for event buffers and direct subscribers.

## What worked well

- `schedule: 'event'` systems were a natural fit for visual-novel progression.
- Idle RAF suspension aligns well with mostly-static narrative screens.
- Transient components are a good model for DOM projection state.
- Plugin `onSnapshot` was flexible enough to patch app-specific save behavior.
- DOMECS snapshots are simple enough to use directly for in-memory save slots.
- Keeping the 2,000-node script graph outside ECS avoided unnecessary entity/query overhead.
