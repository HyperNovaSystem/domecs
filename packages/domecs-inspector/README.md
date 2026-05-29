# @domecs/inspector

Headless fault/state observation surface for DOMECS dev tools.

Surfaces `Faulted` entity components and systemic faults from
`world.signals.faultRaised` into a queryable, filter-composable view. The
package has **no DOM dependency** — UI panels (Studio, custom devtools) wrap
this surface. See `doc/BETTER_ERRORS.md` §"Phase 3 — Inspector integration".

> Status: early alpha.

## Install

```bash
npm install @domecs/inspector
```

## Quick start

```ts
import { createWorld } from '@domecs/core'
import { createInspector } from '@domecs/inspector'

const world = createWorld()
const inspector = createInspector()
world.use(inspector.plugin)

world.step(1 / 60)

// Read accumulated faults + timeline for a dev panel.
for (const entry of inspector.view.entries) {
  console.log(entry.source, entry.kind, entry.detail)
}

// Filters compose and return immutable snapshot views.
const recoverable = inspector.view.recoverableOnly().bySource('physics')
```

## Main API

- `createInspector(options?)` — returns an `InspectorBundle`
  (`{ plugin, view, clear() }`); install `bundle.plugin` via `world.use`.
- `InspectorView` — queryable, filter-composable fault/timeline projection
  (`bySource`, `byKind`, `byTick`, `recoverableOnly`, `onlyFaulted`, …).
- `InspectorEntry` / `TimelineEvent` — individual fault and timeline rows.

## Related packages

- `@domecs/core` — ECS runtime that emits the faults this observes.

## License

MIT
