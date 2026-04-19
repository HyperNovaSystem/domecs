import type { GamepadSnapshot, InputSnapshot, Plugin, PluginHandle, PointerSnapshot, World } from 'domecs'

export interface InputPluginOptions {
  /** Element receiving keyboard events. Default: document. */
  readonly keyTarget?: Document | HTMLElement
  /** Element receiving pointer events (clicks/moves are relative to this). Default: document. */
  readonly pointerTarget?: Document | HTMLElement
  /** Element receiving wheel events. Default: pointerTarget. */
  readonly wheelTarget?: Document | HTMLElement
  /** Should held keys be cleared when the window loses focus? Default: true. */
  readonly clearOnBlur?: boolean
  /** CSS selector matching tags that should be treated as text inputs (keys pass-through). Default: 'input,textarea,[contenteditable="true"]'. */
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

const DEFAULT_TEXT_SELECTOR = 'input,textarea,[contenteditable="true"]'

export function createInputPlugin(options: InputPluginOptions = {}): Plugin {
  return {
    name: 'domecs-input',
    install(world: World): PluginHandle {
      const doc = typeof document !== 'undefined' ? document : undefined
      const win = typeof window !== 'undefined' ? window : undefined
      const keyTarget = (options.keyTarget ?? doc) as EventTarget | undefined
      const pointerTarget = (options.pointerTarget ?? doc) as EventTarget | undefined
      const wheelTarget = (options.wheelTarget ?? pointerTarget) as EventTarget | undefined
      const clearOnBlur = options.clearOnBlur ?? true
      const textSelector = options.textInputSelector ?? DEFAULT_TEXT_SELECTOR
      const pollGamepads =
        options.pollGamepads ?? (typeof navigator !== 'undefined' && !!(navigator as Navigator).getGamepads)
      const preventDefaultKeys = options.preventDefaultKeys ?? false

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

      function onKeyDown(ev: Event): void {
        const e = ev as KeyboardEvent
        if (e.repeat) {
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
      }
      function onKeyUp(ev: Event): void {
        const e = ev as KeyboardEvent
        const code = e.code
        if (held.delete(code)) {
          releasedNext.add(code)
          pressedNext.delete(code)
        }
        syncMods(e)
      }
      function onBlur(): void {
        if (!clearOnBlur) return
        for (const c of held) releasedNext.add(c)
        held.clear()
        mods.ctrl = mods.alt = mods.shift = mods.meta = false
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

      function onPointerMove(ev: Event): void {
        const e = ev as PointerEvent
        const prevX = pointer.x
        const prevY = pointer.y
        pointer.x = e.clientX
        pointer.y = e.clientY
        pointer.deltaX += pointer.x - prevX
        pointer.deltaY += pointer.y - prevY
        pointer.buttons = e.buttons
      }
      function onPointerDown(ev: Event): void {
        const e = ev as PointerEvent
        pointer.x = e.clientX
        pointer.y = e.clientY
        pointer.buttons = e.buttons
      }
      function onPointerUp(ev: Event): void {
        const e = ev as PointerEvent
        pointer.buttons = e.buttons
      }
      function onWheel(ev: Event): void {
        const e = ev as WheelEvent
        pointer.wheel += e.deltaY
      }

      keyTarget?.addEventListener('keydown', onKeyDown)
      keyTarget?.addEventListener('keyup', onKeyUp)
      win?.addEventListener('blur', onBlur)
      pointerTarget?.addEventListener('pointermove', onPointerMove)
      pointerTarget?.addEventListener('pointerdown', onPointerDown)
      pointerTarget?.addEventListener('pointerup', onPointerUp)
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

      function build(): InputSnapshot {
        const pressed = new Set(pressedNext)
        const released = new Set(releasedNext)
        pressedNext.clear()
        releasedNext.clear()
        const pSnap: PointerSnapshot = {
          x: pointer.x,
          y: pointer.y,
          buttons: pointer.buttons,
          delta: { x: pointer.deltaX, y: pointer.deltaY },
          wheel: pointer.wheel,
          entered: pointer.entered.slice(),
        }
        pointer.deltaX = 0
        pointer.deltaY = 0
        pointer.wheel = 0
        return {
          keys: new Set(held),
          keyDelta: { pressed, released },
          mods: { ...mods },
          pointer: pSnap,
          gamepads: readGamepads(),
          focus: currentFocus(),
        }
      }

      return {
        onTickStart() {
          world.setInput(build())
        },
        teardown() {
          keyTarget?.removeEventListener('keydown', onKeyDown)
          keyTarget?.removeEventListener('keyup', onKeyUp)
          win?.removeEventListener('blur', onBlur)
          pointerTarget?.removeEventListener('pointermove', onPointerMove)
          pointerTarget?.removeEventListener('pointerdown', onPointerDown)
          pointerTarget?.removeEventListener('pointerup', onPointerUp)
          wheelTarget?.removeEventListener('wheel', onWheel)
        },
      }
    },
  }
}
