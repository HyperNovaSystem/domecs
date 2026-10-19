import { describe, expect, it } from 'vitest'
import {
  createRng,
  createWorld,
  defineComponent,
  defineEvent,
  deriveStream,
  entry,
  hashSnapshot,
  SNAPSHOT_VERSION,
  seedToState,
} from '../src/index.js'
import type { RngState, SystemDef, World, WorldSnapshot } from '../src/index.js'

// §4.4 (G6; O-77): a system with `rng: 'own'` draws from a stream keyed by its
// cursor key and derived from the world's root seed; the stream map travels in
// the snapshot (v3, always).

const Draws = defineComponent<{ log: number[] }>('RsDraws', { defaults: { log: [] } })
const Ping = defineEvent<{ n: number }>('RsPing')

/** Independent oracle of the derivation as §4.4 and the E4 notes describe it. */
function oracle(root: RngState, key: string): RngState {
  const u32 = (n: number): number => n >>> 0
  const rotl = (x: number, k: number): number => (k === 0 ? u32(x) : u32((x << k) | (x >>> (32 - k))))
  const text = 'domecs:stream:' + key
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = u32(Math.imul(h ^ text.charCodeAt(i), 0x01000193))
  const r = root.map(u32)
  const s = r.map((w, i) => {
    // one splitmix32 output seeded with the mixed word
    let z = u32(u32(w ^ rotl(h, 8 * i)) + 0x9e3779b9)
    z = u32(Math.imul(z ^ (z >>> 16), 0x21f0aaad))
    z = u32(Math.imul(z ^ (z >>> 15), 0x735a2d97))
    return u32(z ^ (z >>> 15))
  }) as [number, number, number, number]
  if (s.every((w) => w === 0)) s[0] = 1
  const rng = createRng(s)
  for (let i = 0; i < 8; i++) rng.uniform()
  return rng.seed()
}

/** Register a system that appends one draw from `ctx.rand` per tick to the entity's log. */
function drawer(w: World, name: string, rng: 'own' | 'shared' | undefined, target: number): ReturnType<World['system']> {
  const def: SystemDef = rng === undefined ? {} : { rng }
  return w.system(name, def, (ctx) => {
    const d = w.getComponent(target, Draws)!
    d.log.push(ctx.rand.uniform())
    w.markChanged(target, Draws)
  })
}

const logOf = (w: World, id: number): number[] => w.getComponent(id, Draws)!.log.slice()

const firstDraws = (state: RngState, n: number): number[] => {
  const r = createRng(state)
  return Array.from({ length: n }, () => r.uniform())
}

describe('§4.4 per-system RNG streams', () => {
  it('6: golden — deriveStream([1,2,3,4], "rule:move") first four draws', () => {
    const state = deriveStream([1, 2, 3, 4], 'rule:move')
    expect(state).toEqual(oracle([1, 2, 3, 4], 'rule:move'))
    expect(state).toEqual(GOLDEN_RULE_MOVE_STATE)
    expect(firstDraws(state, 4)).toEqual(GOLDEN_RULE_MOVE)
    // a different key or root gives a different stream
    expect(deriveStream([1, 2, 3, 4], 'rule:mover')).not.toEqual(state)
    expect(deriveStream([1, 2, 3, 5], 'rule:move')).not.toEqual(state)
    // equal root words still give a usable, key-dependent state
    expect(deriveStream([7, 7, 7, 7], 'a')).toEqual(oracle([7, 7, 7, 7], 'a'))
    expect(new Set(deriveStream([7, 7, 7, 7], 'a')).size).toBe(4)
  })

  it("'own' draws its key's derived stream; 'shared' (default) draws world.rand", () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    const a = w.spawn([entry(Draws, { log: [] })])
    const b = w.spawn([entry(Draws, { log: [] })])
    drawer(w, 'own', 'own', a)
    drawer(w, 'shared', undefined, b)
    const shared = createRng([1, 2, 3, 4])
    for (let i = 0; i < 5; i++) w.stepOnce()
    expect(logOf(w, a)).toEqual(firstDraws(deriveStream(seedToState([1, 2, 3, 4]), 'own'), 5))
    expect(logOf(w, b)).toEqual(Array.from({ length: 5 }, () => shared.uniform()))
    expect(w.rand.seed()).toEqual(shared.seed())
  })

  it('7: name clash — two own systems named "s" get keys s and s#1 with different streams', () => {
    const w = createWorld({ headless: true, seed: 9 })
    const a = w.spawn([entry(Draws, { log: [] })])
    const b = w.spawn([entry(Draws, { log: [] })])
    drawer(w, 's', 'own', a)
    drawer(w, 's', 'own', b)
    for (let i = 0; i < 3; i++) w.stepOnce()
    const root = seedToState(9)
    expect(logOf(w, a)).toEqual(firstDraws(deriveStream(root, 's'), 3))
    expect(logOf(w, b)).toEqual(firstDraws(deriveStream(root, 's#1'), 3))
    expect(logOf(w, a)).not.toEqual(logOf(w, b))
    expect(Object.keys(w.snapshot().rngStreams!)).toEqual(['s', 's#1'])
  })

  it('removal keeps the entry; re-registering under the key resumes it', () => {
    const w = createWorld({ headless: true, seed: [4, 3, 2, 1] })
    const a = w.spawn([entry(Draws, { log: [] })])
    const h = drawer(w, 'r', 'own', a)
    w.stepOnce()
    w.stepOnce()
    h.remove()
    w.stepOnce()
    const snap = w.snapshot()
    const expected = createRng(deriveStream(seedToState([4, 3, 2, 1]), 'r'))
    const seq = Array.from({ length: 4 }, () => expected.uniform())
    // two draws taken; the entry stays and records the advanced state
    const twoIn = createRng(deriveStream(seedToState([4, 3, 2, 1]), 'r'))
    twoIn.uniform()
    twoIn.uniform()
    expect(snap.rngStreams).toEqual({ r: twoIn.seed() })
    drawer(w, 'r', 'own', a)
    w.stepOnce()
    w.stepOnce()
    expect(logOf(w, a)).toEqual(seq)
  })

  it('a stream exists from registration and snapshot() writes every entry', () => {
    const w = createWorld({ headless: true, seed: 5 })
    w.system('quiet', { rng: 'own' }, () => {})
    w.system('plain', {}, () => {})
    const snap = w.snapshot()
    expect(snap.rngStreams).toEqual({ quiet: deriveStream(seedToState(5), 'quiet') })
  })

  it('always v3: no own stream → version 3 with rngRoot, without rngStreams', () => {
    expect(SNAPSHOT_VERSION).toBe(3)
    const w = createWorld({ headless: true, seed: 77 })
    w.system('plain', {}, (ctx) => void ctx.rand.uniform())
    w.stepOnce()
    const snap = w.snapshot()
    expect(snap.version).toBe(3)
    expect(snap.rngRoot).toEqual(seedToState(77))
    expect(snap).not.toHaveProperty('rngStreams')
    // the root never advances, the shared seed does
    expect(snap.seed).not.toEqual(snap.rngRoot)
    w.system('emitter', {}, (ctx) => ctx.events.emit(Ping, { n: 1 }))
    w.stepOnce()
    const withPending = w.snapshot({ pendingEvents: true })
    expect(withPending.version).toBe(3)
    expect(withPending.pendingEvents).toEqual([{ event: 'RsPing', payload: { n: 1 } }])
    expect(w.describe().snapshotVersion).toBe(3)
  })

  it('4: JSON round trip keeps rngRoot and rngStreams; restore continues the streams', () => {
    const build = (seed: number): { w: World; a: number } => {
      const w = createWorld({ headless: true, seed })
      const a = w.spawn([entry(Draws, { log: [] })])
      drawer(w, 'x', 'own', a)
      drawer(w, 'y', 'own', a)
      drawer(w, 'z', 'shared', a)
      return { w, a }
    }
    const live = build(1)
    for (let i = 0; i < 10; i++) live.w.stepOnce()
    const snap = live.w.snapshot()
    const parsed = JSON.parse(JSON.stringify(snap)) as WorldSnapshot
    expect(parsed.rngRoot).toEqual(snap.rngRoot)
    expect(parsed.rngStreams).toEqual(snap.rngStreams)
    // a fresh world with another seed takes the snapshot's root and streams
    const fork = build(2)
    fork.w.restore(parsed)
    expect(fork.w.snapshot().rngRoot).toEqual(seedToState(1))
    for (let i = 0; i < 20; i++) {
      live.w.stepOnce()
      fork.w.stepOnce()
    }
    expect(logOf(fork.w, fork.a)).toEqual(logOf(live.w, live.a))
    const strict = (w: World): string => hashSnapshot(w.snapshot(), { includeChanges: true })
    expect(strict(fork.w)).toBe(strict(live.w))
  })

  it('a captured ctx.rand handle follows a restore (rewound in place)', () => {
    const w = createWorld({ headless: true, seed: 3 })
    let captured: ReturnType<typeof createRng> | undefined
    w.system('cap', { rng: 'own' }, (ctx) => {
      captured ??= ctx.rand
      ctx.rand.uniform()
    })
    w.stepOnce()
    const snap = w.snapshot()
    const next = captured!.seed()
    w.stepOnce()
    w.stepOnce()
    w.restore(snap)
    expect(captured!.seed()).toEqual(next)
  })

  it('a v2 snapshot restores: the world keeps its own root and streams re-derive', () => {
    const src = createWorld({ headless: true, seed: 11 })
    const sa = src.spawn([entry(Draws, { log: [] })])
    drawer(src, 'k', 'own', sa)
    for (let i = 0; i < 4; i++) src.stepOnce()
    const { rngRoot: _r, rngStreams: _s, ...rest } = src.snapshot()
    const v2: WorldSnapshot = { ...rest, version: 2 }

    const dst = createWorld({ headless: true, seed: 22 })
    const da = dst.spawn([entry(Draws, { log: [] })])
    drawer(dst, 'k', 'own', da)
    for (let i = 0; i < 2; i++) dst.stepOnce()
    dst.restore(v2)
    const after = dst.snapshot()
    expect(after.version).toBe(3)
    expect(after.rngRoot).toEqual(seedToState(22))
    expect(after.rngStreams).toEqual({ k: deriveStream(seedToState(22), 'k') })
    const before = logOf(dst, da)
    dst.stepOnce()
    expect(logOf(dst, da)).toEqual([...before, firstDraws(deriveStream(seedToState(22), 'k'), 1)[0]])
  })

  it('5: invalid rngRoot / rngStreams throw before any state change', () => {
    const w = createWorld({ headless: true, seed: 6 })
    const a = w.spawn([entry(Draws, { log: [] })])
    drawer(w, 'v', 'own', a)
    for (let i = 0; i < 3; i++) w.stepOnce()
    const good = w.snapshot()
    w.stepOnce()
    const beforeHash = hashSnapshot(w.snapshot(), { includeChanges: true })
    const beforeStreams = w.snapshot().rngStreams
    const bad: unknown[] = [
      { ...good, rngRoot: [1, 2, 3] },
      { ...good, rngRoot: [1, 2, 3, Number.NaN] },
      { ...good, rngRoot: 'seed' },
      { ...good, rngRoot: null },
      { ...good, rngStreams: [] },
      { ...good, rngStreams: null },
      { ...good, rngStreams: { v: [1, 2, 3] } },
      { ...good, rngStreams: { v: [1, 2, 3, Infinity] } },
      { ...good, rngStreams: { v: { 0: 1, 1: 2, 2: 3, 3: 4 } } },
    ]
    for (const s of bad) {
      expect(() => w.restore(s as WorldSnapshot)).toThrow(/invalid snapshot rng(Root|Streams)/)
      expect(hashSnapshot(w.snapshot(), { includeChanges: true })).toBe(beforeHash)
      expect(w.snapshot().rngStreams).toEqual(beforeStreams)
    }
  })

  it("describe().systems[i].rng reports 'shared' / 'own'", () => {
    const w = createWorld({ headless: true })
    w.system('o', { rng: 'own' }, () => {})
    w.system('s', { rng: 'shared' }, () => {})
    w.system('d', {}, () => {})
    const byName = new Map(w.describe().systems.map((s) => [s.name, s.rng]))
    expect(byName.get('o')).toBe('own')
    expect(byName.get('s')).toBe('shared')
    expect(byName.get('d')).toBe('shared')
  })

  it('an unknown rng mode throws at world.system() before any state changes', () => {
    const w = createWorld({ headless: true })
    const before = w.describe().systems.length
    expect(() => w.system('bad', { rng: 'mine' } as unknown as SystemDef, () => {})).toThrow(/rng/)
    expect(w.describe().systems.length).toBe(before)
    expect(w.snapshot()).not.toHaveProperty('rngStreams')
  })
})

// Pinned first four uniform() draws of deriveStream([1,2,3,4], 'rule:move').
// Part of the snapshot contract: a change here needs a SNAPSHOT_VERSION bump.
const GOLDEN_RULE_MOVE: number[] = [
  0.09816509275697172, 0.44299133284948766, 0.6445047117304057, 0.22211877536028624,
]
const GOLDEN_RULE_MOVE_STATE: RngState = [1860701461, 1711349229, 1513367337, 2826258467]
