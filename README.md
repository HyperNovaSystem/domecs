# DOMECS

**Entity Component System → Document Object Model**

A high-performance ECS game engine that renders to the DOM. Built for games whose complexity lives in their *systems and state* — inventories, dialogue trees, economies, crafting graphs, base-builders, roguelikes, idle/incremental, tactics, management sims — rather than in their pixels.

Sprites in CSS. State in IndexedDB. Logic in plain functions over plain data.

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
- **Sprite system** — CSS sprite sheets, animated frames, z-ordering, transforms, all driven by components.
- **IndexedDB persistence** — first-class save/load, autosave, multi-slot, schema migrations, snapshot/restore for undo.
- **Input collector** — keyboard, mouse, pointer, touch, gamepad normalized into a per-tick input snapshot.
- **Plugin architecture** — physics, pathfinding, dialogue, inspector, time-travel debugger all attach as plugins.
- **Framework-agnostic** — vanilla by default; optional adapters for Svelte 5 reactive worlds and React via `useSyncExternalStore`.
- **TypeScript-first** — fully typed component schemas, query inference, system context.

---

## Status

Early.
The architecture below is the design target.

---

## Install

```bash
npm install DOMECS
```

Optional packages:

```bash
npm install @DOMECS/persist     # IndexedDB save/load
npm install @DOMECS/sprites     # sprite sheet + animation components
npm install @DOMECS/inspector   # in-browser entity/component debugger
```

---

## Quick start

```ts
import { createWorld, defineComponent } from 'DOMECS'
import { mountDOM, defineView } from 'DOMECS/dom'

const Position = defineComponent<{ x: number; y: number }>('Position')
const Sprite   = defineComponent<{ sheet: string; frame: number }>('Sprite')
const Velocity = defineComponent<{ dx: number; dy: number }>('Velocity')

const world = createWorld()

world.use(mountDOM(world, {
  slots: { stage: document.getElementById('stage')! },
  views: {
    sprite: defineView(Sprite, {
      slot: 'stage',
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
  },
}))

world.system('movement', { query: [Position, Velocity] }, ({ entities, time }) => {
  for (const e of entities) {
    e.Position.x += e.Velocity.dx * time.scaledDelta
    e.Position.y += e.Velocity.dy * time.scaledDelta
    world.markChanged(e.id, Position)
  }
})

world.spawn({
  Position: { x: 100, y: 100 },
  Velocity: { dx: 1, dy: 0 },
  Sprite:   { sheet: 'hero.png', frame: 0 },
})

world.start()
```

Entities are invisible by default. An entity mounts DOM only when it matches a registered view's query — here, the `sprite` view binds to `Sprite` and projects one element into the `stage` slot. An entity can project zero, one, or many views across slots (`stage`, `hud`, `portal`, `chrome`), or none at all.
Mutating `e.Position.x` in a system updates `transform: translate(...)` on the next tick — no virtual DOM, no React reconcilation, no canvas redraw.

---

## Persistence

```ts
import { createPersistence } from '@DOMECS/persist'

const persist = createPersistence(world, {
  database: 'my-game',
  version:  3,
  migrate:  (from, to, snapshot) => snapshot, // upgrade old saves
})

await persist.save('slot-1')
await persist.load('slot-1')
persist.autosave({ everyMs: 30_000 })
```

Saves are entity snapshots — components only, no DOM, no closures. Load rebuilds the world; the renderer mounts everything in a single pass.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Your game code — components & systems      │
├─────────────────────────────────────────────┤
│  DOMECS/core      World · Entities · Query  │
│                   Systems · Events · Time   │
├─────────────────────────────────────────────┤
│  DOMECS/dom       Retained DOM renderer     │
│  @DOMECS/sprites  Sprite sheets, animation  │
│  @DOMECS/persist  IndexedDB snapshots       │
│  @DOMECS/inspector  Devtools panel          │
├─────────────────────────────────────────────┤
│  Browser — DOM, CSS, IndexedDB, Pointer API │
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
- Tooling, level editors, simulation dashboards

**Probably not a fit**
- Bullet hell, twin-stick shooters, anything with thousands of moving sprites per frame
- 3D
- Pixel-perfect platformers needing sub-frame collision

For those, reach for Phaser, PixiJS, or a real game engine. Or use DOMECS for the *menus* and embed a canvas for the action.

---

## Roadmap

- [x] Project scaffold
- [ ] Core engine (World, Entity, System, Query, Events, Time, Input)
- [ ] DOM renderer with sprite components
- [ ] IndexedDB persistence with migrations
- [ ] Inspector / time-travel debugger
- [ ] Svelte 5 reactive adapter
- [ ] React adapter
- [ ] Web Worker system host (off-main-thread simulation)
- [ ] Networked rollback (long-term)

---

## License

MIT © HyperNovaSystem
