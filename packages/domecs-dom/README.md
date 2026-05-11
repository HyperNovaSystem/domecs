# domecs-dom

Retained-mode DOM renderer for DOMECS worlds.

`domecs-dom` maps ECS queries to DOM elements. A view creates one element for
each matching entity, updates it after render ticks, and destroys it when the
entity stops matching.

> Status: early alpha.

## Install

```bash
npm install domecs domecs-dom
```

## Quick start

```ts
import { createWorld, defineComponent, entry } from 'domecs'
import { defineView, mountDOM } from 'domecs-dom'

const Position = defineComponent<{ x: number; y: number }>('Position')
const Label = defineComponent<{ text: string }>('Label')

const world = createWorld()

world.spawn([
  entry(Position, { x: 24, y: 48 }),
  entry(Label, { text: 'Player' }),
])

function syncActor(el: HTMLElement, entity: { Position?: unknown; Label?: unknown }) {
  const position = entity.Position as { x: number; y: number }
  const label = entity.Label as { text: string }
  el.textContent = label.text
  el.style.transform = `translate(${position.x}px, ${position.y}px)`
}

const actorView = defineView({
  slot: 'actors',
  query: [Position, Label],
  changedOn: [Position, Label],

  create(entity) {
    const el = document.createElement('div')
    el.className = 'actor'
    syncActor(el, entity)
    return el
  },

  update: syncActor,
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
- `update(el, entity)` runs during render commits. Use `changedOn` to limit
  updates to entities whose listed components changed.
- `destroy(el, entity)` is called before an element is removed.
- `teardown()` uninstalls the renderer plugin and removes mounted elements.

`mountDOM` installs an internal DOMECS plugin and commits DOM changes from the
world render phase, so it works with both manual `world.step()` loops and
`world.start()`.

## Related packages

- `domecs` — core ECS runtime.
- `domecs-input` — browser input collector plugin.

## License

MIT
