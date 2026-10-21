import type { Entity } from './types.js'

/**
 * O-42: change detection by change windows (SPEC §2.9).
 *
 * Every mark — a component added, changed or removed, a resource changed —
 * gets a stamp from one increasing counter. A change-detection filter
 * reports the marks whose stamp falls in its reader's window `(from, to]`:
 * for a system, from the end of its previous run to the start of this one;
 * for any other live query, from the last tick it was read up to the read.
 * Nothing is reset at tick boundaries, so a mark is never lost to a reader
 * that ran earlier in the tick than the writer.
 *
 * Added/changed stamps are kept per (type, entity) and dropped when the
 * component goes away. Removal stamps outlive the entity, so they are
 * pruned once every reader of an `OnRemoved` filter has seen them.
 */

export type MarkKind = 'added' | 'changed' | 'removed'

/** A reader's change window: marks stamped in `(from, to]` are reported. */
export interface ChangeWindow {
  readonly from: number
  readonly to: number
}

/**
 * Snapshot form of the marks some system had not seen yet (O-42), so a
 * restored world reports them exactly as the live one would. Marks are in
 * stamp order; `seen[name]` is how many of them that system had already
 * seen. Systems absent from `seen` had seen them all.
 */
export interface ChangesSnapshot {
  readonly marks: ReadonlyArray<
    | readonly ['added' | 'changed' | 'removed', string, Entity]
    | readonly ['resource', string]
  >
  readonly seen: Readonly<Record<string, number>>
}

/** One change-detection reader for snapshot encoding: a system's cursor. */
export interface ChangeCursor {
  /** The system's name, made unique by occurrence (`name#1`, …) on a clash. */
  readonly name: string
  readonly seenThrough: number
  /** The system reads `OnRemoved`: removal marks are carried for it. */
  readonly readsRemovals: boolean
}

export type ChangeLog = ReturnType<typeof createChangeLog>

export function createChangeLog() {
  let seq = 0
  const stamps: Record<MarkKind, Map<string, Map<Entity, number>>> = {
    added: new Map(),
    changed: new Map(),
    removed: new Map(),
  }
  const resourceStamps = new Map<string, number>()
  // O-54: added/changed marks per type in stamp order, so a window read
  // visits the marks in the window instead of every holder of the type.
  // Entries a later mark or `forget` superseded stay until compaction.
  // Parallel typed arrays (stamp, entity) with an explicit length, so a mark
  // allocates nothing and compaction never shrinks the backing store (WS-5
  // A1: plain arrays were shrunk and regrown every tick by a workload that
  // re-marks every entity). Capacity only doubles. A log is kept only while
  // some query reads it (`readers`), so marks of types no such query
  // watches cost nothing extra.
  interface MarkLog { st: Float64Array; en: Float64Array; len: number; readers: number }
  let watchedLogs = 0
  const marksLog: Record<'added' | 'changed', Map<string, MarkLog>> = {
    added: new Map(),
    changed: new Map(),
  }
  // Removal marks in stamp order, for pruning from the front.
  let removedLog: Array<readonly [number, string, Entity]> = []
  let removedHead = 0

  function put(kind: MarkKind, name: string, entity: Entity, stamp: number): void {
    let m = stamps[kind].get(name)
    if (!m) {
      m = new Map()
      stamps[kind].set(name, m)
    }
    m.set(entity, stamp)
    if (kind === 'removed') {
      removedLog.push([stamp, name, entity])
      return
    }
    if (watchedLogs === 0) return
    const log = marksLog[kind].get(name)
    if (!log) return
    if (log.len === log.st.length) growLog(log)
    log.st[log.len] = stamp
    log.en[log.len] = entity
    log.len++
    // Compact in place once stale entries dominate: amortized O(1) per mark,
    // live entries proportional to the live marks.
    if (log.len > 64 && log.len > 2 * m.size) {
      // Keeping the current entries keeps stamp order: no sort needed.
      const st = log.st
      const en = log.en
      let j = 0
      for (let i = 0; i < log.len; i++) {
        const e = en[i]!
        if (m.get(e) === st[i]) {
          st[j] = st[i]!
          en[j] = e
          j++
        }
      }
      log.len = j
    }
  }

  function mark(kind: MarkKind, name: string, entity: Entity): void {
    if (kind === 'removed') forget(name, entity)
    put(kind, name, entity, ++seq)
  }

  /** The component is gone: its added/changed marks can no longer match. */
  function forget(name: string, entity: Entity): void {
    stamps.added.get(name)?.delete(entity)
    stamps.changed.get(name)?.delete(entity)
  }

  function markResource(name: string): void {
    resourceStamps.set(name, ++seq)
  }

  /** Whether `entity` has a `kind` mark for `name` stamped in `w`. */
  function has(kind: MarkKind, name: string, entity: Entity, w: ChangeWindow): boolean {
    const stamp = stamps[kind].get(name)?.get(entity)
    return stamp !== undefined && stamp > w.from && stamp <= w.to
  }

  /** Whether resource `name` changed in `w`. */
  function resourceChanged(name: string, w: ChangeWindow): boolean {
    const stamp = resourceStamps.get(name)
    return stamp !== undefined && stamp > w.from && stamp <= w.to
  }

  /**
   * Entities with a removal mark for one of `names` stamped in `(from, to]`,
   * found by stamp rather than by scanning every retained mark, so reads
   * stay proportional to the window even while pruning is held back.
   */
  function removedInWindow(names: ReadonlySet<string>, from: number, to: number): Entity[] {
    let lo = removedHead
    let hi = removedLog.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (removedLog[mid]![0] <= from) lo = mid + 1
      else hi = mid
    }
    const out: Entity[] = []
    for (let i = lo; i < removedLog.length; i++) {
      const [stamp, name, entity] = removedLog[i]!
      if (stamp > to) break
      // A later removal of the same pair supersedes this entry.
      if (names.has(name) && stamps.removed.get(name)?.get(entity) === stamp) out.push(entity)
    }
    return out
  }


  /**
   * Entities with a current `kind` mark for `name` stamped in `(from, to]`,
   * in stamp order (O-54). Visits only the marks in the window. Returns
   * null when no log is kept for them ({@link watchMarks}) or the window
   * holds more than `limit` log entries, so the caller can scan its members
   * instead.
   */
  function markedInWindow(
    kind: 'added' | 'changed',
    name: string,
    from: number,
    to: number,
    limit: number,
  ): Entity[] | null {
    const log = marksLog[kind].get(name)
    const live = stamps[kind].get(name)
    if (!log) return null
    if (!live) return []
    const st = log.st
    const lo = upperBound(st, log.len, from)
    const hi = upperBound(st, log.len, to)
    if (hi - lo > limit) return null
    const out: Entity[] = []
    for (let i = lo; i < hi; i++) {
      const entity = log.en[i]!
      if (live.get(entity) === st[i]) out.push(entity)
    }
    return out
  }

  /**
   * Start (or join) keeping the stamp-ordered log of `kind` marks for
   * `name`, built from the current marks. Returns the release function.
   */
  function watchMarks(kind: 'added' | 'changed', name: string): () => void {
    let log = marksLog[kind].get(name)
    if (!log) {
      log = buildLog(kind, name)
      marksLog[kind].set(name, log)
      watchedLogs++
    }
    log.readers++
    let released = false
    return () => {
      if (released) return
      released = true
      const current = marksLog[kind].get(name)
      if (current && --current.readers === 0) {
        marksLog[kind].delete(name)
        watchedLogs--
      }
    }
  }

  function buildLog(kind: 'added' | 'changed', name: string): MarkLog {
    const pairs = Array.from(stamps[kind].get(name) ?? [], ([e, st]) => [st, e] as const)
    pairs.sort((a, b) => a[0] - b[0])
    const capacity = Math.max(64, pairs.length * 2)
    const log: MarkLog = { st: new Float64Array(capacity), en: new Float64Array(capacity), len: pairs.length, readers: 0 }
    pairs.forEach(([st, e], i) => {
      log.st[i] = st
      log.en[i] = e
    })
    return log
  }

  function growLog(log: MarkLog): void {
    const st = new Float64Array(log.st.length * 2)
    const en = new Float64Array(log.en.length * 2)
    st.set(log.st)
    en.set(log.en)
    log.st = st
    log.en = en
  }

  /** Index of the first of the first `len` ascending stamps in `st` greater than `x`. */
  function upperBound(st: Float64Array, len: number, x: number): number {
    let lo = 0
    let hi = len
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (st[mid]! <= x) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** Drop removal marks every `OnRemoved` reader has seen (stamp <= horizon). */
  function pruneRemoved(horizon: number): void {
    while (removedHead < removedLog.length && removedLog[removedHead]![0] <= horizon) {
      const [stamp, name, entity] = removedLog[removedHead]!
      const m = stamps.removed.get(name)
      if (m && m.get(entity) === stamp) {
        m.delete(entity)
        if (m.size === 0) stamps.removed.delete(name)
      }
      removedHead++
    }
    if (removedHead > 1024 && removedHead * 2 > removedLog.length) {
      removedLog = removedLog.slice(removedHead)
      removedHead = 0
    }
  }

  function clear(): void {
    stamps.added.clear()
    stamps.changed.clear()
    stamps.removed.clear()
    resourceStamps.clear()
    for (const logs of [marksLog.added, marksLog.changed]) {
      for (const log of logs.values()) log.len = 0
    }
    removedLog = []
    removedHead = 0
  }

  /**
   * Encode the marks that some cursor has not seen, renumbered from 1 in
   * stamp order so the result depends only on the marks' relative order.
   * Returns undefined when every cursor has seen every mark.
   */
  function encode(
    cursors: readonly ChangeCursor[],
    skipResource?: (name: string) => boolean,
  ): ChangesSnapshot | undefined {
    if (cursors.length === 0) return undefined
    // A mark is carried while some system that could report it has not
    // seen it: removal marks only for `OnRemoved` readers, so retention for
    // other readers (non-system queries) never shows up in the snapshot.
    let floor = Infinity
    let removedFloor = Infinity
    for (const c of cursors) {
      if (c.seenThrough < floor) floor = c.seenThrough
      if (c.readsRemovals && c.seenThrough < removedFloor) removedFloor = c.seenThrough
    }
    const carried: Array<[number, ChangesSnapshot['marks'][number]]> = []
    for (const kind of ['added', 'changed', 'removed'] as const) {
      const kindFloor = kind === 'removed' ? removedFloor : floor
      for (const [name, m] of stamps[kind]) {
        for (const [entity, stamp] of m) {
          if (stamp > kindFloor) carried.push([stamp, [kind, name, entity]])
        }
      }
    }
    for (const [name, stamp] of resourceStamps) {
      // A transient resource (O-36) is not in the snapshot; neither are its marks.
      if (stamp > floor && !skipResource?.(name)) carried.push([stamp, ['resource', name]])
    }
    if (carried.length === 0) return undefined
    carried.sort((a, b) => a[0] - b[0])
    const ordered = carried.map(([s]) => s)
    // Number of carried marks with stamp <= x.
    const rank = (x: number): number => {
      let lo = 0
      let hi = ordered.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (ordered[mid]! <= x) lo = mid + 1
        else hi = mid
      }
      return lo
    }
    const byName = new Map<string, number>()
    for (const c of cursors) {
      const r = rank(c.seenThrough)
      if (r >= carried.length) continue
      const prev = byName.get(c.name)
      byName.set(c.name, prev === undefined ? r : Math.min(prev, r))
    }
    const seen: Record<string, number> = {}
    for (const name of Array.from(byName.keys()).sort()) seen[name] = byName.get(name)!
    return { marks: carried.map(([, m]) => m), seen }
  }

  /**
   * Replace all marks with `snap`'s, stamped after every stamp issued so
   * far. Returns `base`: a cursor at `base + n` has seen the first n marks.
   * Every mark is kept, even one for a component the entity lacks, so the
   * next snapshot encodes exactly what this one carried.
   */
  function decode(snap: ChangesSnapshot | undefined): { base: number; count: number } {
    clear()
    const base = seq
    const marks = snap?.marks ?? []
    marks.forEach((m, i) => {
      const stamp = base + i + 1
      if (m[0] === 'resource') resourceStamps.set(m[1], stamp)
      else put(m[0], m[1], m[2], stamp)
    })
    seq = base + marks.length
    return { base, count: marks.length }
  }

  return {
    get seq() {
      return seq
    },
    mark,
    forget,
    markResource,
    has,
    /**
     * The stamp maps, name → entity → stamp, for the per-entity hot path
     * (world.ts evalEntity), which compares against its read window inline.
     */
    stamps: stamps as Readonly<Record<MarkKind, ReadonlyMap<string, ReadonlyMap<Entity, number>>>>,
    resourceChanged,
    removedInWindow,
    markedInWindow,
    watchMarks,
    pruneRemoved,
    clear,
    encode,
    decode,
  }
}
