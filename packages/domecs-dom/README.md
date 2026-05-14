# @domecs/dom

Retained-mode DOM renderer for DOMECS worlds.

`@domecs/dom` maps ECS queries to DOM elements. A view creates one element for
each matching entity, updates it after render ticks, and destroys it when the
entity stops matching.

> Status: early alpha.

## Install

```bash
npm install @domecs/core @domecs/dom
```

## Quick start

```ts
import { createWorld, defineComponent, entry } from '@domecs/core'
import { defineView, mountDOM } from '@domecs/dom'

// Dual-type-arg form captures each component's literal name, so tuple-form
// queries deliver a typed `entity.Position` / `entity.Label` to view
// callbacks. The single-arg form `defineComponent<T>('Name')` still works
// but the callbacks fall back to the unconstrained EntityView shape.
const Position = defineComponent<{ x: number; y: number }, 'Position'>('Position')
const Label = defineComponent<{ text: string }, 'Label'>('Label')

const world = createWorld()

world.spawn([
  entry(Position, { x: 24, y: 48 }),
  entry(Label, { text: 'Player' }),
])

const actorView = defineView({
  slot: 'actors',
  // Tuple query → typed `entity.Position` / `entity.Label` below.
  // `changedOn` omitted: the renderer auto-derives [Position, Label] from
  // the query's Has(T) leaves, so the view redraws when either component
  // is marked changed and stays silent otherwise.
  query: [Position, Label] as const,

  create(entity) {
    const el = document.createElement('div')
    el.className = 'actor'
    el.textContent = entity.Label.text
    el.style.transform = `translate(${entity.Position.x}px, ${entity.Position.y}px)`
    return el
  },

  update(el, entity) {
    el.textContent = entity.Label.text
    el.style.transform = `translate(${entity.Position.x}px, ${entity.Position.y}px)`
  },
})

const mount = mountDOM(world, {
  slots: {
    actors: document.querySelector<HTMLElement>('#actors')!,
  },
  views: [actorView],
})

world.step()

// Later:
mount.teardown()
```

## How it works

- `defineView(def)` declares a DOM view.
- `mountDOM(world, { slots, views })` claims named DOM slots for one world.
- Each view has a `query`; matching entities get mounted into the view's slot.
- `create(entity)` returns the element for a matching entity.
- `update(el, entity)` runs during render commits. By default it is gated
  on `Changed(T)` for every `Has(T)` leaf in the view's `query`. Pass an
  explicit `changedOn` array to narrow the gate, or `changedOn: []` to
  redraw every tick (e.g. for time-driven animations).
- `destroy(el, entity)` is called before an element is removed.
- `teardown()` uninstalls the renderer plugin and removes mounted elements.

`mountDOM` installs an internal DOMECS plugin and commits DOM changes from the
world render phase, so it works with both manual `world.step()` loops and
`world.start()`.

The package is safe to import in Node/headless tests. `mountDOM` itself expects
caller-provided slots for real views; it never looks up `document` on import.

## Related packages

- `@domecs/core` — core ECS runtime.
- `@domecs/input` — browser input collector plugin.

## License

MIT
