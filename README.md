# DOMECS

**Entity Component System → Document Object Model**

A high-performance ECS game engine that renders to the DOM.
Built for games whose complexity lives in their *systems and state* — inventories, dialogue trees, economies, crafting graphs, base-builders, roguelikes, idle/incremental, tactics, management sims — rather than in their pixels.

Sprites in CSS.
State in serializable snapshots.
Logic in plain functions over plain data.

---

## Power Features
* Optimized for UI-heavy games & apps
* Tailored for AI-augmented development

---

## Why DOM?

Most game engines optimize for the inner render loop.
That's the wrong bottleneck for a game whose UI is a labyrinth of menus, tooltips, modals, drag-and-drop, scrollable lists, and accessible controls.

The DOM already solves layout, text, input, accessibility, and scaling.
DOMECS leans into that:

- **No canvas reflow tax** for UI-heavy games — the browser does the layout work it's already good at.
- **Sprites are `<div>`s** with `background-image` + `transform`. The compositor handles them on the GPU.
- **Native input** — pointer events, keyboard focus, touch, IME, screen readers all work out of the box.
- **DevTools** — inspect any entity by inspecting its element. No custom debugger required.
- **Composable with everything** — drop a DOMECS world inside a React/Svelte/vanilla page; let your existing UI framework own the chrome.

DOMECS is *not* trying to compete with Phaser or PixiJS for bullet-hell or 3D.
It is trying to be the best engine in the world for games where the **model is the game**.

---

## Features

- **Pure-data ECS core** — entities are ids, components are plain objects, systems are functions.  No classes, no inheritance, no decorators.
- **Archetype-cached queries** with `onAdd` / `onRemove` hooks for O(1) reaction to entity composition changes.
- **Deterministic scheduling** — tick / fixed-step / once / event-driven systems with explicit priority.
- **Buffered event bus** — events emitted during a tick are flushed at the start of the next tick, so frame order never depends on system order.
- **Retained-mode DOM renderer** — entities are invisible until they match a registered view; views mount / update / unmount per slot and diff only changed components.
- **Sprite-friendly views** — CSS sprite sheets, z-ordering, and transforms driven by components through DOM views. (A dedicated `@domecs/sprites` frame-animation package is planned.)
- **Snapshot persistence** — Result-typed `save`/`load` over pluggable storage, multi-slot, schema migrations, snapshot history for undo/redo. (An IndexedDB + autosave facade is planned.)
- **Input collector** — keyboard, mouse, pointer, touch, gamepad normalized into a per-tick input snapshot.
- **Plugin architecture** — physics, pathfinding, dialogue, inspector, time-travel debugger all attach as plugins.
- **Framework-agnostic** — vanilla by default; integrate any framework from user code via `World.signals` and `snapshot()`. (First-party Svelte/React adapters are indefinitely deferred — value unproven.)
- **TypeScript-first** — fully typed component schemas, query inference, system context.

---

## Status

v1.0.0 — stable. All five `@domecs/*` packages are published at 1.0.0.

---

## Live demos

Five standalone exemplar apps — each its own repo, each deployed to GitHub Pages.
They consume the `@domecs/*` packages from this repo via `file:../domecs/packages/*`,
so clone any of them **alongside** `domecs` to develop on it.

| Demo | What it exercises | Live | Source |
|------|-------------------|------|--------|
| **Dashboard** | PID-controlled hydraulic lift; keyboard control, E-stop | [▶ open](https://hypernovasystem.github.io/dashboard/) | [repo](https://github.com/HyperNovaSystem/dashboard) |
| **Restaurant** | Real-time sim: seating, orders, service, pause/resume | [▶ open](https://hypernovasystem.github.io/restaurant/) | [repo](https://github.com/HyperNovaSystem/restaurant) |
| **Roguelike** | 128×128 dungeon, reactive FOV, spatial-index plugin, following camera | [▶ open](https://hypernovasystem.github.io/roguelike/) | [repo](https://github.com/HyperNovaSystem/roguelike) |
| **Railroad** | Iron Dynasty — real-time railroad tycoon; persistence + inspector | [▶ open](https://hypernovasystem.github.io/railroad/) | [repo](https://github.com/HyperNovaSystem/railroad) |
| **Fleet Pulse** | 400-vehicle telemetry dashboard; coalesced bursts, virtual table | [▶ open](https://hypernovasystem.github.io/fleet/) | [repo](https://github.com/HyperNovaSystem/fleet) |

---

## Install

If you're consuming the published packages:

```bash
npm install @domecs/core @domecs/dom @domecs/input
```

Optional packages:

```bash
npm install @domecs/persist     # snapshot save/load + migrations
npm install @domecs/inspector   # in-browser entity/component debugger
```

This repository itself is a `pnpm` workspace. If you're developing in
this repo, use the workspace setup below rather than `npm install`.

---

## Workspace setup

Install all workspace packages from the repository root:

```bash
pnpm install
```

The packages in [`packages/`](./packages) depend on each other via
`workspace:*`, so they must be installed through the workspace.

Workspace-wide commands:

```bash
pnpm test
pnpm build
pnpm typecheck
pnpm run release:validate
```

`release:validate` builds and packs the runtime packages, stages the available
demo apps against those tarballs, then runs each app's `test` and `build`
scripts. Use it before publishing a new `@domecs/*` version.

The exemplar apps that used to live in `example/` are now standalone repos —
see [Live demos](#live-demos) above. Each consumes these packages via
`file:../domecs/packages/*`, so clone it next to this repo to develop on it.

---

## Quick start

```ts
import { createWorld, defineComponent, entry } from '@domecs/core'
import { mountDOM, defineView } from '@domecs/dom'

const Position = defineComponent<{ x: number; y: number }>('Position')
const Sprite   = defineComponent<{ sheet: string; frame: number }>('Sprite')
const Velocity = defineComponent<{ dx: number; dy: number }>('Velocity')

const world = createWorld()

mountDOM(world, {
  slots: { stage: document.getElementById('stage')! },
  views: [
    defineView({
      slot: 'stage',
      // Tuple-form query — `view.Position` / `view.Sprite` are typed.
      // `changedOn` is auto-derived from the query, so the view redraws
      // only when one of its components is marked changed.
      query: [Position, Sprite] as const,
      create: () => {
        const el = document.createElement('div')
        el.className = 'sprite'
        return el
      },
      update: (el, e) => {
        el.style.transform = `translate(${e.Position.x}px, ${e.Position.y}px)`
        el.style.backgroundPosition = `-${e.Sprite.frame * 16}px 0`
      },
    }),
  ],
})

world.system('movement', { query: [Position, Velocity] }, ({ entities, time }) => {
  for (const e of entities) {
    e.Position.x += e.Velocity.dx * time.scaledDelta
    e.Position.y += e.Velocity.dy * time.scaledDelta
    world.markChanged(e.id, Position)
  }
})

world.spawn([
  entry(Position, { x: 100, y: 100 }),
  entry(Velocity, { dx: 1, dy: 0 }),
  entry(Sprite,   { sheet: 'hero.png', frame: 0 }),
])

world.startLoop()
```

Entities are invisible by default. An entity mounts DOM only when it matches a registered view's query — here, the `sprite` view binds to `Sprite` and projects one element into the `stage` slot. An entity can project zero, one, or many views across slots (`stage`, `hud`, `portal`, `chrome`), or none at all.
Mutating `e.Position.x` in a system updates `transform: translate(...)` on the next tick — no virtual DOM, no React reconcilation, no canvas redraw.

---

## Errors as Components

DOMECS treats recoverable failures as data, not exceptions. Two channels, only two:

- **`Result<T, E>`** at framework seams — system returns, plugin install, `save`/`load`/`migrate`. Closed `DomecsError` union plus an exhaustive `match()` mean adding a new variant breaks every call site until handled.
- **`Faulted`** as a component — entity-scoped faults attach a buffer of `FaultEntry` records to the affected entity, so faults flow through the same query/system machinery as anything else. Render `[Sprite, Faulted]` as degraded; query `[Faulted, Retryable]` to retry; subscribe to `world.signals.faultRaised` for systemic faults that have no entity to attach to.

```ts
world.system('hp-validator', { query: [Health] as const }, ({ entities }) => ({
  errors: entities
    .filter((e) => e.Health.hp < 0)
    .map((e) => ({
      entity: e.id,
      component: 'Health',
      error: { kind: 'schema_mismatch', component: 'Health', expected: 'hp>=0', got: `hp=${e.Health.hp}` },
      recoverable: true,
    })),
}))
```

Returning `void` is success. Returning a `SystemResult` is "I have something to report." Throwing is "the program is broken" — the framework never auto-promotes a throw into recoverable data.

See [`doc/error-handling.md`](doc/error-handling.md) for the full cookbook (retry, escalation, degraded rendering, plugin error namespacing, persistence, async wrappers) and [`doc/BETTER_ERRORS.md`](doc/BETTER_ERRORS.md) for the design rationale.

---

## Persistence

```ts
import { save, load, createMemoryStorage } from '@domecs/persist'

const storage = createMemoryStorage() // or any object implementing Storage

const saved = save(world, storage, 'slot-1', { meta: { label: 'checkpoint' } })
if (!saved.ok) console.error(saved.error)

const loaded = load(world, storage, 'slot-1') // migrates old saves, then restores
if (!loaded.ok) console.error(loaded.error)
```

Saves are entity snapshots — components only, no DOM, no closures. Load migrates the envelope to the current `SNAPSHOT_VERSION` and rebuilds the world; the renderer mounts everything in a single pass. `createSnapshotHistory` adds a bounded undo/redo ring.

A higher-level `createPersistence` facade (IndexedDB adapter, autosave) is planned — see `doc/ROADMAP.md`.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Your game code — components & systems      │
├─────────────────────────────────────────────┤
│  @domecs/core     World · Entities · Query  │
│                   Systems · Events · Time   │
├─────────────────────────────────────────────┤
│  @domecs/dom      Retained DOM renderer     │
│  @domecs/persist  Snapshot save/load        │
│  @domecs/inspector  Devtools panel          │
├─────────────────────────────────────────────┤
│  Browser — DOM, CSS, Storage, Pointer API   │
└─────────────────────────────────────────────┘
```

### Core concepts

| Concept       | What it is                                                                 |
|---------------|----------------------------------------------------------------------------|
| **World**     | Container for entities, systems, events, time, plugins.                    |
| **Entity**    | Numeric id + bag of components. No behavior of its own.                    |
| **Component** | Plain data, defined once with a schema, attached to entities.              |
| **System**    | Function over a query result, run on a schedule.                           |
| **Query**     | Cached set of entities matching a component signature.                     |
| **Event**     | Typed message buffered this tick, delivered next tick.                     |
| **Plugin**    | `(world) => teardown?` — adds systems, components, or services.            |

### Scheduling modes

- `tick` — every animation frame (RAF-driven).
- `fixed` — fixed timestep (default 60 Hz), with accumulator; safe for physics.
- `event` — fires only when matching events are emitted.
- `once` — runs at world start (initialization).

### Determinism

A tick proceeds in this order, every time:

1. Collect input → snapshot
2. Flush events buffered last tick
3. Run `fixed` systems (zero or more accumulator steps)
4. Run `tick` systems in priority order
5. Run `event` systems for any events emitted in steps 3–4
6. Renderer diffs and commits to DOM

Same inputs → same state.
Replay, networked rollback, and time-travel debugging all become tractable.

---

## When to use DOMECS

**Good fit**
- Roguelikes, tactics, deck-builders, idle/incremental
- Management sims, base-builders, factory games
- Visual novels with branching state
- Tabletop simulators, board game engines
- Tooling, level editors, control/simulation dashboards

**Probably not a fit**
- Bullet hell, twin-stick shooters, anything with thousands of moving sprites per frame
- 3D
- Pixel-perfect platformers needing sub-frame collision

For those, reach for Phaser, PixiJS, or a dedicated game engine.
Or use DOMECS for the *menus* and embed a canvas for the action.

---

## Roadmap

Shipped in v1.0.0:

- [x] Project scaffold
- [x] Core engine (World, Entity, System, Query, Events, Time, Input)
- [x] DOM renderer (retained-mode views, slots, change-gated updates)
- [x] Snapshot persistence with schema migrations (`@domecs/persist`)
- [x] Inspector / time-travel debugger (`@domecs/inspector`)

Planned:

- [ ] `@domecs/sprites` — sprite-sheet frame animation package
- [ ] IndexedDB + autosave persistence facade (`createPersistence`)
- [ ] `@domecs/worker` — Web Worker system host (off-main-thread simulation)
- [ ] Networked rollback (long-term)

Indefinitely deferred (value unproven):

- Svelte 5 reactive adapter
- React adapter

---

## License

MIT © HyperNovaSystem
