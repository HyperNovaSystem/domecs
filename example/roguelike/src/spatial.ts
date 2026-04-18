import type { Capability, Plugin, World } from 'domecs'
import { Position } from './components.js'

export const SPATIAL_INDEX_CAP = 'spatial-index' as const
export type SpatialIndexKey = typeof SPATIAL_INDEX_CAP

export interface SpatialIndex {
  readonly name: SpatialIndexKey
  at(x: number, y: number): readonly number[]
  rebuild(): void
  nearest(x: number, y: number, radius: number): number[]
}

declare module 'domecs' {
  interface Capability<K> {
    at: K extends 'spatial-index' ? (x: number, y: number) => readonly number[] : never
    rebuild: K extends 'spatial-index' ? () => void : never
    nearest: K extends 'spatial-index' ? (x: number, y: number, r: number) => number[] : never
  }
}

/**
 * Grid spatial index: bucket of entity ids per (x,y) cell, rebuilt on demand.
 * Swapped in via the domecs capability registry (SPEC §9.3).
 */
export function spatialIndexPlugin(): Plugin {
  return {
    name: '@roguelike/spatial-index',
    provides: [SPATIAL_INDEX_CAP],
    install(world: World) {
      const buckets = new Map<string, Set<number>>()
      const key = (x: number, y: number): string => `${x}|${y}`

      function rebuild(): void {
        buckets.clear()
        const q = world.query({ kind: 'has', type: Position })
        for (const e of q.entities) {
          const v = e as unknown as { id: number; Position: { x: number; y: number } }
          const k = key(v.Position.x, v.Position.y)
          let s = buckets.get(k)
          if (!s) {
            s = new Set()
            buckets.set(k, s)
          }
          s.add(v.id)
        }
      }

      function at(x: number, y: number): readonly number[] {
        const s = buckets.get(key(x, y))
        return s ? Array.from(s) : []
      }

      function nearest(x: number, y: number, r: number): number[] {
        const out: number[] = []
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            for (const id of at(x + dx, y + dy)) out.push(id)
          }
        }
        return out
      }

      const cap = world.capability(SPATIAL_INDEX_CAP) as Capability<'spatial-index'> & {
        at: (x: number, y: number) => readonly number[]
        rebuild: () => void
        nearest: (x: number, y: number, r: number) => number[]
      }
      cap.at = at
      cap.rebuild = rebuild
      cap.nearest = nearest

      rebuild()

      return {
        // Rebuild each tick-start; fast enough for 16k entities since it's a
        // single walk of the Has(Position) archetype cache.
        onTickStart: () => rebuild(),
      }
    },
  }
}
