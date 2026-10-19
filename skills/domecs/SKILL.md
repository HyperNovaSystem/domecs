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
# optional: @domecs/persist @domecs/inspector @domecs/scene @domecs/rules
```

Import from scoped packages only (`@domecs/core`, never legacy `domecs`).
Keep every `@domecs/*` package on the same major version (currently 2).

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
bridge.reset({ scale: 1, input: 'empty' }) // episode boundary (scale/input are not snapshotted)
```

| Method | Delegates to |
|--------|----------------|
| `observe()` | `world.describe()` + `time` |
| `act(type, payload, opts?)` | `world.action(...)` |
| `act(name, payload, opts?)` | `world.lookupEvent(name)` → `world.action(...)`; unknown/ambiguous name → `accepted: false`, no tick |
| `step()` / `step(dt)` | `stepOnce()` / `step(dt)` |
| `snapshot(opts?)` | `world.snapshot(...)` |
| `reset(opts?)` | `world.restore(baseline)`, then `setScale(opts.scale)` / empty input (`input: 'empty'`); `once` systems do not re-run |

## Authoring order

1. `defineComponent` / `defineEvent` / `defineResource` with schemas when useful
   (field and event `description`s help agents read `describe()`)
2. `createWorld({ headless: true, seed })` for tests and agents; then
   `world.register(...types)` so `describe()` / `lookup*` list them before first use
3. `world.system(...)` — schedules: `tick` | `fixed` | `event` | `once` | reactive
4. `spawn` + `entry(C, value)`; keep the **entity id**, not the bag
5. Optional: `mountDOM` + `defineView` for browser projection
6. Wrap with `createAgentBridge` for observe/act/step/snapshot/reset

## Traps (always apply)

- **markChanged** after in-place component mutation
- **spawn shallow-copy** — scalars diverge; nested refs stay shared
- **stepOnce ≠ fixed** — fixed needs positive `dt`
- **declare `schema` on command events** — `world.action`/`bridge.act`
  then rejects malformed payloads (`accepted: false` + reason); without a
  schema, payloads pass through unvalidated
- **unique command names** — `bridge.act('Name', …)` resolves through
  `world.lookupEvent`; two `defineEvent('Name')` types make the name
  ambiguous (rejected). `world.register(Cmd)` asserts uniqueness
  (`name_conflict`)
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
- **History vs saves:** `createSnapshotHistory` for undo; `save`/`load` for named slots;
  a re-runnable session is a base snapshot + act log
- **Record and replay:** `base = world.snapshot({ pendingEvents: true })`,
  `rec = createRecorder(world, { hashEvery })`, drive with commands/steps/`setInput`,
  `log = rec.stop()` (plain JSON); `replay(build(), log, { base })` → `Result<{ ticks, hash }>`.
  Direct writes / `spawn` / `setResource` outside a tick are gaps (replay diverges);
  replay world = same setup minus input plugin and emitting hooks; `register` command events
- **Branch and compare:** `createBranch(setup, live.snapshot({ pendingEvents: true }), { fixedStep, scale })`
  (the source's `time.fixedStep` / `time.scale`: neither is reliably in the snapshot)
  → `Result<{ world, setup }>` (`restore_failed` / `once_systems`, never thrown); then
  `runBranch(world, { steps, probes, sampleEvery, log?, until?, shouldStop? })` → `{ ticks,
  stoppedBy, samples, keyframes, hashes, faults, finalHash }`; counts are per call, the last
  step is always sampled; probes read-only; never restore-and-step the live world to explore
- **Equality / forks:** `hashSnapshot(snap, { includeChanges: true })` for live vs
  fork; `hashEntities` localizes a divergence; `canonicalJson` for keyframes
- **Events in flight:** forks/keyframes use `snapshot({ pendingEvents: true })`
  and `register` every event type that can be pending in the restoring world
- **Redraw without a tick:** after `restore`/scrub, `world.runSystems(['<name>'])` primes
  derived state (e.g. `composeTransforms`; `{ ran, skipped }`, only enabled `tick`/`fixed`)
  and `world.render()` repaints via `onRender` only — neither advances `time.tick` nor fires
  `tickStart`/`tickEnd` (unlike `step(0)`). Derived/transient state only: a recorder notes a gap
- **Render state:** `defineResource('Camera', { default, transient: true })` keeps a camera /
  HUD cache out of snapshots and hashes; `restore()` keeps its live value
- **Neighbours:** `createSpatialHash` (`@domecs/scene`), `refresh()` once per
  step, then `within`/`nearest`/`pairs`; never snapshotted, refresh after restore
- **Contacts (hits, pickups):** `world.use(installContacts({ position: { component: Pos },
  radius: 8 | { component: Body, field: 'r' }, pairs: [[Player, Enemy]] }))` (`@domecs/scene`)
  emits `Contact { a, b, phase: 'begin' | 'stay' | 'end' }` (a holds the first tag; `stay`
  opt-in) on the `fixed` schedule; rules react next tick with `{ schedule: 'event', on:
  'Contact', self: 'event.a', other: 'event.b', when: "event.phase == 'begin'" }`.
  `ContactState` is snapshotted; forks take `snapshot({ pendingEvents: true })`
- **Levels / scenes:** `instantiateScene(world, { name, entities: [{ key, components, parent? }] },
  { resolve, refFields: [['Target', 'entity']] })` (`@domecs/scene`) spawns in array order and
  maps keys to live ids; it returns `{ ids, problems }` (never throws for bad data — check
  `problems`). `unloadScene(world, name)` removes the scene's trees. "Goto level": an event
  rule writes `event.scene` into a level-state entity; the host swaps scenes after the step
- **Trig in systems:** `dmath.sin` / `dmath.cos` / `dmath.atan2` /
  `dmath.hypot` / `dmath.pow` (`@domecs/core`), not `Math.*`, so Node,
  Electron and browsers agree bit for bit
- **Behaviours as rules:** cross-entity rules read other entities with
  `first(Player).Pos.x`, `nearest(Coin, 50).id`, `count(Enemy)`,
  `sum(Enemy, Hp.hp)`, `countWithin(Enemy, 5)`, `distanceTo(e)`; wrap reads
  that may be absent in `?? fallback`; exclude with `without: [...]`; pass
  `installRules(..., { spatial: { component: 'Pos' } })` for `nearest` /
  `countWithin` / `distanceTo`. Rules write only their own entity (others through effects or
  events); `self`, `tick`, `other`, `event`, `pointer` are reserved words
- **Player control as rules:** `key("ArrowLeft")` (held), `pressed("Space")` /
  `released("Space")` (edges; `tick` rules only, compile error in `fixed`), `mod("shift")`,
  `pointer.x|y|buttons|wheel` read the tick's `world.input` (`KeyboardEvent.code` names); drive
  headless runs with `world.setInput(snapshot)` before each step and record those snapshots to
  replay. Not allowed in world expressions
- **Commands as event rules:** `{ schedule: 'event', on: 'Move', self: 'event.target',
  query: ['Pos'], actions: [{ set: 'Pos.x', expr: 'Pos.x + event.dx' }] }` runs per delivered
  payload for that entity (dead/unmatched: no-op); without `self` it broadcasts over `query`, or
  runs once with empty `query` (world scope, no `set`). `register` the event first (`on` resolves
  through `world.lookupEvent`) and give it a `schema` so `act()` validates. `effects`: `emit`
  (delivered next tick), `spawn` (needs `installRules(..., { prefabs })`), `despawn`, `add`,
  `remove` — queued only if the actions succeeded, applied at the end of the rule's run
- **Metrics as world expressions:** `compileWorldExpression('countWithin(Enemy, 40, first(Player))',
  resolve, { spatial: { component: 'Pos' } })` → `expression.evaluate(world)` (a `Result`;
  read-only, hash unchanged). No entity: use `first(S).C.f`, never bare `C.f`, `self`, `dt`,
  `nearest` or `random()` (compile errors)

## Done when

- [ ] App runs headless with deterministic seed
- [ ] Same seed + same acts → equal `hashSnapshot(snap, { includeChanges: true })`
  (never compare `JSON.stringify(snapshot())`; keyframes use `canonicalJson`)
- [ ] Agent can `observe` → `act` → `step` → `snapshot` without private APIs
- [ ] No methods invented outside `@domecs/*` public surface
- [ ] Tests cover at least one full episode + reset

## Deeper docs

Repo root `AGENTS.md`, `doc/api.md`, `doc/LEGIBILITY.md`, `plan/PLAN.md`.
