# DOMECS

**Entity Component System → Document Object Model**

A **performance-oriented, deterministic ECS runtime for DOM-heavy
simulations** — with retained DOM projections so humans and AI agents can
operate the same live world. Benchmark characterization is in progress
(see [`plan/PLAN.md`](plan/PLAN.md) WS-1).

The product is the **operable simulation**: deterministic scheduling,
headless stepping, structured `action()`, snapshots / branching / replay,
reflection (`world.describe()`), and multi-view DOM projection of one model.

Games remain a first-class stress test of the framework — they are not the
market. Value workloads: dashboards, ops/control-room tooling, digital twins,
trainers, management sims — anywhere the evolving model *is* the product.

Sprites in CSS.
State in serializable snapshots.
Logic in plain functions over plain data.

---

## Why DOMECS

- **Deterministic kernel** — fixed tick order, buffered events, headless
  `step` / `stepOnce` / `stepN`, same inputs → same state.
- **Typed actions** — `world.action(type, payload)` returns
  `{ accepted, consumedTurn, reason, events, snapshot? }` so agents and UIs
  share one command boundary.
- **Snapshots & branching** — `snapshot` / `restore`, `@domecs/persist`
  save/load, and snapshot history for undo/redo and what-if branches.
- **Retained multi-view DOM** — one world, many slots/views; inspect entities
  with browser DevTools.
- **Agent-operable** — observe / act / step / snapshot through the same APIs
  a human UI uses (see [`plan/PLAN.md`](plan/PLAN.md) WS-3).

Games (roguelikes, management sims, tactics) stay excellent demos because
they stress scheduling, projection, and state. The wedge for the AI age is
**agents operating DOMECS worlds**, not “AI can write DOMECS code.”

---

## Power Features

* Optimized for UI-heavy simulations & apps
* Tailored for AI-augmented development and agent control
* Headless-first stepping for tests, trainers, and replay

---

## Why DOM?

Most engines optimize for the inner render loop.
That's the wrong bottleneck when the UI is a labyrinth of menus, tooltips,
modals, drag-and-drop, scrollable lists, and accessible controls.

The DOM already solves layout, text, input, accessibility, and scaling.
DOMECS leans into that:

- **No canvas reflow tax** for UI-heavy apps — the browser does the layout work it's already good at.
- **Sprites are `<div>`s** with `background-image` + `transform`. The compositor handles them on the GPU.
- **Native input** — pointer events, keyboard focus, touch, IME, screen readers all work out of the box.
- **DevTools** — inspect any entity by inspecting its element. No custom debugger required.
- **Composable** — drop a DOMECS world inside a vanilla (or framework-owned) page; let your existing chrome own the shell.

DOMECS is *not* trying to compete with Phaser or PixiJS for bullet-hell or 3D.
It is trying to be the best runtime where the **model is the product**.

---

## Features

- **Pure-data ECS core** — entities are ids, components are plain objects, systems are functions. No classes, no inheritance, no decorators.
- **Archetype-cached queries** with `onAdd` / `onRemove` hooks for O(1) reaction to entity composition changes.
- **Deterministic scheduling** — tick / fixed-step / once / event-driven systems with explicit priority.
- **Buffered event bus** — events emitted during a tick are flushed at the start of the next tick, so frame order never depends on system order.
- **Retained-mode DOM renderer** — entities are invisible until they match a registered view; views mount / update / unmount per slot and diff only changed components.
- **CSS animation story** — transforms, sprite sheets, and transitions via components through DOM views. CSS is the supported animation path (no separate sprites package).
- **Snapshot persistence** — Result-typed `save`/`load` over pluggable storage, multi-slot, schema migrations, snapshot history for undo/redo. (An IndexedDB + autosave facade is planned.)
- **Input collector** — keyboard, mouse, pointer, touch, gamepad normalized into a per-tick input snapshot.
- **Plugin architecture** — physics, pathfinding, dialogue, inspector, time-travel debugger all attach as plugins.
- **Framework-agnostic** — vanilla by default; integrate any framework from user code via `World.signals` and `snapshot()`. First-party Svelte/React adapters are indefinitely deferred.
- **TypeScript-first** — fully typed component schemas, query inference, system context.

---

## Status

**v1.0.0 — API-stable.** All five `@domecs/*` packages are published at 1.0.0.
Semver is honored; the product contract is still hardening via corrective
`1.0.x` releases (first-hour traps, benchmarks, agent surface). See
[`plan/PLAN.md`](plan/PLAN.md) for governing direction and kill gates.

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

Published packages resolve to built ESM under `dist/` (no bundler required for
Node or import-map browser hosts). This repository itself is a `pnpm` workspace;
if you're developing here, use the workspace setup below rather than
`npm install` of the published packages.

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
import { save, loadIfPresent, createMemoryStorage } from '@domecs/persist'

const storage = createMemoryStorage() // or createLocalStorageStorage() in the browser

const saved = save(world, storage, 'slot-1', { meta: { label: 'checkpoint' } })
if (!saved.ok) console.error(saved.error)

// First-run boot: missing slot is ok(false), not an error (O-28).
const loaded = loadIfPresent(world, storage, 'slot-1')
if (!loaded.ok) console.error(loaded.error)
else if (!loaded.value) {
  // first run — seed defaults
}
```

Saves are entity snapshots — components only, no DOM, no closures. Load migrates the envelope to the current `SNAPSHOT_VERSION` and rebuilds the world; the renderer mounts everything in a single pass. `createSnapshotHistory` adds a bounded undo/redo ring.

A higher-level `createPersistence` facade (IndexedDB adapter, autosave) is planned — see `doc/ROADMAP.md` (demand-driven; see also `plan/PLAN.md` §5).

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Your sim / app — components & systems      │
├─────────────────────────────────────────────┤
│  @domecs/core     World · Entities · Query  │
│                   Systems · Events · Time   │
│                   action() · describe()     │
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

- `tick` — every animation frame (RAF-driven). **Gated off at `setScale(0)` / pause.**
- `fixed` — fixed timestep (default 60 Hz), with accumulator; safe for physics. **Also gated at scale 0.**
- `event` — fires only when matching events are emitted.
- `once` — runs at world start (initialization).
- Always-on while paused: `tickStart` signal and plugin `onTickStart` — put pause/resume/save hotkeys there, or handle keys outside the world.

### Determinism

A tick proceeds in this order, every time:

1. Collect input → snapshot
2. Flush events buffered last tick
3. Run `fixed` systems (zero or more accumulator steps)
4. Run `tick` systems in priority order
5. Run `event` systems for any events emitted in steps 3–4
6. Renderer diffs and commits to DOM

Same inputs → same state.
Replay, trainers, and time-travel debugging all become tractable.

---

## When to use DOMECS

**Good fit**
- Operable simulations, digital twins, trainers, control-room dashboards
- Management sims, base-builders, factory games
- Roguelikes, tactics, deck-builders, idle/incremental
- Visual novels with branching state
- Tooling and level editors with multi-view projection

**Probably not a fit**
- Bullet hell, twin-stick shooters, anything with thousands of moving sprites per frame
- 3D
- Pixel-perfect platformers needing sub-frame collision

For those, reach for Phaser, PixiJS, or a dedicated game engine.
Or use DOMECS for the *menus / model* and embed a canvas for the action.

---

## Roadmap

Direction is governed by [`plan/PLAN.md`](plan/PLAN.md). Summary:

| Workstream | Focus |
|---|---|
| **WS-0** | Positioning & hygiene (this README; API-stable labeling) |
| **WS-1** | Benchmark suite — evidence before more features |
| **WS-2** | Adoption-killer fixes (first paint, pause, persist first-run, docs) |
| **WS-3** | Agent operability surface (`AGENTS.md`, skill, observe/act/step/snapshot) |
| **WS-4** | One flagship operable-simulation reference |

**Frozen until kill gates clear:** `@domecs/sprites`, React/Svelte adapters,
network rollback / generalized Worker host, `create-domecs` scaffolder,
`@domecs/vite` plugin.

Itemized feature queue (subordinate): [`doc/ROADMAP.md`](doc/ROADMAP.md).
Engineering ledger: [`plan/FINDINGS.md`](plan/FINDINGS.md).

---

## License

MIT © HyperNovaSystem
