export type RngState = readonly [number, number, number, number]

export interface Rng {
  next(): number
  int(max: number): number
  range(lo: number, hi: number): number
  pick<T>(arr: readonly T[]): T
  roll(sides: number): number
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

export function createRng(initial: number | RngState): Rng {
  const state = seedToState(initial)

  const api: Rng = {
    next(): number {
      const u = xoshiroStep(state)
      return u / U32
    },
    int(max: number): number {
      if (max <= 0 || !Number.isFinite(max)) {
        throw new Error(`rng.int: max must be a positive finite number; got ${max}`)
      }
      return Math.floor(api.next() * max)
    },
    range(lo: number, hi: number): number {
      return lo + api.next() * (hi - lo)
    },
    pick<T>(arr: readonly T[]): T {
      if (arr.length === 0) throw new Error('rng.pick: empty array')
      return arr[api.int(arr.length)]!
    },
    roll(sides: number): number {
      return api.int(sides) + 1
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
  return api
}

export function restoreRng(state: RngState): Rng {
  return createRng(state)
}
