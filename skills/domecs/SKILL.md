---
name: domecs
description: >
  Build or operate DOMECS worlds — deterministic ECS simulations with DOM
  projection and a typed action boundary for humans and AI agents. Use when
  the user mentions DOMECS, @domecs/core, operable simulation, world.action,
  createAgentBridge, headless step/snapshot, or asks to add agent control
  to a DOMECS app. Slash: /domecs.
---

# DOMECS skill

## Goal

Ship a small working simulation using **only** published `@domecs/*` packages
and this skill. Prefer the agent bridge over inventing control APIs.

## Packages

```bash
npm install @domecs/core @domecs/dom @domecs/input
# optional: @domecs/persist @domecs/inspector
```

Import from scoped packages only (`@domecs/core`, never legacy `domecs`).

## Canonical control loop

```ts
import {
  createWorld,
  createAgentBridge,
  defineComponent,
  defineEvent,
  entry,
} from '@domecs/core'

const world = createWorld({ headless: true, seed: [1, 2, 3, 4] })
// define components, events, systems…
const bridge = createAgentBridge(world)
bridge.captureBaseline()

const obs = bridge.observe()           // world.describe() + tick/scale
const result = bridge.act(MyCmd, payload)
bridge.step()                          // stepOnce; use step(dt) for fixed
const snap = bridge.snapshot()
bridge.reset()                         // episode boundary
```

| Method | Delegates to |
|--------|----------------|
| `observe()` | `world.describe()` + `time` |
| `act(type, payload, opts?)` | `world.action(...)` |
| `step()` / `step(dt)` | `stepOnce()` / `step(dt)` |
| `snapshot(opts?)` | `world.snapshot(...)` |
| `reset()` | `world.restore(baseline)` |

## Authoring order

1. `defineComponent` / `defineEvent` / `defineResource` with schemas when useful
2. `createWorld({ headless: true, seed })` for tests and agents
3. `world.system(...)` — schedules: `tick` | `fixed` | `event` | `once` | reactive
4. `spawn` + `entry(C, value)`; keep the **entity id**, not the bag
5. Optional: `mountDOM` + `defineView` for browser projection
6. Wrap with `createAgentBridge` for observe/act/step/snapshot/reset

## Traps (always apply)

- **markChanged** after in-place component mutation
- **spawn shallow-copy** — scalars diverge; nested refs stay shared
- **stepOnce ≠ fixed** — fixed needs positive `dt`
- **keyDelta** is one render tick — not for `fixed` systems
- **scale 0** freezes `tick`/`fixed` — pause UI outside those schedules
- **loadIfPresent** for first-run boot (`@domecs/persist`)
- **pauseOnHidden** only auto-resumes driver-initiated pauses

## Recipes (short)

- **Durable log:** append events into a component/resource; event bus is transient
- **Multi-view:** one world, many slots; do not clone domain state per UI
- **Post-restore:** rebuild transient views after `restore`/`load`
- **Feed coalesce:** queue → coalesce by key → one event per frame
- **Prefs vs world:** operator prefs outside snapshot; sim state inside
- **History vs saves:** `createSnapshotHistory` for undo; `save`/`load` for named slots

## Done when

- [ ] App runs headless with deterministic seed
- [ ] Agent can `observe` → `act` → `step` → `snapshot` without private APIs
- [ ] No methods invented outside `@domecs/*` public surface
- [ ] Tests cover at least one full episode + reset

## Deeper docs

Repo root `AGENTS.md`, `doc/api.md`, `doc/LEGIBILITY.md`, `plan/PLAN.md`.
