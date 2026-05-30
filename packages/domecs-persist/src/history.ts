import type { DomecsError, Entity, Result, World, WorldSnapshot } from '@domecs/core'
import { SNAPSHOT_VERSION, err, normalizeCause, ok } from '@domecs/core'

export interface SnapshotHistoryOptions {
  /**
   * Maximum number of checkpoints retained. Once exceeded, the oldest are
   * dropped (a ring). Default `50`. Must be `>= 1`.
   */
  limit?: number
  /**
   * Capture the world's current state as the initial checkpoint at creation,
   * so `undo()` has a baseline to return to. Default `true`.
   */
  captureInitial?: boolean
}

/**
 * Undo/redo ring over `WorldSnapshot`s. `push()` records the current world as
 * a checkpoint; `undo()`/`redo()` move a cursor through the ring and
 * `world.restore()` the checkpoint there. Pushing after an undo truncates the
 * orphaned redo branch (standard linear-history semantics). Bounded by
 * `limit`; serializable via `toJSON()` / `load()`.
 */
export interface SnapshotHistory {
  /** Snapshot the world and append it as the new current checkpoint. */
  push(): void
  /** Restore the previous checkpoint. Returns `false` at the oldest. */
  undo(): boolean
  /** Restore the next checkpoint. Returns `false` at the newest. */
  redo(): boolean
  canUndo(): boolean
  canRedo(): boolean
  /** Drop every checkpoint; `length` becomes 0. */
  clear(): void
  /** Number of checkpoints currently retained. */
  readonly length: number
  /** Cursor: index of the current checkpoint, or `-1` when empty. */
  readonly index: number
  /** The retained checkpoints, oldest-first. */
  snapshots(): readonly WorldSnapshot[]
  /** The checkpoint at the cursor, or `undefined` when empty. */
  current(): WorldSnapshot | undefined
  /** Serialize the ring (+cursor) to JSON. */
  toJSON(): string
  /**
   * Replace the ring from a {@link toJSON} payload and restore the world to
   * the saved cursor. `persist_io` on malformed input; the existing history
   * and world are left untouched on failure.
   */
  load(json: string): Result<void, DomecsError>
}

interface HistoryEnvelope {
  readonly version: number
  readonly index: number
  readonly snapshots: readonly WorldSnapshot[]
}

export function createSnapshotHistory(
  world: World,
  opts: SnapshotHistoryOptions = {},
): SnapshotHistory {
  const limit = opts.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`domecs/persist: snapshot history limit must be an integer >= 1; got ${limit}`)
  }

  let stack: WorldSnapshot[] = []
  let cursor = -1

  if (opts.captureInitial !== false) {
    stack.push(world.snapshot())
    cursor = 0
  }

  function trim(): void {
    if (stack.length > limit) {
      const overflow = stack.length - limit
      stack.splice(0, overflow)
      cursor -= overflow
    }
  }

  return {
    push(): void {
      // Drop any orphaned redo branch, then append.
      if (cursor < stack.length - 1) stack.length = cursor + 1
      stack.push(world.snapshot())
      cursor = stack.length - 1
      trim()
    },
    undo(): boolean {
      if (cursor <= 0) return false
      cursor--
      world.restore(stack[cursor]!)
      return true
    },
    redo(): boolean {
      if (cursor >= stack.length - 1) return false
      cursor++
      world.restore(stack[cursor]!)
      return true
    },
    canUndo: () => cursor > 0,
    canRedo: () => cursor < stack.length - 1,
    clear(): void {
      stack = []
      cursor = -1
    },
    get length() {
      return stack.length
    },
    get index() {
      return cursor
    },
    snapshots: () => stack.slice(),
    current: () => (cursor >= 0 ? stack[cursor] : undefined),
    toJSON(): string {
      const envelope: HistoryEnvelope = { version: SNAPSHOT_VERSION, index: cursor, snapshots: stack }
      return JSON.stringify(envelope)
    },
    load(json: string): Result<void, DomecsError> {
      let parsed: unknown
      try {
        parsed = JSON.parse(json)
      } catch (cause) {
        return err({ kind: 'persist_io', op: 'load', cause: normalizeCause(cause) })
      }
      if (!isHistoryEnvelope(parsed)) {
        return err({
          kind: 'persist_io',
          op: 'load',
          cause: normalizeCause(new Error('payload is not a snapshot-history envelope')),
        })
      }
      const nextStack = parsed.snapshots.slice()
      const nextCursor = parsed.index
      if (nextCursor < -1 || nextCursor >= nextStack.length) {
        return err({
          kind: 'persist_io',
          op: 'load',
          cause: normalizeCause(new Error(`history cursor ${nextCursor} out of range`)),
        })
      }
      if (nextCursor >= 0) {
        try {
          world.restore(nextStack[nextCursor]!)
        } catch (cause) {
          return err({ kind: 'persist_io', op: 'load', cause: normalizeCause(cause) })
        }
      }
      stack = nextStack
      cursor = nextCursor
      return ok(undefined)
    },
  }
}

export interface SnapshotDiff {
  /** Entity ids present in `next` but not `prev`. */
  readonly addedEntities: readonly Entity[]
  /** Entity ids present in `prev` but not `next`. */
  readonly removedEntities: readonly Entity[]
  /** Entity ids in both whose component bag differs (shallow JSON equality). */
  readonly changedEntities: readonly Entity[]
}

/**
 * Entity-level diff between two snapshots. `changedEntities` compares each
 * shared entity's component bag by JSON equality — snapshots are JSON-shaped
 * and per-entity key order is archetype-deterministic, so value or
 * composition changes both register. Useful for history timelines / undo UIs.
 */
export function diffSnapshots(prev: WorldSnapshot, next: WorldSnapshot): SnapshotDiff {
  const prevById = new Map<Entity, string>()
  for (const e of prev.entities) prevById.set(e.id, JSON.stringify(e.components))
  const nextById = new Map<Entity, string>()
  for (const e of next.entities) nextById.set(e.id, JSON.stringify(e.components))

  const addedEntities: Entity[] = []
  const removedEntities: Entity[] = []
  const changedEntities: Entity[] = []

  for (const [id, comps] of nextById) {
    const before = prevById.get(id)
    if (before === undefined) addedEntities.push(id)
    else if (before !== comps) changedEntities.push(id)
  }
  for (const id of prevById.keys()) {
    if (!nextById.has(id)) removedEntities.push(id)
  }

  return { addedEntities, removedEntities, changedEntities }
}

function isHistoryEnvelope(v: unknown): v is HistoryEnvelope {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.version === 'number' && typeof o.index === 'number' && Array.isArray(o.snapshots)
}
