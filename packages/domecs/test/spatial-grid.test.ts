import { describe, expect, it } from 'vitest'
import { createSpatialGrid } from '../src/index.js'
import type { Entity, SpatialGrid } from '../src/index.js'

// O-8 / spec §5.1 (G2): a pure, world-free uniform grid. Results of
// `within`, `nearest` and `pairs` are normative and never depend on the cell
// size (a pure performance setting), on insertion order, or on cell
// iteration order. Each query is checked against a brute-force oracle.

const CELL_SIZES = [0.5, 1, 7, 32, 100, 1e6]

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Pt {
  id: Entity
  x: number
  y: number
}

/**
 * 2000 seeded points: uniform reals with negatives, points snapped onto
 * every tested cell border (multiples of 0.5, 1, 7, 32, 100), exact
 * duplicates of earlier points, and a dense cluster. Ids are shuffled so
 * insertion order is not id order.
 */
function makePoints(n = 2000, seed = 0x5eed): Pt[] {
  const rnd = mulberry32(seed)
  const pts: Pt[] = []
  const borders = [0.5, 1, 7, 32, 100]
  for (let i = 0; i < n; i++) {
    const kind = i % 5
    let x: number
    let y: number
    if (kind === 0 || kind === 1) {
      x = (rnd() * 2 - 1) * 400
      y = (rnd() * 2 - 1) * 400
    } else if (kind === 2) {
      const b = borders[Math.floor(rnd() * borders.length)]!
      x = Math.round((rnd() * 2 - 1) * (400 / b)) * b
      y = Math.round((rnd() * 2 - 1) * (400 / b)) * b
    } else if (kind === 3 && pts.length > 0) {
      const src = pts[Math.floor(rnd() * pts.length)]!
      x = src.x
      y = src.y
    } else {
      x = -3 + rnd() * 6
      y = -3 + rnd() * 6
    }
    if (i % 97 === 0) x = -0
    pts.push({ id: 0, x, y })
  }
  // shuffled, gappy ids
  const ids = pts.map((_, i) => i * 3 + 1)
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
  }
  pts.forEach((p, i) => (p.id = ids[i]!))
  return pts
}

function d2(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  return dx * dx + dy * dy
}

const oracle = {
  within(pts: Pt[], x: number, y: number, r: number, accept?: (id: Entity) => boolean): Entity[] {
    if (!(r >= 0)) return []
    const r2 = r * r
    return pts
      .filter((p) => d2(x, y, p.x, p.y) <= r2 && (!accept || accept(p.id)))
      .map((p) => p.id)
      .sort((a, b) => a - b)
  },
  nearest(
    pts: Pt[],
    x: number,
    y: number,
    opts: { maxDistance?: number; accept?: (id: Entity) => boolean } = {},
  ): Entity | undefined {
    let maxD2 = Infinity
    if (opts.maxDistance !== undefined) {
      if (!(opts.maxDistance >= 0)) return undefined
      maxD2 = opts.maxDistance * opts.maxDistance
    }
    let best: Entity | undefined
    let bestD2 = Infinity
    for (const p of pts) {
      if (opts.accept && !opts.accept(p.id)) continue
      const d = d2(x, y, p.x, p.y)
      if (!(d <= maxD2)) continue
      if (best === undefined || d < bestD2 || (d === bestD2 && p.id < best)) {
        best = p.id
        bestD2 = d
      }
    }
    return best
  },
  pairs(pts: Pt[], r: number, accept?: (a: Entity, b: Entity) => boolean): Array<[Entity, Entity]> {
    if (!(r >= 0)) return []
    const r2 = r * r
    const sorted = [...pts].sort((a, b) => a.id - b.id)
    const out: Array<[Entity, Entity]> = []
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]!
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j]!
        if (d2(a.x, a.y, b.x, b.y) <= r2 && (!accept || accept(a.id, b.id))) out.push([a.id, b.id])
      }
    }
    return out
  },
}

function build(cellSize: number, pts: Pt[]): SpatialGrid {
  const g = createSpatialGrid(cellSize)
  for (const p of pts) g.set(p.id, p.x, p.y)
  return g
}

function makeQueries(pts: Pt[]): Array<{ x: number; y: number }> {
  const rnd = mulberry32(42)
  const qs: Array<{ x: number; y: number }> = [
    { x: 0, y: 0 },
    { x: -0, y: 0 },
    { x: 7, y: -7 },
    { x: 32, y: 32 },
    { x: -100, y: 100 },
    { x: 0.5, y: -0.5 },
    { x: 5000, y: -5000 }, // far outside the cloud
  ]
  for (let i = 0; i < 40; i++) qs.push({ x: (rnd() * 2 - 1) * 450, y: (rnd() * 2 - 1) * 450 })
  for (let i = 0; i < 10; i++) {
    const p = pts[Math.floor(rnd() * pts.length)]!
    qs.push({ x: p.x, y: p.y }) // exactly on a point (often a duplicate)
  }
  return qs
}

const RADII = [0, 0.5, 1, 3.5, 7, 20, 64, 1000]

describe('createSpatialGrid (spec §5.1)', () => {
  const pts = makePoints()
  const queries = makeQueries(pts)

  it('validates cellSize', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      expect(() => createSpatialGrid(bad)).toThrow(RangeError)
    }
    const g = createSpatialGrid(4)
    expect(g.cellSize).toBe(4)
    expect(g.size).toBe(0)
  })

  it('within matches the brute-force oracle for every cell size, identical across cell sizes', () => {
    const accept = (id: Entity) => id % 2 === 1
    const reference: string[] = []
    for (const q of queries) for (const r of RADII) {
      reference.push(JSON.stringify(oracle.within(pts, q.x, q.y, r)))
      reference.push(JSON.stringify(oracle.within(pts, q.x, q.y, r, accept)))
    }
    for (const cs of CELL_SIZES) {
      const g = build(cs, pts)
      expect(g.size).toBe(pts.length)
      const got: string[] = []
      for (const q of queries) for (const r of RADII) {
        got.push(JSON.stringify(g.within(q.x, q.y, r)))
        got.push(JSON.stringify(g.within(q.x, q.y, r, accept)))
      }
      expect(got, `cellSize ${cs}`).toEqual(reference)
    }
  })

  it('nearest matches the brute-force oracle for every cell size, identical across cell sizes', () => {
    const accept = (id: Entity) => id % 3 !== 0
    const maxes = [undefined, 0, 0.5, 2, 10, 100]
    const opt = (m: number | undefined) => (m === undefined ? {} : { maxDistance: m })
    const reference: Array<Entity | undefined> = []
    for (const q of queries) for (const m of maxes) {
      reference.push(oracle.nearest(pts, q.x, q.y, opt(m)))
      reference.push(oracle.nearest(pts, q.x, q.y, { ...opt(m), accept }))
    }
    for (const cs of CELL_SIZES) {
      const g = build(cs, pts)
      const got: Array<Entity | undefined> = []
      for (const q of queries) for (const m of maxes) {
        got.push(g.nearest(q.x, q.y, m === undefined ? undefined : { maxDistance: m }))
        got.push(g.nearest(q.x, q.y, { ...opt(m), accept }))
      }
      expect(got, `cellSize ${cs}`).toEqual(reference)
    }
  })

  it('pairs matches the brute-force oracle for every cell size, identical across cell sizes', () => {
    const accept = (a: Entity, b: Entity) => (a + b) % 4 !== 0
    // compared as JSON: r = 25 yields ~10^5 pairs, too many for a deep-equal diff
    const grids = CELL_SIZES.map((cs) => build(cs, pts))
    for (const r of [0, 1, 7.5, 25]) {
      const want = oracle.pairs(pts, r)
      expect(want.length).toBeGreaterThan(0) // duplicates guarantee r = 0 pairs
      const wantJson = JSON.stringify(want)
      for (const g of grids) expect(JSON.stringify(g.pairs(r)), `r ${r} cellSize ${g.cellSize}`).toBe(wantJson)
    }
    const wantAccepted = JSON.stringify(oracle.pairs(pts, 7.5, accept))
    for (const g of grids) {
      expect(JSON.stringify(g.pairs(7.5, accept)), `cellSize ${g.cellSize} accept`).toBe(wantAccepted)
    }
  })

  it('gives the same output for any insertion order (and after moves)', () => {
    const rnd = mulberry32(7)
    const shuffled = [...pts]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
    }
    const reversed = [...pts].reverse()
    for (const cs of [1, 32]) {
      const a = build(cs, pts)
      const b = build(cs, shuffled)
      const c = createSpatialGrid(cs)
      // c: insert everything at a wrong place first, then move into place
      for (const p of reversed) c.set(p.id, p.x + 1234.5, p.y - 987)
      for (const p of shuffled) c.set(p.id, p.x, p.y)
      for (const g of [b, c]) {
        expect(g.size).toBe(a.size)
        for (const q of queries.slice(0, 20)) {
          expect(g.within(q.x, q.y, 20)).toEqual(a.within(q.x, q.y, 20))
          expect(g.nearest(q.x, q.y)).toEqual(a.nearest(q.x, q.y))
        }
        expect(JSON.stringify(g.pairs(5))).toBe(JSON.stringify(a.pairs(5)))
      }
    }
  })

  it('ties go to the lowest id regardless of insertion order or cell size', () => {
    for (const cs of CELL_SIZES) {
      const g = createSpatialGrid(cs)
      // four points at distance 5 from (0, 0) in four different cells
      g.set(40, 5, 0)
      g.set(30, 0, -5)
      g.set(20, -3, 4)
      g.set(25, -5, 0)
      expect(g.nearest(0, 0), `cellSize ${cs}`).toBe(20)
      g.delete(20)
      expect(g.nearest(0, 0)).toBe(25)
      // duplicates
      g.set(9, 1, 1)
      g.set(3, 1, 1)
      g.set(6, 1, 1)
      expect(g.nearest(1, 1)).toBe(3)
      expect(g.within(1, 1, 0)).toEqual([3, 6, 9])
      expect(g.pairs(0)).toEqual([
        [3, 6],
        [3, 9],
        [6, 9],
      ])
    }
  })

  it('does not index NaN or infinite positions', () => {
    const g = createSpatialGrid(10)
    g.set(1, 0, 0)
    g.set(2, NaN, 0)
    g.set(3, 0, Infinity)
    g.set(4, -Infinity, -Infinity)
    expect(g.size).toBe(1)
    expect(g.position(2)).toBeUndefined()
    expect(g.within(0, 0, Infinity)).toEqual([1])
    // moving an indexed id to a non-finite position removes it
    g.set(1, NaN, NaN)
    expect(g.size).toBe(0)
    expect(g.position(1)).toBeUndefined()
    expect(g.nearest(0, 0)).toBeUndefined()
  })

  it('handles degenerate queries like the oracle', () => {
    const g = build(7, pts)
    expect(g.within(NaN, 0, 10)).toEqual([])
    expect(g.within(0, 0, -1)).toEqual([])
    expect(g.within(0, 0, NaN)).toEqual([])
    expect(g.within(0, 0, Infinity)).toEqual(oracle.within(pts, 0, 0, Infinity))
    expect(g.nearest(NaN, 0)).toBeUndefined()
    expect(g.nearest(0, 0, { maxDistance: -1 })).toBeUndefined()
    expect(g.nearest(1e300, -1e300)).toBe(oracle.nearest(pts, 1e300, -1e300))
    expect(g.pairs(-1)).toEqual([])
    expect(createSpatialGrid(1).nearest(0, 0)).toBeUndefined()
  })

  it('stays exact at extreme coordinates', () => {
    const extreme: Pt[] = [
      { id: 1, x: 1e300, y: 1e300 },
      { id: 2, x: -1.7e308, y: 0 },
      { id: 3, x: 2 ** 60, y: -(2 ** 60) },
      { id: 4, x: 2 ** 60 + 2 ** 9, y: -(2 ** 60) },
      { id: 5, x: 0, y: 0 },
      { id: 6, x: 3e-310, y: -3e-310 },
    ]
    for (const cs of CELL_SIZES) {
      const g = build(cs, extreme)
      expect(g.size).toBe(extreme.length)
      for (const q of extreme) {
        expect(g.nearest(q.x, q.y)).toBe(oracle.nearest(extreme, q.x, q.y))
        expect(g.nearest(q.x + 1, q.y, { accept: (id) => id !== q.id })).toBe(
          oracle.nearest(extreme, q.x + 1, q.y, { accept: (id) => id !== q.id }),
        )
        for (const r of [0, 1024, 1e10]) expect(g.within(q.x, q.y, r)).toEqual(oracle.within(extreme, q.x, q.y, r))
      }
      expect(g.pairs(1024)).toEqual(oracle.pairs(extreme, 1024))
    }
  })

  it('set / delete / position / clear keep size and positions', () => {
    const g = createSpatialGrid(2)
    g.set(5, 1, 2)
    g.set(5, 3, 4) // move
    expect(g.size).toBe(1)
    expect(g.position(5)).toEqual({ x: 3, y: 4 })
    expect(g.within(1, 2, 0)).toEqual([])
    expect(g.within(3, 4, 0)).toEqual([5])
    g.set(6, -0, 0)
    expect(Object.is(g.position(6)!.x, -0)).toBe(true)
    g.delete(5)
    g.delete(99) // unknown id is a no-op
    expect(g.size).toBe(1)
    g.clear()
    expect(g.size).toBe(0)
    expect(g.within(0, 0, 100)).toEqual([])
  })

  it('calls accept in ascending id order for within and pairs', () => {
    const g = build(7, pts)
    const seen: Entity[] = []
    g.within(0, 0, 50, (id) => (seen.push(id), true))
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    const seenPairs: Array<[Entity, Entity]> = []
    g.pairs(5, (a, b) => (seenPairs.push([a, b]), true))
    const sortedPairs = [...seenPairs].sort((p, q) => p[0] - q[0] || p[1] - q[1])
    expect(seenPairs).toEqual(sortedPairs)
  })
})
