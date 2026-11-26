# @domecs/dom

Retained-mode DOM renderer for DOMECS worlds.

`@domecs/dom` maps ECS queries to DOM elements. A view creates one element for
each matching entity, updates it after render ticks, and destroys it when the
entity stops matching.

> Status: v2.x — **API-stable** (semver honored; product contract still hardening).

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

// `mountDOM` returns a `Result<MountHandle, MountError>` — unwrap it before use.
const mounted = mountDOM(world, {
  slots: {
    actors: document.querySelector<HTMLElement>('#actors')!,
  },
  views: [actorView],
})

if (!mounted.ok) {
  // e.g. { kind: 'slot_already_mounted' | 'unregistered_slot' | 'plugin_install_failed'
  //            | 'invalid_view_query' | 'invalid_changed_on' }
  console.error('mountDOM failed:', mounted.error)
} else {
  const mount = mounted.value

  world.stepOnce()

  // Later:
  mount.teardown()
}
```

## How it works

- `defineView(def)` declares a DOM view.
- `mountDOM(world, { slots, views })` claims named DOM slots for one world.
  A world can take several mounts, each on its own slots.
- Each view has a `query`; matching entities get mounted into the view's slot.
  A `Where` filter is honored: entities mount when they start passing it and
  unmount when they stop (checked at each render commit). Temporal nodes
  (`OnAdded`/`OnRemoved`/`OnChanged`/`OnChangedResource`) are rejected with
  `invalid_view_query` — use `changedOn` for change-gated redraws.
- `create(entity)` returns the element for a matching entity.
- `update(el, entity)` runs during render commits. It runs once when a node
  is first created (first paint, O-2 — so static entities render without a
  mark), then is gated on `OnChanged(T)` for every `Has(T)` and `Where(T, …)`
  leaf in the view's `query` (not under `Not`); a view with `update` and no
  such leaf, or an empty explicit list, is rejected with
  `invalid_changed_on`. Pass `changedOn: { mode: 'explicit', types: [Position] }`
  to narrow the gate, or `changedOn: { mode: 'legacy' }` to redraw every
  tick (e.g. for time-driven animations).
- `changedOn: { mode: 'auto', resources: [Camera] }` also redraws every
  mounted node when a listed resource is set or marked (an explicit gate may
  list only resources).
- `destroy(el, entity)` is called before an element is removed.
- `teardown()` uninstalls the renderer plugin and removes mounted elements.

### Nesting, order and events

```ts
const ships = defineView({ slot: 'stage', query: [Ship], create: shipElement })
const boxes = defineView({
  slot: 'stage',
  query: [Box, OnStage],
  parent: { view: ships, of: (e) => e.Box.holder, at: '.deck' }, // inside the holder's deck
  create: boxElement,
  update: () => {},                                              // re-parent on change
})
const roadstead = defineView({ slot: 'queue', query: [Waiting], order: (e) => e.Waiting.rank, create: row })

const handle = mountDOM(world, { slots, views: [ships, boxes, roadstead] })
if (!handle.ok) throw new Error(handle.error.kind)
handle.value.on('stage', 'click', (entity) => select(entity)) // the innermost entity clicked
handle.value.elementOf(ships, ship)                            // for an outline or a tooltip
```

- `parent` mounts each element inside another view's element, moves it when
  the parent changes on update, and keeps it mounted but out of the page while
  the parent has no element. Parents commit first.
- `order(entity)` keeps a view's nodes sorted within each container.
- Every mounted element carries `data-entity="<id>"`; `entityOf(target)` reads
  it back from an event target, and `handle.on(slot, type, fn)` delegates.

### Panels and `paint`

A panel that sums up many entities — a side panel, a status bar — is markup,
not one element per entity:

```ts
import { definePanel, watchPresses } from '@domecs/dom'

watchPresses(document) // once: no repaint lands between a press and its click
mountDOM(world, {
  slots: { side: document.querySelector('#side')! },
  views: [],
  panels: [definePanel({
    slot: 'side',
    changedOn: { types: [Crane], resources: [Cash] },
    render: (w) => `<p>Cash ${w.getResource(Cash)}</p>${craneRows(w)}`,
  })],
})
```

The markup is written with `paint(el, html)`, which patches the DOM in place
(an element with the same tag is kept) and writes nothing when the markup is
unchanged, so focus and the button under the pointer survive a repaint.
`innerHTML` would replace the pressed button before its click.

`mountDOM` installs an internal DOMECS plugin and commits DOM changes from the
world render phase, so it works with both manual `world.step(dt)` loops and
`world.startLoop()`.

The package is safe to import in Node/headless tests. `mountDOM` itself expects
caller-provided slots for real views; it never looks up `document` on import.

## Related packages

- `@domecs/core` — core ECS runtime.
- `@domecs/input` — browser input collector plugin.

## License

MIT
