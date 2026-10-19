export type RngState = readonly [number, number, number, number]

export interface Rng {
  uniform(): number
  uniformInt(max: number): number
  uniformRange(lo: number, hi: number): number
  pick<T>(arr: readonly T[]): T
  uniformRoll(sides: number): number
  seed(): RngState
  fork(label: string): Rng
}

const U32 = 0x1_0000_0000

function u32(n: number): number {
  return n >>> 0
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0
}

function splitmix32(seed: number): () => number {
  let s = u32(seed)
  return () => {
    s = u32(s + 0x9e3779b9)
    let z = s
    z = u32(Math.imul(z ^ (z >>> 16), 0x21f0aaad))
    z = u32(Math.imul(z ^ (z >>> 15), 0x735a2d97))
    return u32(z ^ (z >>> 15))
  }
}

export function seedToState(seed: number | RngState): [number, number, number, number] {
  if (Array.isArray(seed)) {
    const [a, b, c, d] = seed
    const s: [number, number, number, number] = [u32(a), u32(b), u32(c), u32(d)]
    if (s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 0) s[0] = 1
    return s
  }
  const gen = splitmix32(seed as number)
  const s: [number, number, number, number] = [gen(), gen(), gen(), gen()]
  if (s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 0) s[0] = 1
  return s
}

// xoshiro128** — returns a u32
function xoshiroStep(s: [number, number, number, number]): number {
  const result = u32(Math.imul(rotl(u32(Math.imul(s[1], 5)), 7), 9))
  const t = u32(s[1] << 9)
  s[2] = u32(s[2] ^ s[0])
  s[3] = u32(s[3] ^ s[1])
  s[1] = u32(s[1] ^ s[2])
  s[0] = u32(s[0] ^ s[3])
  s[2] = u32(s[2] ^ t)
  s[3] = rotl(s[3], 11)
  return result
}

// Each Rng's mutable state, so restore can rewind a generator in place
// (O-46): handles captured as `const rng = world.rand` stay on the timeline.
const states = new WeakMap<Rng, [number, number, number, number]>()

export function createRng(initial: number | RngState): Rng {
  const state = seedToState(initial)

  const api: Rng = {
    uniform(): number {
      const u = xoshiroStep(state)
      return u / U32
    },
    uniformInt(max: number): number {
      if (max <= 0 || !Number.isFinite(max)) {
        throw new Error(`rng.uniformInt: max must be a positive finite number; got ${max}`)
      }
      return Math.floor(api.uniform() * max)
    },
    uniformRange(lo: number, hi: number): number {
      return lo + api.uniform() * (hi - lo)
    },
    pick<T>(arr: readonly T[]): T {
      if (arr.length === 0) throw new Error('rng.pick: empty array')
      return arr[api.uniformInt(arr.length)]!
    },
    uniformRoll(sides: number): number {
      return api.uniformInt(sides) + 1
    },
    seed(): RngState {
      return [state[0], state[1], state[2], state[3]] as RngState
    },
    fork(label: string): Rng {
      // derive a deterministic child seed from current state + label hash
      let h = u32(0x9e3779b9)
      for (let i = 0; i < label.length; i++) {
        h = u32(Math.imul(h ^ label.charCodeAt(i), 0x01000193))
      }
      const derived: RngState = [
        u32(state[0] ^ h),
        u32(state[1] ^ Math.imul(h, 5)),
        u32(state[2] ^ Math.imul(h, 7)),
        u32(state[3] ^ Math.imul(h, 11)),
      ]
      return createRng(derived)
    },
  }
  states.set(api, state)
  return api
}

export function restoreRng(state: RngState): Rng {
  return createRng(state)
}

/**
 * Set `rng`'s state to `state` in place, as `restoreRng(state)` would start.
 * Returns false when `rng` was not made by {@link createRng}.
 */
export function rewindRng(rng: Rng, state: RngState): boolean {
  const s = states.get(rng)
  if (!s) return false
  const next = seedToState(state)
  for (let i = 0; i < 4; i++) s[i] = next[i]!
  return true
}

/**
 * The initial state of the stream `key` under the root seed `root` (§4.4):
 * the world's per-system stream for a system with `rng: 'own'`, keyed by its
 * cursor key. Independent of when the system registered and of every other
 * system's draws.
 *
 * - `h` = FNV-1a-32 over the UTF-16 code units of `"domecs:stream:" + key`;
 * - word `i` = the first `splitmix32` output seeded with
 *   `root[i] XOR rotl(h, 8·i)` (the rotation keeps equal root words apart);
 * - an all-zero result is fixed up as {@link seedToState} does;
 * - 8 xoshiro128** outputs are discarded as warm-up.
 *
 * Pinned by a golden test and part of the snapshot contract: changing it
 * requires a `SNAPSHOT_VERSION` bump.
 */
export function deriveStream(root: RngState, key: string): RngState {
  const text = 'domecs:stream:' + key
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = u32(Math.imul(h ^ text.charCodeAt(i), 0x01000193))
  const r = seedToState(root)
  const s: [number, number, number, number] = [0, 0, 0, 0]
  for (let i = 0; i < 4; i++) {
    const mix = i === 0 ? h : rotl(h, 8 * i)
    s[i] = splitmix32(u32(r[i]! ^ mix))()
  }
  if (s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 0) s[0] = 1
  for (let i = 0; i < 8; i++) xoshiroStep(s)
  return [s[0], s[1], s[2], s[3]] as RngState
}
