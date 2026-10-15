import type { DomecsError, GamepadSnapshot, InputSnapshot, Plugin, PluginHandle, PointerSnapshot, Result, World } from '@domecs/core'
import { ok } from '@domecs/core'

export interface InputPluginOptions {
  /** Element receiving keyboard events. Default: document. */
  readonly keyTarget?: Document | HTMLElement
  /**
   * Element receiving pointer events. Default: document. Coordinates are the
   * events' viewport `clientX`/`clientY`, not relative to this element
   * (SPEC §6); subtract its `getBoundingClientRect()` for local coordinates.
   */
  readonly pointerTarget?: Document | HTMLElement
  /** Element receiving wheel events. Default: pointerTarget. */
  readonly wheelTarget?: Document | HTMLElement
  /** Should held keys be cleared when the window loses focus? Default: true. */
  readonly clearOnBlur?: boolean
  /**
   * CSS selector for focused elements that take typing, whose keys pass
   * through. Default {@link TEXT_INPUT_SELECTOR}: text-like `input`s (not
   * checkboxes, radios, ranges, buttons, colour or file pickers),
   * `textarea`, `select` and any `contenteditable` other than `"false"`.
   */
  readonly textInputSelector?: string
  /** Whether to read gamepads via navigator.getGamepads(). Default: true in browsers that expose it. */
  readonly pollGamepads?: boolean
  /** If true, calls preventDefault() on handled keydown events. Default: false. */
  readonly preventDefaultKeys?: boolean
}

interface MutablePointer {
  x: number
  y: number
  buttons: number
  deltaX: number
  deltaY: number
  wheel: number
  entered: number[]
}

/**
 * The environment-independent default {@link InputPluginOptions}. The target
 * options (`keyTarget`/`pointerTarget`/`wheelTarget`) and `pollGamepads`
 * are derived from `document`/`navigator` at install time and so are not
 * representable as static constants; they are omitted here.
 */
/** O-59 (I6): the default {@link InputPluginOptions.textInputSelector}. */
export const TEXT_INPUT_SELECTOR =
  'input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button])' +
  ':not([type=submit]):not([type=reset]):not([type=color]):not([type=file]):not([type=image]),' +
  'textarea,select,[contenteditable]:not([contenteditable="false"])'

export const DEFAULT_INPUT_OPTIONS = Object.freeze({
  clearOnBlur: true,
  textInputSelector: TEXT_INPUT_SELECTOR,
  preventDefaultKeys: false,
} as const satisfies Partial<InputPluginOptions>)

export function createInputPlugin(options: InputPluginOptions = {}): Plugin {
  return {
    name: '@domecs/input',
    install(world: World): Result<PluginHandle, DomecsError> {
      // External event sources rouse the idle driver via the public
      // `world.requestTick()`.
      const wake = (): void => world.requestTick()
      const doc = typeof document !== 'undefined' ? document : undefined
      const win = typeof window !== 'undefined' ? window : undefined
      const keyTarget = (options.keyTarget ?? doc) as EventTarget | undefined
      const pointerTarget = (options.pointerTarget ?? doc) as EventTarget | undefined
      const wheelTarget = (options.wheelTarget ?? pointerTarget) as EventTarget | undefined
      const clearOnBlur = options.clearOnBlur ?? DEFAULT_INPUT_OPTIONS.clearOnBlur
      const textSelector = options.textInputSelector ?? DEFAULT_INPUT_OPTIONS.textInputSelector
      const pollGamepads =
        options.pollGamepads ?? (typeof navigator !== 'undefined' && !!(navigator as Navigator).getGamepads)
      const preventDefaultKeys = options.preventDefaultKeys ?? DEFAULT_INPUT_OPTIONS.preventDefaultKeys

      const held = new Set<string>()
      const pressedNext = new Set<string>()
      const releasedNext = new Set<string>()
      const mods = { ctrl: false, alt: false, shift: false, meta: false }
      const pointer: MutablePointer = {
        x: 0,
        y: 0,
        buttons: 0,
        deltaX: 0,
        deltaY: 0,
        wheel: 0,
        entered: [],
      }

      function shouldCaptureKeys(): boolean {
        return !currentFocus().consumesKeys
      }

      function onKeyDown(ev: Event): void {
        const e = ev as KeyboardEvent
        if (e.repeat) {
          syncMods(e)
          return
        }
        if (!shouldCaptureKeys()) {
          syncMods(e)
          return
        }
        const code = e.code
        if (!held.has(code)) {
          held.add(code)
          pressedNext.add(code)
          releasedNext.delete(code)
        }
        syncMods(e)
        if (preventDefaultKeys && isHandledKey(code)) e.preventDefault()
        wake()
      }
      function onKeyUp(ev: Event): void {
        const e = ev as KeyboardEvent
        // O-56: a release is always processed, even while a text input has
        // focus — a key pressed in the game and released in a textarea
        // must not stay held. Only presses pass through to text inputs.
        const code = e.code
        if (held.delete(code)) {
          releasedNext.add(code)
          pressedNext.delete(code)
        }
        syncMods(e)
        wake()
      }
      function onBlur(): void {
        if (!clearOnBlur) return
        // O-59: pointer buttons stick otherwise; the up event goes elsewhere.
        pointer.buttons = 0
        releaseKeys()
      }
      function releaseKeys(): void {
        for (const c of held) releasedNext.add(c)
        held.clear()
        mods.ctrl = mods.alt = mods.shift = mods.meta = false
        wake()
      }
      // O-56: with an element keyTarget, keyup events after focus leaves it
      // never reach the plugin, so held keys are released when it loses
      // focus — not only when the whole window does. Pointer buttons are
      // left alone: focus moves on mousedown, while a button is held.
      function onFocusOut(ev: Event): void {
        if (!clearOnBlur) return
        const next = (ev as FocusEvent).relatedTarget as Node | null
        const target = keyTarget as unknown as Node
        if (next && typeof target.contains === 'function' && target.contains(next)) return
        releaseKeys()
      }
      function syncMods(e: KeyboardEvent): void {
        mods.ctrl = e.ctrlKey
        mods.alt = e.altKey
        mods.shift = e.shiftKey
        mods.meta = e.metaKey
      }
      function isHandledKey(code: string): boolean {
        // Prevent default for game-ish keys only; leave F-keys, Tab alone.
        return (
          code.startsWith('Arrow') ||
          code === 'Space' ||
          code === 'Enter' ||
          /^Key[A-Z]$/.test(code) ||
          /^Digit\d$/.test(code)
        )
      }

      // O-59 (I6): no delta until a position is known, so the first move
      // is not measured from (0, 0).
      let hasPosition = false
      function onPointerMove(ev: Event): void {
        const e = ev as PointerEvent
        const prevX = pointer.x
        const prevY = pointer.y
        pointer.x = e.clientX
        pointer.y = e.clientY
        if (doc?.pointerLockElement) {
          // Under pointer lock the position is frozen; the motion is in
          // movementX/Y.
          pointer.deltaX += e.movementX ?? 0
          pointer.deltaY += e.movementY ?? 0
        } else if (hasPosition) {
          pointer.deltaX += pointer.x - prevX
          pointer.deltaY += pointer.y - prevY
        }
        hasPosition = true
        pointer.buttons = e.buttons
        wake()
      }
      function onPointerDown(ev: Event): void {
        const e = ev as PointerEvent
        hasPosition = true
        pointer.x = e.clientX
        pointer.y = e.clientY
        pointer.buttons = e.buttons
        wake()
      }
      function onPointerUp(ev: Event): void {
        const e = ev as PointerEvent
        pointer.buttons = e.buttons
        wake()
      }
      // O-59: a cancelled pointer never sends pointerup.
      function onPointerCancel(): void {
        pointer.buttons = 0
        wake()
      }
      // Losing capture does not release a button (capture can move mid-drag),
      // so take the event's own button state.
      function onLostCapture(ev: Event): void {
        pointer.buttons = (ev as PointerEvent).buttons ?? 0
        wake()
      }
      function onWheel(ev: Event): void {
        const e = ev as WheelEvent
        pointer.wheel += e.deltaY
        wake()
      }

      keyTarget?.addEventListener('keydown', onKeyDown)
      keyTarget?.addEventListener('keyup', onKeyUp)
      win?.addEventListener('blur', onBlur)
      const keyTargetIsElement = !!keyTarget && keyTarget !== doc
      if (keyTargetIsElement) keyTarget.addEventListener('focusout', onFocusOut)
      pointerTarget?.addEventListener('pointermove', onPointerMove)
      pointerTarget?.addEventListener('pointerdown', onPointerDown)
      pointerTarget?.addEventListener('pointerup', onPointerUp)
      pointerTarget?.addEventListener('pointercancel', onPointerCancel)
      pointerTarget?.addEventListener('lostpointercapture', onLostCapture)
      wheelTarget?.addEventListener('wheel', onWheel, { passive: true } as AddEventListenerOptions)

      function currentFocus(): { activeTag: string; consumesKeys: boolean } {
        if (!doc) return { activeTag: '', consumesKeys: false }
        const el = doc.activeElement as HTMLElement | null
        if (!el) return { activeTag: '', consumesKeys: false }
        const tag = el.tagName.toLowerCase()
        let consumes = false
        try {
          consumes = !!el.matches?.(textSelector)
        } catch {
          consumes = tag === 'input' || tag === 'textarea'
        }
        return { activeTag: tag, consumesKeys: consumes }
      }

      function readGamepads(): GamepadSnapshot[] {
        if (!pollGamepads || typeof navigator === 'undefined') return []
        const getter = (navigator as Navigator).getGamepads
        if (!getter) return []
        const pads = getter.call(navigator)
        const out: GamepadSnapshot[] = []
        for (const g of pads) {
          if (!g) continue
          out.push({
            index: g.index,
            axes: Array.from(g.axes),
            buttons: g.buttons.map((b) => ({ pressed: b.pressed, value: b.value })),
          })
        }
        return out
      }

      /**
       * @param consume false on a heartbeat (O-57): no system runs, so the
       *   edges and deltas are kept for the next real tick and the heartbeat
       *   publishes none — a `tickStart` hotkey must not see a press twice.
       *   Held keys, position and buttons are current either way.
       */
      function build(consume: boolean): InputSnapshot {
        const pressed = consume ? new Set(pressedNext) : new Set<string>()
        const released = consume ? new Set(releasedNext) : new Set<string>()
        const pSnap: PointerSnapshot = {
          x: pointer.x,
          y: pointer.y,
          buttons: pointer.buttons,
          delta: consume ? { x: pointer.deltaX, y: pointer.deltaY } : { x: 0, y: 0 },
          wheel: consume ? pointer.wheel : 0,
          entered: pointer.entered.slice(),
        }
        if (consume) {
          pressedNext.clear()
          releasedNext.clear()
          pointer.deltaX = 0
          pointer.deltaY = 0
          pointer.wheel = 0
        }
        return {
          keys: new Set(held),
          keyDelta: { pressed, released },
          mods: { ...mods },
          pointer: pSnap,
          gamepads: readGamepads(),
          focus: currentFocus(),
        }
      }

      return ok({
        onTickStart(_world, info) {
          world.setInput(build(!info.heartbeat))
        },
        teardown() {
          keyTarget?.removeEventListener('keydown', onKeyDown)
          keyTarget?.removeEventListener('keyup', onKeyUp)
          win?.removeEventListener('blur', onBlur)
          if (keyTargetIsElement) keyTarget.removeEventListener('focusout', onFocusOut)
          pointerTarget?.removeEventListener('pointermove', onPointerMove)
          pointerTarget?.removeEventListener('pointerdown', onPointerDown)
          pointerTarget?.removeEventListener('pointerup', onPointerUp)
          pointerTarget?.removeEventListener('pointercancel', onPointerCancel)
          pointerTarget?.removeEventListener('lostpointercapture', onLostCapture)
          wheelTarget?.removeEventListener('wheel', onWheel)
          // O-58: otherwise the last snapshot, edges included, replays
          // every tick after teardown.
          world.setInput({
            keys: new Set(),
            keyDelta: { pressed: new Set(), released: new Set() },
            mods: { ctrl: false, alt: false, shift: false, meta: false },
            pointer: { x: 0, y: 0, buttons: 0, delta: { x: 0, y: 0 }, wheel: 0, entered: [] },
            gamepads: [],
            focus: { activeTag: '', consumesKeys: false },
          })
        },
      })
    },
  }
}
