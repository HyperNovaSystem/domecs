// §7.1 (G4; O-80): act logs. A recorder writes down what entered a world
// from outside — external emits, the dt and scale of each step, the input
// systems saw — so a fresh world restored from the same base replays to the
// same strict hashes.
import type { GamepadSnapshot, InputSnapshot, PointerSnapshot } from './input.js'
import type { Entity } from './types.js'

/**
 * A JSON form of {@link InputSnapshot} (whose key sets are `Set`s). Key
 * arrays are sorted; `pressed`/`released` are omitted when empty, and
 * `mods`, `pointer`, `gamepads` and `focus` when they equal the empty input
 * (no modifier, pointer at rest at 0,0, no gamepad, no focus).
 */
export interface JsonInput {
  /** Held keys, sorted. */
  readonly keys: readonly string[]
  /** Keys pressed this render tick, sorted; omitted when empty. */
  readonly pressed?: readonly string[]
  /** Keys released this render tick, sorted; omitted when empty. */
  readonly released?: readonly string[]
  readonly mods?: { readonly ctrl: boolean; readonly alt: boolean; readonly shift: boolean; readonly meta: boolean }
  readonly pointer?: {
    readonly x: number
    readonly y: number
    readonly buttons: number
    readonly delta: { readonly x: number; readonly y: number }
    readonly wheel: number
    readonly entered: readonly Entity[]
  }
  readonly gamepads?: readonly GamepadSnapshot[]
  readonly focus?: { readonly activeTag: string; readonly consumesKeys: boolean }
}

const sorted = (set: ReadonlySet<string>): string[] => Array.from(set).sort()

/** `-0` is not the empty input's `0`: a lossless encoding keeps it. */
const isZero = (n: number): boolean => Object.is(n, 0)

function pointerAtRest(p: PointerSnapshot): boolean {
  return (
    isZero(p.x) &&
    isZero(p.y) &&
    isZero(p.buttons) &&
    isZero(p.delta.x) &&
    isZero(p.delta.y) &&
    isZero(p.wheel) &&
    p.entered.length === 0
  )
}

function copyGamepad(g: GamepadSnapshot): GamepadSnapshot {
  return {
    index: g.index,
    axes: Array.from(g.axes),
    buttons: g.buttons.map((b) => ({ pressed: b.pressed, value: b.value })),
  }
}

/**
 * Encode an input snapshot as plain JSON data (§7.1). The result shares no
 * object with `input`; {@link decodeInput} rebuilds an equal snapshot.
 */
export function encodeInput(input: InputSnapshot): JsonInput {
  const out: {
    keys: string[]
    pressed?: string[]
    released?: string[]
    mods?: NonNullable<JsonInput['mods']>
    pointer?: NonNullable<JsonInput['pointer']>
    gamepads?: GamepadSnapshot[]
    focus?: NonNullable<JsonInput['focus']>
  } = { keys: sorted(input.keys) }
  if (input.keyDelta.pressed.size > 0) out.pressed = sorted(input.keyDelta.pressed)
  if (input.keyDelta.released.size > 0) out.released = sorted(input.keyDelta.released)
  const m = input.mods
  if (m.ctrl || m.alt || m.shift || m.meta) {
    out.mods = { ctrl: m.ctrl, alt: m.alt, shift: m.shift, meta: m.meta }
  }
  const p = input.pointer
  if (!pointerAtRest(p)) {
    out.pointer = {
      x: p.x,
      y: p.y,
      buttons: p.buttons,
      delta: { x: p.delta.x, y: p.delta.y },
      wheel: p.wheel,
      entered: Array.from(p.entered),
    }
  }
  if (input.gamepads.length > 0) out.gamepads = input.gamepads.map(copyGamepad)
  const f = input.focus
  if (f.activeTag !== '' || f.consumesKeys) out.focus = { activeTag: f.activeTag, consumesKeys: f.consumesKeys }
  return out
}

/**
 * Rebuild an {@link InputSnapshot} from {@link encodeInput}'s form: `Set`s
 * for the key arrays, the empty input's value for every omitted part. The
 * result shares no object with `json`.
 */
export function decodeInput(json: JsonInput): InputSnapshot {
  const m = json.mods
  const p = json.pointer
  const f = json.focus
  return {
    keys: new Set(json.keys),
    keyDelta: { pressed: new Set(json.pressed ?? []), released: new Set(json.released ?? []) },
    mods: m
      ? { ctrl: m.ctrl, alt: m.alt, shift: m.shift, meta: m.meta }
      : { ctrl: false, alt: false, shift: false, meta: false },
    pointer: p
      ? {
          x: p.x,
          y: p.y,
          buttons: p.buttons,
          delta: { x: p.delta.x, y: p.delta.y },
          wheel: p.wheel,
          entered: Array.from(p.entered),
        }
      : { x: 0, y: 0, buttons: 0, delta: { x: 0, y: 0 }, wheel: 0, entered: [] },
    gamepads: (json.gamepads ?? []).map(copyGamepad),
    focus: f ? { activeTag: f.activeTag, consumesKeys: f.consumesKeys } : { activeTag: '', consumesKeys: false },
  }
}
