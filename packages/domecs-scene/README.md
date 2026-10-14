# @domecs/scene

Parent-child entity hierarchy for DOMECS (M4): a `Parent` component plus
tree-shaped queries, a despawn-orphan policy plugin, and parent-before-child
transform composition.

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
- `childrenOf(world, entity)` — direct children, recomputed every call (no
  cache: `WorldSignals` has no per-component "changed" event).
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
- `composeTransforms(Local, WorldT, compose)` — `Plugin`; installs a `'tick'`
  system deriving `WorldT` from `Local` down the `Parent` hierarchy, always
  composing a parent before its children regardless of query/spawn order,
  at any chain depth.
  `compose(parentWorld, local)` receives `parentWorld = null` at hierarchy
  roots and whenever the direct `Parent` target does not itself carry
  `Local`.

## Related packages

- `@domecs/core` — provides `World`, `defineComponent`, `definePlugin`,
  `world.snapshot()` / `world.restore()`.

## License

MIT
