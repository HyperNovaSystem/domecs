// v0.1 stub: headless worlds run without a real InputCollector. The input
// plugin (SPEC §6) will replace this with a browser-backed snapshot.
export interface PointerSnapshot {
  x: number
  y: number
  buttons: number
  delta: { x: number; y: number }
  wheel: number
  entered: readonly number[]
}

export interface GamepadSnapshot {
  index: number
  axes: readonly number[]
  buttons: readonly { pressed: boolean; value: number }[]
}

export interface InputSnapshot {
  readonly keys: ReadonlySet<string>
  readonly keyDelta: {
    pressed: ReadonlySet<string>
    released: ReadonlySet<string>
  }
  readonly mods: Readonly<{
    ctrl: boolean
    alt: boolean
    shift: boolean
    meta: boolean
  }>
  readonly pointer: PointerSnapshot
  readonly gamepads: readonly GamepadSnapshot[]
  readonly focus: { activeTag: string; consumesKeys: boolean }
}

export function emptyInput(): InputSnapshot {
  return {
    keys: new Set(),
    keyDelta: { pressed: new Set(), released: new Set() },
    mods: { ctrl: false, alt: false, shift: false, meta: false },
    pointer: { x: 0, y: 0, buttons: 0, delta: { x: 0, y: 0 }, wheel: 0, entered: [] },
    gamepads: [],
    focus: { activeTag: '', consumesKeys: false },
  }
}
