# roguelike — DOMECS v0.1 exemplar

A headless, turn-based roguelike. The first exemplar shipped with
DOMECS, purpose-built to validate the v0.1 engine surface — zero DOM,
zero browser, zero `requestAnimationFrame`. It lives as a vitest suite
that spawns a 128×128 grid (~16k entities), seats a player, wires a
movement system behind a `MoveEvent`, and asserts the engine behaves
per [`doc/SPEC.md`](../../doc/SPEC.md).

## What it validates

Each test maps to a SPEC contract:

- **16k-entity grid spawn** — §2 world/entities, archetype churn at scale.
- **Turn-based scheduling** via `world.turn(event, payload)` — §3
  scheduling modes (idle worlds do not advance without an action).
- **Event-driven movement system** on `MoveEvent` — §2.6 event buffer.
- **Reactive FOV system** firing on player position change — §4 step 6.
  (Open: [R-1](../../doc/findings.md) — current `reactsTo` clause uses
  `Has(...)` rather than `Changed(Position)`, Reqall #1810.)
- **Plugin + capability registry** via `spatialIndexPlugin()` — §9
  plugin lifecycle, §9.3 capability ownership.
- **Snapshot / restore roundtrip** with transient component exclusion —
  §7 (`Highlight` is declared `transient: true` and must not survive a
  snapshot).
- **PRNG determinism** — §2.8 seeded `world.rand`; two worlds with the
  same seed produce byte-identical maps.
- **Query predicates** — `Has`, `And`, `Not` against the live archetype
  index.

See [`test/roguelike.test.ts`](./test/roguelike.test.ts) for the full
behavioral spec.

## Run

```
pnpm test
```

or `pnpm test:watch` for iterative work. There is intentionally **no**
`start` or `dev` script — the exemplar is headless. A playable version
waits on [`packages/domecs-dom`](../../packages/domecs-dom) (SPEC §5
renderer) plus an `InputCollector` (SPEC §6).

## Files

- [`src/components.ts`](./src/components.ts) — `Position`, `Tile`,
  `Actor`, `Player`, `Visible`, `Renderable`, `Highlight` (transient).
- [`src/spatial.ts`](./src/spatial.ts) — `spatialIndexPlugin`: grid
  bucket index rebuilt at `onTickStart`; exposes a `spatial-index`
  capability.
- [`src/game.ts`](./src/game.ts) — `createRoguelike()` factory, movement
  system (reads `MoveEvent`, writes `Position`, calls
  `world.markChanged`), FOV system (reactive), helper queries.
- [`src/index.ts`](./src/index.ts) — public re-exports for the tests.
- [`test/roguelike.test.ts`](./test/roguelike.test.ts) — 10 tests; the
  canonical behavior spec.

## Related

- [`doc/SPEC.md`](../../doc/SPEC.md) — the normative contract being
  validated here.
- [`doc/findings.md`](../../doc/findings.md) — implementation findings
  surfaced while building this exemplar (F-1 through F-5).
- [`packages/domecs-dom`](../../packages/domecs-dom) — SPEC §5 renderer;
  the next milestone toward a playable build.
