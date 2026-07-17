# AGENTS.md — operating a DOMECS world

Instructions for AI agents (and humans pairing with them) building or
controlling simulations on `@domecs/*`.

Governing product direction: [`plan/PLAN.md`](plan/PLAN.md).
API contract: shipped types in [`doc/api-surface/`](doc/api-surface/) +
[`doc/api.md`](doc/api.md). Legibility laws: [`doc/LEGIBILITY.md`](doc/LEGIBILITY.md).

---

## What DOMECS is

A **deterministic, inspectable browser simulation runtime** with retained DOM
projections. Humans and agents operate the **same** live world through:

| Verb | API | Use |
|------|-----|-----|
| **observe** | `world.describe()` / `bridge.observe()` | Schema + live counts (cheap) |
| **act** | `world.action(type, payload)` / `bridge.act(...)` | Typed commands with structured result |
| **step** | `world.stepOnce()` / `world.step(dt)` / `bridge.step(dt?)` | Advance simulation |
| **snapshot** | `world.snapshot()` / `bridge.snapshot()` | Branch, replay, compare |
| **reset** | `bridge.reset()` (restore baseline) | Episode boundaries |

Install:

```bash
npm install @domecs/core @domecs/dom @domecs/input
# optional
npm install @domecs/persist @domecs/inspector
```

Published packages resolve to built ESM under `dist/` (no bundler required for
Node or import-map hosts). Prefer published packages over cloning engine source
unless you are changing the engine.

---

## Minimal agent episode

```ts
import {
  createWorld,
  createAgentBridge,
  defineComponent,
  defineEvent,
  entry,
} from '@domecs/core'

const Health = defineComponent<{ hp: number }>('Health', { defaults: { hp: 10 } })
const Damage = defineEvent<{ amount: number }>('Damage')

const world = createWorld({ headless: true, seed: [1, 2, 3, 4] })
// register systems that handle Damage, then:
const id = world.spawn([entry(Health, { hp: 10 })])
const agent = createAgentBridge(world)
agent.captureBaseline()
agent.reset()                        // episode-boundary hygiene: every
                                     // episode starts from the identical
                                     // restored state

const obs = agent.observe()          // manifest + tick + entityCount
const result = agent.act(Damage, { amount: 3 })
// result: { accepted, consumedTurn, reason?, events, snapshot? }
agent.step()                         // turn-based; use step(1/60) for fixed
const snap = agent.snapshot()
agent.reset()                        // back to baseline for next episode
```

---

## Hard rules (do not invent APIs)

1. **Mutate → mark.** After changing a component field in place, call
   `world.markChanged(entity, ComponentType)` or the view will not update.
2. **`spawn` shallow-copies.** Capture the entity id; read live state with
   `world.getComponent(id, C)`. Do not keep the bag you passed to `spawn`.
3. **`stepOnce` never fires `fixed` systems.** Use `step(world.time.fixedStep)`
   (or `bridge.step(dt)`) for fixed-schedule sims and tests.
4. **`keyDelta` is one render tick.** Edge-triggered keys belong on `tick`
   systems (or use held `keys`). Do not sample `keyDelta` from `fixed`.
5. **Paused (`scale === 0`) freezes `tick` and `fixed`.** Put pause/resume
   controls on `tickStart`, plugin `onTickStart`, or outside the world.
6. **First-run save:** use `loadIfPresent` from `@domecs/persist`, not bare
   `load` (missing slot is normal).
7. **Errors are data.** Prefer `Result` + `match` / `describeError` at seams;
   do not wrap everything in try/catch unless the API throws by contract.
8. **One naming language.** Use `getResource`, `listEntities`, `OnChanged`,
   `startLoop`, `stepOnce` — not legacy aliases from training data.

---

## Recipes agents rediscover (blessed patterns)

### Durable log
Event buffers are transient. Append accepted events into a component or
resource if the log must survive `snapshot`/`restore`.

### Multi-view projection
One world → many DOM slots/views (`stage`, `hud`, `panel`). Prefer extra views
over cloning state for each UI region.

### Post-restore rebuild
After `restore`/`load`, rebuild transient projection entities (viewport, table
rows) from persistent state — often in a plugin `onRestore` or a boot `once`
system.

### Feed coalesce
External telemetry: queue → coalesce by entity key → one batch event per frame.
Do not spawn a system tick per network message.

### Preferences vs world state
Operator prefs (columns, filters) usually live outside the world snapshot;
disposable live feed state stays in the world.

### History vs named saves
- Undo/redo ring → `createSnapshotHistory`
- Named slots / labels → `save`/`load` + `Storage`

Install redaction plugins **before** constructing history with
`captureInitial`, or the baseline leaks unredacted state.

### Control while paused
Do not put resume hotkeys in a `tick` system. Use `tickStart` or a DOM
listener calling `world.resume()` / `setScale(1)`.

---

## DOM views (short)

```ts
import { mountDOM, defineView } from '@domecs/dom'

mountDOM(world, {
  slots: { stage: document.getElementById('stage')! },
  views: [
    defineView({
      slot: 'stage',
      query: [Health] as const,
      create: () => document.createElement('div'),
      update: (el, e) => { el.textContent = String(e.Health.hp) },
    }),
  ],
})
```

`update` runs once on first mount (first paint), then only when queried
components are `markChanged`.

---

## Verification checklist before claiming “it works”

- [ ] Headless: `createWorld({ headless: true })` + `step`/`stepOnce` tests pass
- [ ] Determinism: same seed + same acts → identical `JSON.stringify(snapshot())`
  (key-order-stable today; a canonical serializer/hash is tracked as ledger
  O-11 — switch to it when it ships)
- [ ] Agent loop: `reset → observe → act → step → snapshot` is enough for the task
- [ ] No invented methods; imports resolve from published `@domecs/*` only

Two `act`/`step` sharp edges: `act()` validates payloads **only when the
event declares a `schema`** (then typo'd fields / wrong types return
`accepted: false` with a reason — declare schemas on every agent-facing
command; schema-less events stay unvalidated), and `bridge.step(0)` is a
heartbeat (no systems run), unlike `bridge.step()`.

Installable skill companion: [`skills/domecs/SKILL.md`](skills/domecs/SKILL.md).
