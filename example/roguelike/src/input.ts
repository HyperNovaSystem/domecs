export type MovementDelta = readonly [dx: number, dy: number]

export const KEY_TO_DELTA: Readonly<Record<string, MovementDelta>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],

  KeyA: [-1, 0],
  KeyD: [1, 0],
  KeyW: [0, -1],
  KeyS: [0, 1],
  KeyQ: [-1, -1],
  KeyE: [1, -1],
  KeyZ: [-1, 1],
  KeyC: [1, 1],

  KeyH: [-1, 0],
  KeyL: [1, 0],
  KeyK: [0, -1],
  KeyJ: [0, 1],
  KeyY: [-1, -1],
  KeyU: [1, -1],
  KeyB: [-1, 1],
  KeyN: [1, 1],

  Numpad4: [-1, 0],
  Numpad6: [1, 0],
  Numpad8: [0, -1],
  Numpad2: [0, 1],
  Numpad7: [-1, -1],
  Numpad9: [1, -1],
  Numpad1: [-1, 1],
  Numpad3: [1, 1],
}

const CARDINAL_KEY_TO_DELTA: Readonly<Record<string, MovementDelta>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  KeyD: [1, 0],
  KeyW: [0, -1],
  KeyS: [0, 1],
  KeyH: [-1, 0],
  KeyL: [1, 0],
  KeyK: [0, -1],
  KeyJ: [0, 1],
  Numpad4: [-1, 0],
  Numpad6: [1, 0],
  Numpad8: [0, -1],
  Numpad2: [0, 1],
}

const WAIT_KEYS = new Set(['Space', 'Period', 'Numpad5'])

function directDelta(keys: ReadonlySet<string>): MovementDelta | null {
  for (const code of keys) {
    const delta = KEY_TO_DELTA[code]
    if (delta) return delta
  }
  return null
}

function chordDelta(keys: ReadonlySet<string>): MovementDelta | null {
  let dx = 0
  let dy = 0
  for (const code of keys) {
    const delta = CARDINAL_KEY_TO_DELTA[code]
    if (!delta) continue
    dx += delta[0]
    dy += delta[1]
  }
  dx = Math.sign(dx)
  dy = Math.sign(dy)
  return dx === 0 && dy === 0 ? null : [dx, dy]
}

function isDiagonal(delta: MovementDelta): boolean {
  return delta[0] !== 0 && delta[1] !== 0
}

function union(a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> {
  if (a.size === 0) return b
  if (b.size === 0) return a
  return new Set([...a, ...b])
}

export function movementDeltaFromKeys(
  pressed: ReadonlySet<string>,
  held: ReadonlySet<string>,
): MovementDelta | null {
  if (pressed.size > 0) {
    const pressedDelta = directDelta(pressed)
    if (!pressedDelta) return null

    const combinedCardinals = chordDelta(union(pressed, held))
    if (combinedCardinals && isDiagonal(combinedCardinals)) return combinedCardinals
    return pressedDelta
  }

  return chordDelta(held) ?? directDelta(held)
}

export function isWaitKey(code: string): boolean {
  return WAIT_KEYS.has(code)
}
