# @domecs/scene

Parent-child entity hierarchy for DOMECS (M4): a `Parent` component plus
tree-shaped queries, a despawn-orphan policy plugin, and parent-before-child
transform composition; and a world-bound spatial index (2.2).

## Install

```bash
npm install @domecs/scene
```

## Quick start

```ts
import { createWorld, defineComponent, entry } from '@domecs/core'
import {
  Parent,
  setParent,
  childrenOf,
  ancestorsOf,
  rootsOf,
  despawnTree,
  installHierarchy,
  composeTransforms,
} from '@domecs/scene'

// A group needs a persistent component of its own: snapshot pruning
// (persist's pruneTransientOnlyEntities) drops bare entities, which would
// orphan their children on save, load and every history undo.
const Group = defineComponent<{ name: string }>('Group')

const world = createWorld()
world.use(installHierarchy()) // reparent-to-root on plain despawn()

const root = world.spawn([entry(Group, { name: 'squad' })])
const child = world.spawn()
setParent(world, child, root) // { ok: true }

childrenOf(world, root) // [child]
ancestorsOf(world, child) // [root]
rootsOf(world) // every entity with no Parent, or Parent.entity === null

despawnTree(world, root) // despawns root AND child
```

## Main API

- `Parent` — `defineComponent<{ entity: Entity | null }>('Parent', ...)`.
  Ordinary (non-transient) component data: it round-trips through
  `world.snapshot()` / `world.restore()` for free.
- `setParent(world, child, parent)` — never throws; rejects (`{ ok: false,
  reason }`, no component touched) a parent that is not alive, self-parenting
  and cycles (parenting an ancestor under its own descendant). A parent with
  no persistent component is dropped by snapshot pruning — give groups one
  (see Quick start).
- `childrenOf(world, entity)` — direct children in ascending id order,
  recomputed every call (no cache: `WorldSignals` has no per-component
  "changed" event).
- `ancestorsOf(world, entity)` — `[parent, grandparent, ..., root]`, not
  including `entity` itself; terminates even over a corrupted/cyclic
  `Parent` graph.
- `rootsOf(world)` — every entity with no `Parent`, or `Parent.entity ===
  null`.
- `despawnTree(world, entity)` — despawns `entity` and every descendant
  (descendants before ancestors). Linear in the number of `Parent` holders,
  and terminates on a corrupted/cyclic `Parent` graph.
- `installHierarchy()` — `Plugin`; on a plain `world.despawn()`, reparents
  any live children of the despawned entity to `null` (root). Does **not**
  fire for `despawnTree`'s own cascade (descendants are already gone by the
  time an ancestor's despawn signal reaches this handler).
- `composeTransforms(Local, WorldT, compose, options?)` — `Plugin`; installs a
  `'tick'` system deriving `WorldT` from `Local` down the `Parent` hierarchy,
  always composing a parent before its children regardless of query/spawn
  order, at any chain depth. `WorldT` is marked changed only when a value
  moved (a field holding an object always counts as moved); an entity that
  loses `Local` loses `WorldT`; disposing the plugin removes its systems. `options.priority` places the
  system (default 0 — run what moves `Local` before it and what reads
  `WorldT` after it); `options.name` overrides the default
  `domecs-scene:compose-transforms:<Local>><WorldT>`, so one instance per
  component pair can be installed.
  `compose(parentWorld, local)` receives `parentWorld = null` at hierarchy
  roots and whenever the direct `Parent` target does not itself carry
  `Local`.

## Spatial index

`createSpatialHash(world, { component, x?, y?, cellSize })` indexes one
position component (fields `x`/`y` by default) for neighbour queries
(2.2; SPEC §2.12). It is built on the pure `createSpatialGrid` from
`@domecs/core`.

```ts
import { createWorld, defineComponent, entry } from '@domecs/core'
import { createSpatialHash } from '@domecs/scene'

const Pos = defineComponent<{ x: number; y: number }>('Pos', { defaults: { x: 0, y: 0 } })
const Prey = defineComponent<{ alert: boolean }>('Prey', { defaults: { alert: false } })

const world = createWorld({ headless: true })
const a = world.spawn([entry(Pos, { x: 0, y: 0 }), entry(Prey, { alert: false })])
const b = world.spawn([entry(Pos, { x: 3, y: 4 })])

const index = createSpatialHash(world, { component: Pos, cellSize: 8 })
index.within(0, 0, 5) // [a, b] — distance 5 is inclusive, ascending id
index.within(0, 0, 5, [Prey]) // [a] — must hold every listed component
index.nearest(1, 1, { exclude: a }) // b
index.pairs(5, Prey, Pos) // [[a, b]] — first holds Prey, second holds Pos
```

- `refresh()` rebuilds from the component's current values (O(n), ascending
  id). Positions are as of the last refresh (the index refreshes once at
  creation): call it once per step before querying. A field that is not a
  finite number is not indexed.
- Filters are read live with `world.has` at query time.
- `nearest(x, y, { maxDistance?, filter?, exclude? })`: minimum distance,
  ties → lowest id.
- `pairs(r, a, b)`: the first element holds `a`, the second `b`; for
  `a !== b` every such ordered pair, for `a === b` first < second; sorted.
- Results never depend on `cellSize` (a performance setting; about one
  entity per cell is a good start).
- Never snapshotted: building or querying leaves `hashSnapshot` unchanged;
  `refresh()` after `restore()`. `dispose()` drops it (later calls throw).

## Related packages

- `@domecs/core` — provides `World`, `defineComponent`, `definePlugin`,
  `world.snapshot()` / `world.restore()`, and `createSpatialGrid`.

## License

MIT
