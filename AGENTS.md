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
| **act** | `world.action(type, payload)` / `bridge.act(type \| 'Name', payload)` | Typed commands with structured result; by name for JSON callers |
| **step** | `world.stepOnce()` / `world.step(dt)` / `bridge.step(dt?)` | Advance simulation |
| **snapshot** | `world.snapshot()` / `bridge.snapshot()` | Branch, replay, compare |
| **reset** | `bridge.reset()` (restore baseline) | Episode boundaries |

Install:

```bash
npm install @domecs/core @domecs/dom @domecs/input
# optional
npm install @domecs/persist @domecs/inspector @domecs/scene @domecs/rules
```

`@domecs/scene` and `@domecs/rules` are on npm from 2.0.0; all `@domecs/*`
packages in an app must share the same major version.

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
// Episode-boundary hygiene: every episode starts from the identical restored
// state. scale and input are not in the snapshot; reset re-applies them.
// `once` systems do not re-run — put per-episode setup in the baseline.
agent.reset({ scale: 1, input: 'empty' })

const obs = agent.observe()          // manifest + tick + entityCount
const result = agent.act(Damage, { amount: 3 })
// For a command made with defineCommand (below), accepted/reason are its
// handler's verdict; for a plain event they come from opts.resolve.
// act() emits AND runs one tick (pass { dt: 1/60 } for fixed schedules).
// result: { accepted, consumedTurn, reason?, events, snapshot? }
// agent.step()                      // only to advance with no command;
                                     // step(1/60) for fixed schedules
const snap = agent.snapshot()
agent.reset({ scale: 1, input: 'empty' })  // back to baseline for next episode
```

---

## Hard rules (do not invent APIs)

1. **Mutate → mark.** After changing a component field in place, call
   `world.markChanged(entity, ComponentType)` or the view will not update.
2. **`spawn` shallow-copies.** Capture the entity id; read live state with
   `world.getComponent(id, C)`. Do not keep the bag you passed to `spawn`.
3. **`stepOnce` never fires `fixed` systems.** Use `step(world.time.fixedStep)`
   (or `bridge.step(dt)`) for fixed-schedule sims and tests: it runs exactly
   one fixed step. Inside a `fixed` system, `ctx.time` is the step's clock:
   integrate with `ctx.time.scaledDelta`, count deadlines in
   `ctx.time.fixedTick`.
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
9. **Systems and action handlers are deterministic.** Nothing checks this at
   run time, so these are bans, not warnings. Inside a system, a reactive or
   event handler, or a `Where` predicate, do not use:
   - `Math.random()`: use `world.rand`.
   - `Date.now()`, `new Date()`, `performance.now()`: use `world.time`
     (`tick`, `elapsed`, `delta`).
   - `setTimeout`, `setInterval`, `await` or promises: a tick is
     synchronous, so schedule with `fixed` systems, tick counts or events.
   - The DOM, `window`, layout, `navigator`, storage or the network: bring
     outside data in through `world.action`, events, `setInput` or a
     resource written outside the tick.
   - Object identity that must survive `restore()`: keep entity ids, not
     component objects (restore builds fresh ones).
   - `Math.sin`/`cos`/`tan`/`exp`/`log`, or `pow` with a non-integer
     exponent, when results must match across JS engines (SPEC §8).

   Check it the only way that works: replay the same seed and actions twice
   and compare `hashSnapshot(snapshot(), { includeChanges: true })` (not
   `JSON.stringify`, which depends on insertion order and writes `-0` as `0`;
   see the checklist below).

---

## Recipes agents rediscover (blessed patterns)

### Durable log
Event buffers are transient. Append accepted events into a component or
resource if the log must survive `snapshot`/`restore`. To re-run a session
(not to read its events in-world), record an act log instead — see
"Record and replay".

### Multi-view projection
One world → many DOM slots/views (`stage`, `hud`, `panel`). Prefer extra views
over cloning state for each UI region.

### Post-restore rebuild
After `restore`/`load`, rebuild transient projection entities (viewport, table
rows) and caches from persistent state in a `world.signals.restored`
subscriber: it runs once after every restore, whoever called it (`load`,
`bridge.reset()`, a branch), outside a tick, before the repaint. Not in a
plugin `onRestore`: it runs before the snapshot is applied, so anything it
spawns is wiped. `createSpatialHash` indexes refresh themselves on it.

Forks and checkpoints taken between ticks pass
`snapshot({ pendingEvents: true })` so events in flight are delivered after
the restore too. Restore resolves them by name: `world.register(...)` every
event type that can be in flight in the restoring world's setup, or the
restore throws.

### Feed coalesce
External telemetry: queue → coalesce by entity key → one batch event per frame.
Do not spawn a system tick per network message.

### Preferences vs world state
Operator prefs (columns, filters) usually live outside the world snapshot;
disposable live feed state stays in the world.

### History vs named saves
- Undo/redo ring → `createSnapshotHistory`
- Named slots / labels → `save`/`load` + `Storage`
- Re-runnable session (bug repro, playtest, scrub from keyframes) → base
  snapshot + act log (`createRecorder` / `replay`), not a snapshot per tick

Install redaction plugins **before** constructing history with
`captureInitial`, or the baseline leaks unredacted state.

### Events in a fixed-step simulation
An `event` system runs after the whole fixed phase, so in a sim on the
`fixed` schedule the number of steps between an emit and its handling
depends on the frame rate. Handle such events in a fixed event system:

```ts
world.system('service', { schedule: 'event', fixed: true, triggers: [ServiceCrane] }, (ctx) => {
  for (const { crane } of ctx.events.of(ServiceCrane)) startService(ctx.world, crane, ctx.time.fixedTick)
})
```

Each fixed step delivers the events emitted since the previous one, so an
emit in step k is handled in step k + 1 at 1× or 64×. Commands from outside
arrive at the next step that runs. Plain `fixed` systems still read the
frame's events in every step: do not consume events in them.

### Neighbour queries
Do not scan every entity per entity (O(n²)). Use `createSpatialHash(world,
{ component: Pos, cellSize })` from `@domecs/scene`: call `index.refresh()`
once per step (at the start of the system that queries), then
`within` / `nearest` / `pairs` with tag filters. Results are id-sorted and
independent of `cellSize`; the index is never snapshotted, so `refresh()`
after `restore`. The pure grid is `createSpatialGrid` in `@domecs/core`.

### Behaviours as rules
Data-defined behaviours (chase, flee, keep distance, counters) are
`@domecs/rules` `RuleDef`s, not a hand-written system each:

```ts
import { installRules, type RuleDef } from '@domecs/rules'

const chase: RuleDef = {
  name: 'chase', schedule: 'fixed', query: ['Pos', 'Vel'], without: ['Player'],
  actions: [
    { set: 'Vel.x', expr: '(first(Player).Pos.x - Pos.x) * 0.1 ?? 0' },
    { set: 'Vel.y', expr: '(nearest(Coin, 50).Pos.y - Pos.y) * 0.1 ?? 0' },
  ],
}
const rules = installRules(world, [], resolve, { spatial: { component: 'Pos' } })
const errors = rules.update([chase])          // Map<rule name, RuleError[]>; empty = all installed
```

Read other entities with `first(S)`, `nearest(S[, d])`, `entity(n)`; over sets
with `count`, `exists`, `sum`/`avg`/`minOf`/`maxOf(S, C.f)`,
`countWithin(S, r)`, `distanceTo(e)`. Wrap reads that may have no value (no
player, nothing in range) in `?? fallback`. `nearest`, `countWithin` and
`distanceTo` need the `spatial` option (else a compile error). A rule writes
only its own entity; other entities react by reading it (`first(S).C.f`) in
their own rules. `self`, `tick`, `other`, `event`, `pointer` are reserved
words. Contract: SPEC Appendix A; tutorial:
the `@domecs/rules` README.

### Commands with verdicts
An agent's "did my command work?" is answered by the command's handler:

```ts
import { defineCommand, refuse } from '@domecs/core'

const BuyCrane = defineCommand<{ berth: number }>('BuyCrane', {
  description: 'Buy a crane for a berth that has room on its rails: $90,000.',
  schema: { fields: { berth: { kind: 'entity', required: true, with: ['Berth'] } } },
  handle(ctx, { berth }) {
    const cash = ctx.world.getResource(Cash)!
    if (cash < 90_000) return refuse(`Not enough cash: $90,000 needed, $${cash} held.`)
    // … spend, spawn, ctx.events.emit(CraneBought, { berth })
  },
})
world.register(BuyCrane)                          // installs the handler, once
bridge.act('BuyCrane', { berth: 7 })              // { accepted: false, reason: 'Not enough cash: …' }
```

`register` installs the handler as the event system `command:BuyCrane`
(priority −100). `action()` / `bridge.act()` return the handler's verdict for
that command; refusals spend no turn. Pass `fixed: true` for a command to a
fixed-step simulation: it is handled in the next fixed step, so act with
`{ dt: world.time.fixedStep }`. `describe().events[i].command` marks commands,
and act logs keep each verdict, so replay reports a diverging refusal at the
act.

### Commands as event rules
Declare the command with a `schema` and `world.register` it, then handle it
with an event rule instead of a host system:

```ts
const move: RuleDef = {
  name: 'move', schedule: 'event', on: 'Move', self: 'event.target',
  query: ['Pos'], actions: [{ set: 'Pos.x', expr: 'Pos.x + event.dx' }],
}
```

`act('Move', { target, dx })` moves only that entity (dead or unmatched:
no-op). No `self`: broadcast over `query`, or once with an empty `query`.
`effects` (`emit`, `spawn` with `installRules(..., { prefabs })`, `despawn`,
`add`, `remove`) apply at the end of the rule's run; an `emit` arrives next
tick.

### Record and replay
Record what enters the world from outside, then re-run it on a fresh world
built by the same setup:

```ts
import { createRecorder, replay } from '@domecs/core'

const base = world.snapshot({ pendingEvents: true })
const rec = createRecorder(world, { hashEvery: 60 })
// … world.action(Cmd, payload), world.step(dt), world.setInput(snap) …
const log = rec.stop()                       // plain JSON (ActLog)

const fork = build()                         // same systems/plugins, same order
const r = replay(fork, log, { base })        // Result<{ ticks, hash }, ReplayError>
if (!r.ok) console.log(r.error.kind)         // 'diverged' at the first bad checkpoint, …
```

Every runtime change goes through a command (`emit`/`action`/`turn`): a
direct `getComponent` write + `markChanged`, `spawn` or `setResource` outside
a tick, or a `world.rand` draw between steps, is a **gap** (`log.gaps`) and
replay past it diverges. `register`
every command event so `replay` resolves acts by name. Build the replay world
without stimulus sources (no input plugin, no hook or signal subscriber that
emits, none that sets the scale at tick start — their effects are in the log) and with no `once`
system the source already ran.

### Branch and compare
To ask "what happens if…" without touching the live world (or re-firing its
views), branch it: a fresh headless world built by the same setup and restored
from a snapshot. Do not restore and step the live world for this.

```ts
import { createBranch, runBranch } from '@domecs/core'

const from = live.snapshot({ pendingEvents: true })
const b = createBranch(setup, from, {      // setup: same systems, same order; spawns nothing
  fixedStep: live.time.fixedStep,          // neither is in the snapshot
  scale: live.time.scale,
})
if (!b.ok) throw new Error(b.error.kind)     // 'restore_failed' | 'once_systems'
const run = runBranch(b.value.world, {
  steps: 600,
  probes: { pop: (w) => w.countEntities([Creature]) },   // read-only
  sampleEvery: 60,                           // counted from this call; the last step is always sampled
  log,                                       // optional ActLog: acts applied at their ticks
  until: (w) => w.countEntities([Creature]) === 0,
  shouldStop: () => cancelled,               // synchronous: run it in a worker
})
if (run.ok) console.log(run.value.stoppedBy, run.value.samples, run.value.finalHash)
```

Compare branches (or a branch with the live world) by `finalHash` / `hashes`
(strict) and by probe samples. Call `runBranch` again to extend a branch; on a
large world pass `finalHash: false` to the calls that only advance it (a strict
hash snapshots the whole world).
`once` systems in the setup refuse a branch from `tick > 0` (`once_systems`):
gate boot work on snapshotted state so it is not re-run (the gate is read
after the restore), or leave it out of the branch setup.
The snapshot carries the source's `fixedStep` (the branch's default) but not
its scale: pass the source's `time.scale` (for a paused source, its resume
scale, then `pause()` the branch). A probe that
changes the world throws at the first sample.

### Render state
`defineResource('Camera', { default: { x: 0, zoom: 1 }, transient: true })`
keeps a camera / HUD cache out of snapshots and hashes; `restore()` keeps its
live value.

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
components are `markChanged` — or, with `changedOn: { mode: 'auto',
resources: [Camera] }`, when a listed resource is set. Mounted elements carry
`data-entity`: route DOM events with `handle.on('stage', 'click', (entity,
ev) => …)` or `entityOf(ev.target)`, find an element with
`handle.elementOf(view, entity)`, nest one view's elements in another's with
`parent: { view, of: (e) => e.Box.holder, at: '.deck' }`, and keep a list in
order with `order: (e) => e.Rank.n`. A panel that sums up many entities is a
`definePanel({ slot, render: (world) => html, changedOn })`, patched in place
with `paint` (call `watchPresses(document)` once) so clicks and focus survive
its repaints.

---

## Verification checklist before claiming “it works”

- [ ] Headless: `createWorld({ headless: true })` + `step`/`stepOnce` tests pass
- [ ] Determinism: same seed + same acts → identical
  `hashSnapshot(snapshot(), { includeChanges: true })` (`@domecs/core`; the
  strict form is the restore-equivalence key). Not `JSON.stringify`: it
  depends on component insertion order and writes `-0` as `0`. Serialize
  keyframes/forks with `canonicalJson` (lossless `-0`)
- [ ] Cross-runtime determinism: authoritative systems use `dmath.sin` /
  `dmath.cos` from `@domecs/core`, never `Math.sin` / `Math.cos` (they differ
  by up to 1 ulp between engines); rules do this automatically
- [ ] Agent loop: `reset → observe → act (→ step to idle) → snapshot` is enough for the task
- [ ] No invented methods; imports resolve from published `@domecs/*` only

`act`/`step` sharp edges:

- `act()` already runs one tick. Following every `act()` with `step()`
  spends two ticks per turn; call `step()` only to advance with no command.
  The exception is `act(..., { dt: 0 })` (or negative `dt`): a heartbeat
  that runs no tick and leaves the command pending with `accepted: false`.
  It runs on the next real tick, so resending it would run it twice.
- `world.action()` takes the token `defineEvent` returned. A name string or
  a look-alike object is rejected (`accepted: false`, no tick) — it has no
  event identity, so no handler could ever see it. `bridge.act('Name', …)`
  resolves a name to its token first (below).
- `act()` validates payloads **only when the event declares a `schema`**
  (then typo'd fields, wrong types, missing `required` fields, NaN,
  out-of-`min`/`max` numbers, non-integers where `integer` is set and
  `entity` fields that name no live entity — or one without the `with`
  components — return `accepted: false` with a reason, before any tick).
  Declare schemas on every agent-facing command, with `required` on the
  fields a handler needs and `kind: 'entity'` on ids; schema-less events
  stay unvalidated.
- `bridge.step(0)` is a heartbeat (no systems run), unlike `bridge.step()`.

Name-based act: `bridge.act('Damage', payload)` resolves through
`world.lookupEvent`. Call `world.register(...commandEvents)` at setup so each
name resolves before first use and stays unique — an unknown name, or one two
`defineEvent('Damage')` types share, returns `accepted: false` with no tick
(`register` returns `name_conflict` for the duplicate).

Installable skill companion: [`skills/domecs/SKILL.md`](skills/domecs/SKILL.md).
