import type { Entity } from './types.js'

/**
 * A pure, world-free uniform grid over 2D points (O-8, spec §5.1, ED-7).
 *
 * Results of {@link SpatialGrid.within}, {@link SpatialGrid.nearest} and
 * {@link SpatialGrid.pairs} are normative: they equal a brute-force scan
 * over every indexed point and never depend on `cellSize`, on insertion
 * order or on cell iteration order. Cell size is a pure performance
 * setting. Distances are compared as `dx * dx + dy * dy` with
 * `dx = px - x`, `dy = py - y`, the same expression a brute-force scan
 * would use.
 *
 * The grid is derived state: it is never part of a snapshot. Rebuild it from
 * snapshotted positions.
 */
export interface SpatialGrid {
  readonly cellSize: number
  /** Number of indexed ids. */
  readonly size: number
  clear(): void
  /** Insert or move. Non-finite coordinates are not indexed (the id is removed). */
  set(id: Entity, x: number, y: number): void
  /** Remove `id`; unknown ids are a no-op. */
  delete(id: Entity): void
  /** The indexed position of `id`, or `undefined` when it is not indexed. */
  position(id: Entity): { readonly x: number; readonly y: number } | undefined
  /**
   * Ids with distance² <= r², ascending id. A negative or NaN `r` matches
   * nothing. `accept` is called in ascending id order on the ids within
   * range; it should be pure.
   */
  within(x: number, y: number, r: number, accept?: (id: Entity) => boolean): Entity[]
  /**
   * The id with the minimum distance²; ties → lowest id. `maxDistance`
   * (inclusive) bounds the search; a negative or NaN `maxDistance` matches
   * nothing. `accept` may be called in any order and any number of times,
   * so it should be pure.
   */
  nearest(
    x: number,
    y: number,
    options?: { maxDistance?: number; accept?: (id: Entity) => boolean },
  ): Entity | undefined
  /**
   * Unordered pairs with distance <= r (a < b), sorted by (a, b). A negative
   * or NaN `r` matches nothing. `accept` is called in output order on the
   * pairs within range; it should be pure.
   */
  pairs(r: number, accept?: (a: Entity, b: Entity) => boolean): Array<[Entity, Entity]>
}

/** Packed cell key: a number for small cells, a string beyond (both exact). */
type CellKey = number | string

interface Item {
  readonly id: Entity
  x: number
  y: number
  /** `null`: cell coordinates out of the ring-search range (an outlier). */
  key: CellKey | null
}

/**
 * Cell keys are exact in three tiers chosen by the cell coordinates alone:
 * |c| < 2^14 packs into a small integer in [0, 2^30) (a V8 small integer,
 * the fastest Map key); |c| < 2^25 packs into an integer in
 * [2^30, 2^30 + 2^52); anything larger becomes a string.
 */
const SMALL_LIMIT = 2 ** 14
const SMALL_SPAN = 2 ** 15
const PACK_LIMIT = 2 ** 25
const PACK_SPAN = 2 ** 26
const PACK_BASE = 2 ** 30
/** Cells beyond ±MAX_CELL (or a non-finite quotient) are kept as outliers. */
const MAX_CELL = 2 ** 50
/**
 * Relative slack on every cell bound. Floating-point rounding (≈ 2^-53
 * relative) can only make a search visit more cells, never fewer.
 */
const SLACK = 2 ** -40

function cellKey(cx: number, cy: number): CellKey {
  if (cx > -SMALL_LIMIT && cx < SMALL_LIMIT && cy > -SMALL_LIMIT && cy < SMALL_LIMIT) {
    return (cx + SMALL_LIMIT) * SMALL_SPAN + (cy + SMALL_LIMIT)
  }
  if (cx > -PACK_LIMIT && cx < PACK_LIMIT && cy > -PACK_LIMIT && cy < PACK_LIMIT) {
    // (cx + L) and (cy + L) are integers in [0, 2^26): the sum stays below 2^53.
    return PACK_BASE + (cx + PACK_LIMIT) * PACK_SPAN + (cy + PACK_LIMIT)
  }
  return `${cx},${cy}`
}

function inRange(c: number): boolean {
  return c >= -MAX_CELL && c <= MAX_CELL
}

const ascending = (a: Entity, b: Entity): number => a - b

class Grid implements SpatialGrid {
  readonly cellSize: number
  private readonly items = new Map<Entity, Item>()
  private readonly cells = new Map<CellKey, Item[]>()
  private readonly outliers = new Set<Item>()

  constructor(cellSize: number) {
    this.cellSize = cellSize
  }

  get size(): number {
    return this.items.size
  }

  clear(): void {
    this.items.clear()
    this.cells.clear()
    this.outliers.clear()
  }

  set(id: Entity, x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      this.delete(id)
      return
    }
    const cx = Math.floor(x / this.cellSize)
    const cy = Math.floor(y / this.cellSize)
    const key = inRange(cx) && inRange(cy) ? cellKey(cx, cy) : null
    let item = this.items.get(id)
    if (item) {
      if (item.key === key) {
        item.x = x
        item.y = y
        return
      }
      this.unlink(item)
      item.x = x
      item.y = y
      item.key = key
    } else {
      item = { id, x, y, key }
      this.items.set(id, item)
    }
    if (key === null) {
      this.outliers.add(item)
      return
    }
    const cell = this.cells.get(key)
    if (cell) cell.push(item)
    else this.cells.set(key, [item])
  }

  delete(id: Entity): void {
    const item = this.items.get(id)
    if (!item) return
    this.unlink(item)
    this.items.delete(id)
  }

  position(id: Entity): { readonly x: number; readonly y: number } | undefined {
    const item = this.items.get(id)
    return item ? { x: item.x, y: item.y } : undefined
  }

  within(x: number, y: number, r: number, accept?: (id: Entity) => boolean): Entity[] {
    if (!(r >= 0)) return []
    const r2 = r * r
    const out: Entity[] = []
    this.candidates(x, y, r, (it) => {
      const dx = it.x - x
      const dy = it.y - y
      if (dx * dx + dy * dy <= r2) out.push(it.id)
    })
    out.sort(ascending)
    return accept ? out.filter((id) => accept(id)) : out
  }

  nearest(
    x: number,
    y: number,
    options?: { maxDistance?: number; accept?: (id: Entity) => boolean },
  ): Entity | undefined {
    if (this.items.size === 0) return undefined
    let maxD2 = Infinity
    const maxDistance = options?.maxDistance
    if (maxDistance !== undefined) {
      if (!(maxDistance >= 0)) return undefined
      maxD2 = maxDistance * maxDistance
    }
    const accept = options?.accept
    let best: Entity | undefined
    let bestD2 = Infinity
    const consider = (it: Item): void => {
      const dx = it.x - x
      const dy = it.y - y
      const d2 = dx * dx + dy * dy
      if (!(d2 <= maxD2)) return
      if (best !== undefined && !(d2 < bestD2 || (d2 === bestD2 && it.id < best))) return
      if (accept && !accept(it.id)) return
      best = it.id
      bestD2 = d2
    }
    const scanAll = (): Entity | undefined => {
      for (const it of this.items.values()) consider(it)
      return best
    }

    const cs = this.cellSize
    const qx = Math.floor(x / cs)
    const qy = Math.floor(y / cs)
    if (!inRange(qx) || !inRange(qy)) return scanAll() // also NaN / ±∞ queries
    for (const it of this.outliers) consider(it)

    // Rings expand around the query cell. Every point in ring k + 1 or beyond
    // lies more than k × cellSize away; the bound below shaves a relative and
    // an absolute slack off that so rounding can only add rings (spec §5.1).
    const slackAbs = (Math.abs(x) + Math.abs(y) + cs) * SLACK
    const occupied = this.cells.size
    let visited = 0
    for (let k = 0; ; k++) {
      const ringCells = k === 0 ? 1 : 8 * k
      // More ring lookups than occupied cells: a full scan is cheaper (and
      // is the definition the ring search must equal).
      if (visited + ringCells > occupied) return scanAll()
      visited += ringCells
      if (k === 0) {
        this.visitCell(qx, qy, consider)
      } else {
        for (let i = -k; i <= k; i++) {
          this.visitCell(qx + i, qy - k, consider)
          this.visitCell(qx + i, qy + k, consider)
        }
        for (let j = -k + 1; j <= k - 1; j++) {
          this.visitCell(qx - k, qy + j, consider)
          this.visitCell(qx + k, qy + j, consider)
        }
      }
      const lb = k * cs * (1 - SLACK) - slackAbs
      if (lb > 0) {
        const lb2 = lb * lb
        // Strictly greater: an unvisited point at an equal distance with a
        // lower id would win the tie.
        if (lb2 > maxD2 || lb2 > bestD2) return best
      }
    }
  }

  pairs(r: number, accept?: (a: Entity, b: Entity) => boolean): Array<[Entity, Entity]> {
    if (!(r >= 0)) return []
    const r2 = r * r
    const sorted = [...this.items.values()].sort((p, q) => p.id - q.id)
    const out: Array<[Entity, Entity]> = []
    const partners: Entity[] = []
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i]!
      partners.length = 0
      const ax = a.x
      const ay = a.y
      const aid = a.id
      const test = (it: Item): void => {
        if (!(it.id > aid)) return
        const dx = it.x - ax
        const dy = it.y - ay
        if (dx * dx + dy * dy <= r2) partners.push(it.id)
      }
      const range = this.cellRange(ax, ay, r)
      if (range) {
        this.visitRange(range, test)
        partners.sort(ascending)
      } else {
        // Neighbourhood larger than the occupied grid: scan the higher ids
        // directly (already in ascending order).
        for (let j = i + 1; j < sorted.length; j++) test(sorted[j]!)
      }
      for (const b of partners) if (!accept || accept(aid, b)) out.push([aid, b])
    }
    return out
  }

  /** Visit a superset of the items within `r` of (x, y): covering cells plus outliers, or everything. */
  private candidates(x: number, y: number, r: number, visit: (it: Item) => void): void {
    const range = this.cellRange(x, y, r)
    if (range) this.visitRange(range, visit)
    else for (const it of this.items.values()) visit(it)
  }

  /**
   * The cells covering every point within `r` of (x, y), padded by a slack
   * and one cell per side, or `null` when that block is unbounded or holds
   * more cells than are occupied (a full scan is then cheaper).
   */
  private cellRange(x: number, y: number, r: number): [number, number, number, number] | null {
    const cs = this.cellSize
    const pad = (Math.abs(x) + Math.abs(y) + r) * SLACK
    const cx0 = Math.floor((x - r - pad) / cs) - 1
    const cx1 = Math.floor((x + r + pad) / cs) + 1
    const cy0 = Math.floor((y - r - pad) / cs) - 1
    const cy1 = Math.floor((y + r + pad) / cs) + 1
    const bounded =
      Number.isFinite(r * r) && inRange(cx0) && inRange(cx1) && inRange(cy0) && inRange(cy1)
    if (!bounded || (cx1 - cx0 + 1) * (cy1 - cy0 + 1) > this.cells.size) return null
    return [cx0, cx1, cy0, cy1]
  }

  /** Visit every item in a cell block from {@link cellRange}, plus the outliers. */
  private visitRange(range: [number, number, number, number], visit: (it: Item) => void): void {
    const [cx0, cx1, cy0, cy1] = range
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) this.visitCell(cx, cy, visit)
    }
    for (const it of this.outliers) visit(it)
  }

  private visitCell(cx: number, cy: number, visit: (it: Item) => void): void {
    const cell = this.cells.get(cellKey(cx, cy))
    if (cell) for (let i = 0; i < cell.length; i++) visit(cell[i]!)
  }

  private unlink(item: Item): void {
    if (item.key === null) {
      this.outliers.delete(item)
      return
    }
    const cell = this.cells.get(item.key)
    if (!cell) return
    const i = cell.indexOf(item)
    if (i >= 0) {
      const last = cell.pop()!
      if (i < cell.length) cell[i] = last
    }
    if (cell.length === 0) this.cells.delete(item.key)
  }
}

/**
 * Create an empty {@link SpatialGrid}. `cellSize` must be a finite number
 * greater than 0 (throws `RangeError` otherwise); it changes speed, never
 * results. A cell a little larger than the typical query radius is a good
 * start.
 */
export function createSpatialGrid(cellSize: number): SpatialGrid {
  if (!(cellSize > 0) || !Number.isFinite(cellSize)) {
    throw new RangeError(`createSpatialGrid: cellSize must be a finite number > 0 (got ${String(cellSize)})`)
  }
  return new Grid(cellSize)
}
