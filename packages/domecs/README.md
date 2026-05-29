# @domecs/core

Core DOMECS runtime: entities, components, queries, systems, events, plugins,
time, RNG, and snapshots.

DOMECS is an ECS-first framework for DOM-heavy browser apps and games. This
package is intentionally renderer-agnostic; pair it with `@domecs/dom` for DOM
views and `@domecs/input` for browser input collection.

> Status: early alpha.

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
    for (const { id, value: pos } of w.entitiesWith(Position)) {
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
  (score, level, gravity); `world.resource(R)` / `setResource(R, v)` /
  `markResourceChanged(R)`. React to changes with `ChangedResource(R)`.
- `entry(component, value)` — typed helper for heterogeneous spawn arrays.
- `world.spawn(...)` / `world.despawn(...)` — manage entities.
- `world.addComponent(...)`, `getComponent(...)`, `removeComponent(...)` —
  manage component data.
- `world.query(...)` / `world.observe(...)` — query and observe entity sets.
- Query helpers: `Has`, `Not`, `Or`, `And`, `Added`, `Removed`, `Changed`,
  `Where`, `ChangedResource`.
- `world.system(name, def, fn)` — register `tick`, `fixed`, `event`, `once`, or
  `reactive` systems.
- `defineEvent<T>(name)`, `world.emit(...)`, `world.on(...)` — buffered events.
- `world.snapshot()` / `world.restore(...)` — serialize and restore world state.
- `world.use(plugin)` — install plugins.

## Related packages

- `@domecs/dom` — retained-mode DOM renderer.
- `@domecs/input` — browser input collector plugin.

## License

MIT
