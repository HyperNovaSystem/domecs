import type { Entity } from './types.js'

/**
 * Entity set that iterates in ascending id order (SPEC §8). Live query
 * membership and archetype buckets use it so iteration does not depend on
 * the order entities happened to join: `restore()` rebuilds membership from
 * the id-sorted snapshot, and a restored world must iterate exactly like the
 * live one did (O-40).
 *
 * Membership lives in a `Set` (O(1) add/delete/has/size); iteration order
 * lives in `sorted`, maintained lazily:
 * - an add above the current tail appends — spawns allocate increasing ids,
 *   so this is the common case;
 * - an add below the tail (an older entity joining via `addComponent`) is
 *   parked in `late`;
 * - a delete is parked in `gone` and its id stays in `sorted` until then.
 * The next read (or a backlog past half the run, so sets nobody iterates
 * stay bounded) merges the sorted `late` ids in and drops the `gone` ones in
 * one pass: O(n + k log k) for k parked changes, free while unchanged.
 */
export class SortedIdSet implements Iterable<Entity> {
  private readonly members = new Set<Entity>()
  private sorted: Entity[] = []
  private late: Entity[] = []
  private gone: Entity[] = []

  get size(): number {
    return this.members.size
  }

  has(id: Entity): boolean {
    return this.members.has(id)
  }

  add(id: Entity): void {
    if (this.members.has(id)) return
    this.members.add(id)
    const tail = this.sorted[this.sorted.length - 1]
    if (tail === undefined || id > tail) {
      this.sorted.push(id)
      return
    }
    this.late.push(id)
    this.compactIfBacklogged()
  }

  delete(id: Entity): boolean {
    if (!this.members.delete(id)) return false
    this.gone.push(id)
    this.compactIfBacklogged()
    return true
  }

  clear(): void {
    this.members.clear()
    this.sorted = []
    this.late = []
    this.gone = []
  }

  /**
   * Members in ascending id order. The array is owned by the set: read it
   * before the next mutation and never write to it.
   */
  ordered(): readonly Entity[] {
    if (this.late.length > 0 || this.gone.length > 0) this.normalize()
    return this.sorted
  }

  [Symbol.iterator](): Iterator<Entity> {
    return this.ordered()[Symbol.iterator]()
  }

  private compactIfBacklogged(): void {
    if (this.late.length + this.gone.length > 64 + (this.sorted.length >> 1)) this.normalize()
  }

  private normalize(): void {
    const a = this.sorted
    const b = this.late.sort(byId)
    const g = this.gone.sort(byId)
    const members = this.members
    const out: Entity[] = []
    let i = 0
    let j = 0
    let x = 0
    while (i < a.length || j < b.length) {
      let next: Entity
      if (j >= b.length || (i < a.length && a[i]! <= b[j]!)) {
        next = a[i++]!
        // A run id that was deleted is dropped unless it was re-added since.
        while (x < g.length && g[x]! < next) x++
        if (g[x] === next && !members.has(next)) continue
      } else {
        // A late id may have been deleted again before this merge.
        next = b[j++]!
        if (!members.has(next)) continue
      }
      // A re-added id can sit in both lists, and `late` can repeat an id;
      // equal ids arrive adjacent, so collapse them.
      if (out[out.length - 1] !== next) out.push(next)
    }
    this.sorted = out
    this.late = []
    this.gone = []
  }
}

/** Ascending entity-id comparator for `Array.prototype.sort`. */
export function byId(a: Entity, b: Entity): number {
  return a - b
}

/**
 * Merge disjoint ascending id runs (one per matching archetype) into one
 * ascending array. Pairwise two-way merges: O(n log k) with no comparator
 * calls, several times faster than sorting the concatenation.
 */
export function mergeSortedRuns(runs: ReadonlyArray<readonly Entity[]>): Entity[] {
  if (runs.length === 0) return []
  if (runs.length === 1) return runs[0]!.slice()
  let level = runs
  while (level.length > 1) {
    const next: Array<readonly Entity[]> = []
    for (let r = 0; r < level.length; r += 2) {
      const b = level[r + 1]
      next.push(b === undefined ? level[r]! : mergeTwo(level[r]!, b))
    }
    level = next
  }
  // Two or more runs: the survivor is a fresh mergeTwo() array.
  return level[0] as Entity[]
}

function mergeTwo(a: readonly Entity[], b: readonly Entity[]): Entity[] {
  const out = new Array<Entity>(a.length + b.length)
  let i = 0
  let j = 0
  let k = 0
  while (i < a.length && j < b.length) out[k++] = a[i]! < b[j]! ? a[i++]! : b[j++]!
  while (i < a.length) out[k++] = a[i++]!
  while (j < b.length) out[k++] = b[j++]!
  return out
}
