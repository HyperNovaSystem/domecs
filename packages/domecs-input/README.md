# @domecs/input

Browser input collector plugin for DOMECS.

`@domecs/input` listens to keyboard, pointer, wheel, focus, and gamepad state and
publishes a per-tick `InputSnapshot` to `world.input`.

> Status: early alpha.

## Install

```bash
npm install @domecs/core @domecs/input
```

## Quick start

```ts
import { createWorld } from '@domecs/core'
import { createInputPlugin } from '@domecs/input'

const world = createWorld()
const stage = document.querySelector<HTMLElement>('#stage')!

world.use(createInputPlugin({
  keyTarget: document,
  pointerTarget: stage,
  wheelTarget: stage,
  preventDefaultKeys: true,
}))

world.system('controls', { schedule: 'tick' }, ({ input }) => {
  if (input.keyDelta.pressed.has('Space')) {
    console.log('jump')
  }

  if (input.keys.has('ArrowLeft')) {
    console.log('move left')
  }

  if (input.pointer.buttons !== 0) {
    console.log('pointer down at', input.pointer.x, input.pointer.y)
  }
})

world.start()
```

## Snapshot shape

The plugin writes an `InputSnapshot` at tick start:

- `keys` — currently held keyboard `KeyboardEvent.code` values.
- `keyDelta.pressed` — keys pressed since the previous snapshot.
- `keyDelta.released` — keys released since the previous snapshot.
- `mods` — `ctrl`, `alt`, `shift`, `meta` modifier state.
- `pointer` — pointer position, buttons, movement delta, wheel delta, and
  reserved `entered` entity ids. The collector currently leaves `entered`
  empty.
- `gamepads` — current gamepad axes/buttons when available and enabled.
- `focus` — active element tag and whether it consumes keyboard input.

Pointer coordinates are currently raw browser client coordinates.

## Options

```ts
createInputPlugin({
  keyTarget?: Document | HTMLElement
  pointerTarget?: Document | HTMLElement
  wheelTarget?: Document | HTMLElement
  clearOnBlur?: boolean
  textInputSelector?: string
  pollGamepads?: boolean
  preventDefaultKeys?: boolean
})
```

Defaults:

- `keyTarget`: `document`
- `pointerTarget`: `document`
- `wheelTarget`: `pointerTarget`
- `clearOnBlur`: `true`
- `textInputSelector`: `input,textarea,[contenteditable="true"]`
- `pollGamepads`: `true` when `navigator.getGamepads` exists
- `preventDefaultKeys`: `false`

## Headless tests

For deterministic tests without browser events, you can bypass this plugin and
set input directly:

```ts
world.setInput(snapshot)
world.step()
```

## Related packages

- `@domecs/core` — core ECS runtime.
- `@domecs/dom` — retained-mode DOM renderer.

## License

MIT
