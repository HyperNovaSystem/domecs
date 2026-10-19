import { createSpatialGrid } from '@domecs/core'
import type { ComponentType, Entity, World } from '@domecs/core'

/** Options for {@link createSpatialHash}. */
export interface SpatialHashOptions {
  /** The component holding each entity's position. */
  readonly component: ComponentType<any>
  /** Field holding the x coordinate (default `'x'`). */
  readonly x?: string
  /** Field holding the y coordinate (default `'y'`). */
  readonly y?: string
  /** Grid cell size: a pure performance setting, never changes results. */
  readonly cellSize: number
}

/**
 * A world-bound spatial index over one position component (spec §5.1).
 *
 * Positions are those read at the last {@link SpatialIndex.refresh} (the
 * index also refreshes once when it is created). Tag filters are evaluated
 * live at query time with `world.has`: an entity must hold every listed
 * component. Results are sorted by id and, like the core grid's, never
 * depend on `cellSize`. The index is derived state and never enters a
 * snapshot.
 */
export interface SpatialIndex {
  /** Rebuild from the component's current values (O(n)). */
  refresh(): void
  /** Ids within distance `r` of (x, y) holding every `filter` component, ascending id. */
  within(x: number, y: number, r: number, filter?: readonly ComponentType<any>[]): Entity[]
  /** The nearest id passing `filter` and other than `exclude`; ties → lowest id. */
  nearest(
    x: number,
    y: number,
    options?: { maxDistance?: number; filter?: readonly ComponentType<any>[]; exclude?: Entity },
  ): Entity | undefined
  /**
   * Pairs within distance `r` whose first element holds `a` and second holds
   * `b`. For `a !== b` every such ordered pair is listed (an entity holding
   * both tags can appear on either side); for `a === b` the first id is
   * the lower. Sorted by (first, second).
   */
  pairs(r: number, a: ComponentType<any>, b: ComponentType<any>): Array<[Entity, Entity]>
  /** Drop the index. Any later call throws. Idempotent. */
  dispose(): void
}

/**
 * Create a {@link SpatialIndex} over `options.component` and index the
 * world's current positions. A position whose field is not a finite number
 * is not indexed. Throws `RangeError` for a `cellSize` that is not a finite
 * number > 0.
 */
export function createSpatialHash(world: World, options: SpatialHashOptions): SpatialIndex {
  const component = options.component
  const fx = options.x ?? 'x'
  const fy = options.y ?? 'y'
  const grid = createSpatialGrid(options.cellSize)
  let disposed = false

  const live = (): void => {
    if (disposed) throw new Error(`SpatialIndex over '${component.name}' is disposed`)
  }
  const holdsAll = (filter: readonly ComponentType<any>[] | undefined) =>
    filter && filter.length > 0 ? (id: Entity) => filter.every((t) => world.has(id, t)) : undefined

  const refresh = (): void => {
    live()
    grid.clear()
    for (const { id, value } of world.iterEntitiesWith(component)) {
      const v = value as Record<string, unknown>
      const x = v[fx]
      const y = v[fy]
      if (typeof x === 'number' && typeof y === 'number') grid.set(id, x, y)
    }
  }

  refresh()

  return {
    refresh,
    within(x, y, r, filter) {
      live()
      return grid.within(x, y, r, holdsAll(filter))
    },
    nearest(x, y, opts) {
      live()
      const has = holdsAll(opts?.filter)
      const exclude = opts?.exclude
      const accept =
        exclude === undefined ? has : has ? (id: Entity) => id !== exclude && has(id) : (id: Entity) => id !== exclude
      const gridOpts: { maxDistance?: number; accept?: (id: Entity) => boolean } = {}
      if (opts?.maxDistance !== undefined) gridOpts.maxDistance = opts.maxDistance
      if (accept) gridOpts.accept = accept
      return grid.nearest(x, y, gridOpts)
    },
    pairs(r, a, b) {
      live()
      if (a === b) return grid.pairs(r, (p, q) => world.has(p, a) && world.has(q, a))
      const out: Array<[Entity, Entity]> = []
      for (const [p, q] of grid.pairs(r)) {
        if (world.has(p, a) && world.has(q, b)) out.push([p, q])
        if (world.has(q, a) && world.has(p, b)) out.push([q, p])
      }
      return out.sort((s, t) => s[0] - t[0] || s[1] - t[1])
    },
    dispose() {
      if (disposed) return
      disposed = true
      grid.clear()
    },
  }
}
