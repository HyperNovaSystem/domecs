// v0.1 stub: headless worlds run without a real InputCollector. The input
// plugin (SPEC §6) will replace this with a browser-backed snapshot.
import type { Entity } from './types.js'

/** Per-frame pointer state. Frame-relative deltas (`delta`, `wheel`) accumulate
 * over the frame's events and reset to zero each tick. */
export interface PointerSnapshot {
  /** Pointer X in client (CSS) pixels, relative to the pointer target. */
  x: number
  /** Pointer Y in client (CSS) pixels, relative to the pointer target. */
  y: number
  /** Bitmask of currently-held pointer buttons (the DOM `PointerEvent.buttons`
   * value: 1 = primary, 2 = secondary, 4 = auxiliary/middle, …). */
  buttons: number
  /** Pointer movement accumulated this frame, in client (CSS) pixels. `+x` is
   * rightward, `+y` is downward (screen convention). Resets to `{0,0}` each tick. */
  delta: { x: number; y: number }
  /** Wheel scroll accumulated this frame, summed from `WheelEvent.deltaY`.
   * Sign follows the DOM convention: **positive = scrolled down / away from the
   * user**, negative = scrolled up / toward the user. Magnitude is in the units
   * the browser reports for `deltaY` (typically pixels; per the event's
   * `deltaMode` it may instead be lines or pages). Resets to `0` each tick. */
  wheel: number
  /** Entities the pointer entered this frame. Identifiers are plain {@link Entity}
   * values. Empty in the headless stub. */
  entered: readonly Entity[]
}

/** Snapshot of one connected gamepad, mirroring the Gamepad API. */
export interface GamepadSnapshot {
  /** The gamepad's slot index, as reported by `navigator.getGamepads()`. */
  index: number
  /** Analog axis positions, each normalized to `-1..1`. */
  axes: readonly number[]
  /** Per-button state. `value` is the analog press depth in the range `0..1`
   * (`0` released, `1` fully pressed); `pressed` is the digital threshold. */
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
