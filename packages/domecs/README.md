# @domecs/core

Core DOMECS runtime: entities, components, queries, systems, events, plugins,
time, RNG, and snapshots.

DOMECS is an ECS-first framework for DOM-heavy browser apps and games. This
package is intentionally renderer-agnostic; pair it with `@domecs/dom` for DOM
views and `@domecs/input` for browser input collection.

> Status: v2.x — **API-stable** (semver honored; product contract still hardening).

## Install

```bash
npm install @domecs/core
```

## Quick start

```ts
import {
  createWorld,
  defineComponent,
  entry,
  Has,
  type World,
} from '@domecs/core'

const Position = defineComponent<{ x: number; y: number }>('Position')
const Velocity = defineComponent<{ dx: number; dy: number }>('Velocity')

const world = createWorld({ seed: 123, fixedStep: 1 / 60 })

world.spawn([
  entry(Position, { x: 0, y: 0 }),
  entry(Velocity, { dx: 1, dy: 0 }),
])

world.system(
  'move',
  { schedule: 'fixed', query: [Position, Velocity] },
  ({ world }) => {
    const w = world as World
    for (const { id, value: pos } of w.iterEntitiesWith(Position)) {
      const vel = w.getComponent(id, Velocity)
      if (!vel) continue
      pos.x += vel.dx
      pos.y += vel.dy
      w.markChanged(id, Position)
    }
  },
)

world.step(1 / 60)

for (const entity of world.query(Has(Position)).entities) {
  console.log(entity.id, entity.Position)
}
```

## Main API

- `createWorld(options)` — create an ECS world.
- `defineComponent<T>(name, options?)` — define typed component handles.
- `defineResource<T>(name, options?)` — define a world-level named value
  (score, level, gravity); `world.getResource(R)` / `setResource(R, v)` /
  `markResourceChanged(R)`. React to changes with `OnChangedResource(R)`.
  `{ transient: true }` (2.3) keeps render-only state (a camera) out of
  snapshots and hashes; `restore()` keeps its live value.
- `entry(component, value)` — typed helper for heterogeneous spawn arrays.
- `world.spawn(...)` / `world.despawn(...)` — manage entities.
- `world.addComponent(...)`, `getComponent(...)`, `removeComponent(...)` —
  manage component data.
- `world.query(...)` / `world.observe(...)` — query and observe entity sets.
- Query helpers: `Has`, `Not`, `Or`, `And`, `OnAdded`, `OnRemoved`, `OnChanged`,
  `Where`, `OnChangedResource`.
- `world.system(name, def, fn)` — register `tick`, `fixed`, `event`, `once`, or
  `reactive` systems.
- `defineEvent<T>(name)`, `world.emit(...)`, `world.on(...)` — buffered events.
- `world.turn(type, payload, dt?)` — fire-and-forget turn-based command.
- `world.action(type, payload, opts?)` — turn-based command with a structured
  `{ accepted, consumedTurn, reason?, events, snapshot? }` result; the verdict
  comes from an optional `opts.resolve`.
- `world.snapshot()` / `world.restore(...)` — serialize and restore world state.
- `createAgentBridge(world)` — `reset / observe / act / step / snapshot` for
  agent episodes; `reset({ scale: 1, input: 'empty' })` (2.3) also resets the
  host controls a snapshot does not carry. `once` systems do not re-run.
- `world.runSystems(names)` / `world.render()` — after a restore or scrub,
  run named `tick`/`fixed` systems once (prime derived state such as
  `composeTransforms` output) and repaint through plugin `onRender`, without
  advancing `time.tick` or firing `tickStart`/`tickEnd` (2.3, SPEC §4.0).
  `runSystems` is for derived/transient state only; a recorder notes a gap.
- `hashSnapshot(snap, { includeChanges: true })` — canonical FNV-1a-64 hash;
  "same state" means equal hashes (the strict `includeChanges` form for live
  vs fork). `canonicalJson` (sorted keys, lossless `-0`) for keyframes,
  `hashEntities` to localize a divergence, `hashValue` for any plain data.
- `createRecorder(world, { hashEvery? })` / `replay(world, log, { base })` —
  record an act log (external commands, each step's dt and scale, input,
  strict-hash checkpoints) and re-run it on a fresh world built by the same
  setup; `encodeInput` / `decodeInput` turn an `InputSnapshot` into JSON and
  back (2.2, SPEC §7.5).
- `createBranch(setup, from, { fixedStep?, seed?, scale? })` / `runBranch(world,
  { steps, dt?, log?, probes?, sampleEvery?, keyframeEvery?, hashEvery?, until?,
  shouldStop? })` — a headless fork built by the same setup and restored from a
  snapshot, stepped with probe samples, keyframes, strict hashes, fault capture
  and cooperative cancellation, without touching the live world (2.2, SPEC §7.5).
- `dmath.sin` / `dmath.cos` / `dmath.sqrt`, and from 2.2 `dmath.atan2` /
  `dmath.hypot` / `dmath.pow` — bit-reproducible math (musl libm ports, `pow`
  from fdlibm; `sqrt` is `Math.sqrt`). Deterministic systems use these
  instead of `Math.sin` / `Math.cos` / `Math.atan2` / …, which differ by up
  to 1 ulp between engines.
- `BUILD_ID` — `'dev'` in source; stamped `<version>+g<sha>[-dirty]` in packed
  builds (every `@domecs/*` package exports it).
- `world.use(plugin)` — install plugins.

## Related packages

- `@domecs/dom` — retained-mode DOM renderer.
- `@domecs/input` — browser input collector plugin.

## License

MIT
