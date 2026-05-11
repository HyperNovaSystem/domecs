# roguelike — DOMECS v0.1 exemplar

A turn-based roguelike exemplar for DOMECS. It can run headless in Vitest or
as a browser demo through Vite. The game world is a 128×128 dungeon, while the
browser viewport remains 48×32 cells and follows the player with a clamped
camera. The map is populated with deterministic enemy actors and resource
pickups in addition to the player.

## What it validates

Each test maps to a SPEC contract:

- **Large tile grid spawn** — §2 world/entities, archetype churn at scale
  (~16k tile entities before actors/resources).
- **Turn-based scheduling** via `world.turn(event, payload)` — §3 scheduling
  modes (idle worlds do not advance without an action).
- **Event-driven movement system** on `MoveEvent` — §2.6 event buffer.
- **Reactive FOV system** firing on player position change — §4 step 6.
- **Plugin + capability registry** via `spatialIndexPlugin()` — §9 plugin
  lifecycle, §9.3 capability ownership.
- **Snapshot / restore roundtrip** with transient component exclusion — §7
  (`Highlight` is declared `transient: true` and must not survive a snapshot).
- **PRNG determinism** — §2.8 seeded `world.rand`; two worlds with the same
  seed produce byte-identical maps and population.
- **Query predicates** — `Has`, `And`, `Not` against the live archetype index.
- **Browser DOM view** — `domecs-dom` renders tiles and renderable entities,
  with a camera transform over the larger map.

See [`test/roguelike.test.ts`](./test/roguelike.test.ts) for the full
behavioral spec.

## Run

```sh
pnpm test
pnpm dev
pnpm build
```

`pnpm test` typechecks and runs the headless suite. `pnpm dev` starts the
playable browser demo.

## Files

- [`src/components.ts`](./src/components.ts) — `Position`, `Tile`, `Actor`,
  `Resource`, `Player`, `Visible`, `Renderable`, `Highlight` (transient).
- [`src/spatial.ts`](./src/spatial.ts) — `spatialIndexPlugin`: grid bucket index
  rebuilt at `onTickStart`; exposes a `spatial-index` capability.
- [`src/game.ts`](./src/game.ts) — `createRoguelike()` factory, deterministic
  map/population generation, movement system, FOV system, helper queries.
- [`src/main.ts`](./src/main.ts) — browser DOM views, input wiring, fixed-size
  viewport, player-following camera, HUD.
- [`src/camera.ts`](./src/camera.ts) — pure camera origin helper shared by the
  browser demo and tests.
- [`src/index.ts`](./src/index.ts) — public re-exports for the tests and demo.
- [`test/roguelike.test.ts`](./test/roguelike.test.ts) — canonical behavior
  spec.

## Related

- [`doc/SPEC.md`](../../doc/SPEC.md) — the normative contract being validated
  here.
- [`doc/findings.md`](../../doc/findings.md) — implementation findings surfaced
  while building this exemplar.
- [`packages/domecs-dom`](../../packages/domecs-dom) — SPEC §5 renderer.
- [`packages/domecs-input`](../../packages/domecs-input) — input collector used
  by the browser demo.
