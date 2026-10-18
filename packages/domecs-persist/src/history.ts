import type { DomecsError, Entity, JsonValue, Result, World, WorldSnapshot } from '@domecs/core'
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

  function moveTo(target: number): void {
    const from = cursor
    cursor = target
    try {
      world.restore(stack[target]!)
    } catch (cause) {
      cursor = from
      throw cause
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
    // O-62: a restore that throws puts the cursor back, so it stays on the
    // checkpoint the world is still showing. The cursor moves first so code
    // running inside the restore (query hooks) sees the new position.
    undo(): boolean {
      if (cursor <= 0) return false
      moveTo(cursor - 1)
      return true
    },
    redo(): boolean {
      if (cursor >= stack.length - 1) return false
      moveTo(cursor + 1)
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
      // Every failure here is in the payload itself and repeats on retry
      // (O-62), so none is reported as retryable.
      let parsed: unknown
      try {
        parsed = JSON.parse(json)
      } catch (cause) {
        return err({ kind: 'persist_io', op: 'load', cause: normalizeCause(cause), retryable: false })
      }
      if (!isHistoryEnvelope(parsed)) {
        return err({
          kind: 'persist_io',
          op: 'load',
          cause: normalizeCause(new Error('payload is not a snapshot-history envelope')),
          retryable: false,
        })
      }
      const nextStack = parsed.snapshots.slice()
      const nextCursor = parsed.index
      if (nextCursor < -1 || nextCursor >= nextStack.length) {
        return err({
          kind: 'persist_io',
          op: 'load',
          cause: normalizeCause(new Error(`history cursor ${nextCursor} out of range`)),
          retryable: false,
        })
      }
      if (nextCursor >= 0) {
        try {
          world.restore(nextStack[nextCursor]!)
        } catch (cause) {
          return err({ kind: 'persist_io', op: 'load', cause: normalizeCause(cause), retryable: false })
        }
      }
      stack = nextStack
      cursor = nextCursor
      return ok(undefined)
    },
  }
}

/** Options for {@link diffSnapshots}. */
export interface SnapshotDiffOptions {
  /** Report component/field/resource changes, not just entity ids. Default false. */
  readonly fields?: boolean
  /**
   * Restrict field reporting (`fieldChanges`, `componentsAdded`,
   * `componentsRemoved`) to these component names. The entity-level lists
   * stay complete.
   */
  readonly components?: readonly string[]
  /** Numbers within epsilon compare equal (absolute). Default 0 (exact, `-0` ≠ `0`). */
  readonly epsilon?: number
  /**
   * Stop after this many field changes (component fields plus resources)
   * and set `truncated`. Default 10_000.
   */
  readonly limit?: number
}

/** One changed value inside a component. */
export interface FieldChange {
  readonly entity: Entity
  readonly component: string
  /**
   * Dotted path inside the component value: `"x"`, `"inv.items[2].qty"`; a
   * key that is not an identifier is written `["key"]`. `""` is the whole
   * value.
   */
  readonly path: string
  /** `undefined` = absent. */
  readonly before: JsonValue | undefined
  readonly after: JsonValue | undefined
}

/** One changed value inside a resource (`path` as in {@link FieldChange}). */
export interface ResourceChange {
  readonly resource: string
  readonly path: string
  readonly before: JsonValue | undefined
  readonly after: JsonValue | undefined
}

export interface SnapshotDiff {
  /** Entity ids present in `next` but not `prev`. */
  readonly addedEntities: readonly Entity[]
  /** Entity ids present in `prev` but not `next`. */
  readonly removedEntities: readonly Entity[]
  /**
   * Entity ids in both whose component bag differs as data (canonical
   * comparison: key order is ignored, `-0` ≠ `0` unless `epsilon` covers it).
   */
  readonly changedEntities: readonly Entity[]
  /** With `fields: true`: components an entity in both snapshots gained. */
  readonly componentsAdded?: ReadonlyArray<{ readonly entity: Entity; readonly component: string }>
  /** With `fields: true`: components an entity in both snapshots lost. */
  readonly componentsRemoved?: ReadonlyArray<{ readonly entity: Entity; readonly component: string }>
  /** With `fields: true`: value changes inside components both sides hold. */
  readonly fieldChanges?: readonly FieldChange[]
  /** With `fields: true`: value changes inside resources, and resources added or removed (`path: ""`). */
  readonly resourceChanges?: readonly ResourceChange[]
  /** With `fields: true`: whether `limit` cut the field reporting short. */
  readonly truncated?: boolean
}

/** The first difference {@link firstDivergence} finds. */
export type Divergence =
  | {
      readonly where: 'state'
      readonly key: 'seed' | 'tick' | 'scaledTime' | 'nextId' | 'rngRoot' | 'rngStreams' | 'fixedBacklog'
    }
  | { readonly where: 'entity'; readonly entity: Entity; readonly change: 'added' | 'removed' | FieldChange }
  | { readonly where: 'resource'; readonly change: ResourceChange }

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function keyPath(base: string, key: string): string {
  if (IDENT.test(key)) return base === '' ? key : `${base}.${key}`
  return `${base}[${JSON.stringify(key)}]`
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Present as JSON data: canonical JSON omits these in objects. */
function present(v: unknown): boolean {
  return v !== undefined && typeof v !== 'function' && typeof v !== 'symbol'
}

/** Array elements with no JSON text read as `null`, as in canonical JSON. */
function element(v: unknown): unknown {
  return present(v) ? v : null
}

function sortedKeys(...objs: Array<Record<string, unknown> | undefined>): string[] {
  const set = new Set<string>()
  for (const o of objs) {
    if (!o) continue
    for (const k of Object.keys(o)) if (present(o[k])) set.add(k)
  }
  return [...set].sort()
}

function scalarEqual(a: unknown, b: unknown, epsilon: number): boolean {
  if (Object.is(a, b)) return true
  return epsilon > 0 && typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= epsilon
}

/** Data equality: key order ignored, absent ≡ undefined, numbers by `Object.is` or epsilon. */
function dataEqual(a: unknown, b: unknown, epsilon: number): boolean {
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!dataEqual(element(a[i]), element(b[i]), epsilon)) return false
    return true
  }
  if (isRecord(a)) {
    if (!isRecord(b)) return false
    const ka = sortedKeys(a)
    const kb = sortedKeys(b)
    if (ka.length !== kb.length) return false
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i] || !dataEqual(a[ka[i]!], b[ka[i]!], epsilon)) return false
    }
    return true
  }
  return scalarEqual(a, b, epsilon)
}

/**
 * Walk two values in canonical order, calling `emit(path, before, after)`
 * for each difference; `emit` returns false to stop. Returns false when
 * stopped.
 */
function walkValues(
  before: unknown,
  after: unknown,
  path: string,
  epsilon: number,
  emit: (path: string, before: unknown, after: unknown) => boolean,
): boolean {
  if (Array.isArray(before) && Array.isArray(after)) {
    const n = Math.max(before.length, after.length)
    for (let i = 0; i < n; i++) {
      const p = `${path}[${i}]`
      if (i >= after.length) {
        if (!emit(p, element(before[i]), undefined)) return false
      } else if (i >= before.length) {
        if (!emit(p, undefined, element(after[i]))) return false
      } else if (!walkValues(element(before[i]), element(after[i]), p, epsilon, emit)) return false
    }
    return true
  }
  if (isRecord(before) && isRecord(after)) {
    for (const k of sortedKeys(before, after)) {
      const b = present(before[k]) ? before[k] : undefined
      const a = present(after[k]) ? after[k] : undefined
      const p = keyPath(path, k)
      if (b === undefined || a === undefined) {
        if (!emit(p, b, a)) return false
      } else if (!walkValues(b, a, p, epsilon, emit)) return false
    }
    return true
  }
  if (dataEqual(before, after, epsilon)) return true
  return emit(path, before, after)
}

/**
 * Walk two name-keyed maps (component bags, resource maps) in sorted name
 * order: a name on one side only is one difference at path `""`; otherwise
 * the values are walked. `emit` returns false to stop.
 */
function walkNamed(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  epsilon: number,
  emit: (name: string, path: string, before: unknown, after: unknown) => boolean,
): boolean {
  for (const name of sortedKeys(before, after)) {
    const b = present(before[name]) ? before[name] : undefined
    const a = present(after[name]) ? after[name] : undefined
    if (b === undefined || a === undefined) {
      if (!emit(name, '', b, a)) return false
    } else if (!walkValues(b, a, '', epsilon, (path, bv, av) => emit(name, path, bv, av))) return false
  }
  return true
}

function validateDiffOptions(o: SnapshotDiffOptions | undefined): { epsilon: number; limit: number } {
  const epsilon = o?.epsilon ?? 0
  const limit = o?.limit ?? 10_000
  if (!(Number.isFinite(epsilon) && epsilon >= 0)) {
    throw new RangeError(`diffSnapshots: epsilon must be a finite number >= 0, got ${String(o?.epsilon)}`)
  }
  if (!(Number.isInteger(limit) && limit >= 0)) {
    throw new RangeError(`diffSnapshots: limit must be an integer >= 0, got ${String(o?.limit)}`)
  }
  return { epsilon, limit }
}

/**
 * Diff between two snapshots. Entity-level by default: `changedEntities`
 * compares each shared entity's component bag as data (key order ignored —
 * a **behaviour change** from the earlier `JSON.stringify` comparison,
 * which also reported key-order-only differences).
 *
 * With `fields: true` it also walks the values — ascending entity id, then
 * sorted component name, then sorted key; arrays element-wise, with a
 * length change reported as added/removed tail elements — and lists
 * components added/removed, field changes and resource changes, up to
 * `limit` changes (`truncated` says whether it stopped early). Pure; never
 * mutates its inputs. Throws `RangeError` for an invalid `epsilon`/`limit`.
 */
export function diffSnapshots(
  prev: WorldSnapshot,
  next: WorldSnapshot,
  options?: SnapshotDiffOptions,
): SnapshotDiff {
  const { epsilon, limit } = validateDiffOptions(options)
  const prevById = new Map<Entity, Record<string, unknown>>()
  for (const e of prev.entities) prevById.set(e.id, e.components)
  const nextById = new Map<Entity, Record<string, unknown>>()
  for (const e of next.entities) nextById.set(e.id, e.components)

  const addedEntities: Entity[] = []
  const removedEntities: Entity[] = []
  const changedEntities: Entity[] = []

  for (const [id, comps] of nextById) {
    const before = prevById.get(id)
    if (before === undefined) addedEntities.push(id)
    else if (!dataEqual(before, comps, epsilon)) changedEntities.push(id)
  }
  for (const id of prevById.keys()) {
    if (!nextById.has(id)) removedEntities.push(id)
  }
  if (options?.fields !== true) return { addedEntities, removedEntities, changedEntities }

  const only = options.components ? new Set(options.components) : null
  const componentsAdded: Array<{ entity: Entity; component: string }> = []
  const componentsRemoved: Array<{ entity: Entity; component: string }> = []
  const fieldChanges: FieldChange[] = []
  const resourceChanges: ResourceChange[] = []
  let count = 0
  let truncated = false

  for (const entity of changedEntities.slice().sort((a, b) => a - b)) {
    if (truncated) break
    const before = prevById.get(entity)!
    const after = nextById.get(entity)!
    for (const component of sortedKeys(before, after)) {
      if (only && !only.has(component)) continue
      const b = before[component]
      const a = after[component]
      if (!present(b)) componentsAdded.push({ entity, component })
      else if (!present(a)) componentsRemoved.push({ entity, component })
      else {
        const ok = walkValues(b, a, '', epsilon, (path, bv, av) => {
          if (count >= limit) {
            truncated = true
            return false
          }
          count++
          fieldChanges.push({
            entity,
            component,
            path,
            before: bv as JsonValue | undefined,
            after: av as JsonValue | undefined,
          })
          return true
        })
        if (!ok) break
      }
    }
  }

  if (!truncated) {
    walkNamed(prev.resources ?? {}, next.resources ?? {}, epsilon, (resource, path, bv, av) => {
      if (count >= limit) {
        truncated = true
        return false
      }
      count++
      resourceChanges.push({
        resource,
        path,
        before: bv as JsonValue | undefined,
        after: av as JsonValue | undefined,
      })
      return true
    })
  }

  return {
    addedEntities,
    removedEntities,
    changedEntities,
    componentsAdded,
    componentsRemoved,
    fieldChanges,
    resourceChanges,
    truncated,
  }
}

const STATE_KEYS = ['seed', 'tick', 'scaledTime', 'nextId', 'rngRoot', 'rngStreams', 'fixedBacklog'] as const

/**
 * The first difference between two snapshots, in canonical order: the
 * top-level state fields (`seed`, `tick`, `scaledTime`, `nextId`,
 * `rngRoot`, `rngStreams`, then `fixedBacklog` with its `fixedStep`), then
 * the lowest entity id that differs (added, removed, or its first field
 * change by sorted component name and key; a component present on one side
 * only is a change at path `""`), then resources by sorted name. `version`,
 * `meta` and `changes` are not compared (the default `hashSnapshot` scope).
 * `null` when the snapshots are equal as data. Exact comparison (`-0` ≠ `0`).
 */
export function firstDivergence(a: WorldSnapshot, b: WorldSnapshot): Divergence | null {
  const ra = a as unknown as Record<string, unknown>
  const rb = b as unknown as Record<string, unknown>
  for (const key of STATE_KEYS) {
    const same =
      key === 'fixedBacklog'
        ? dataEqual(ra.fixedBacklog, rb.fixedBacklog, 0) && dataEqual(ra.fixedStep, rb.fixedStep, 0)
        : dataEqual(ra[key], rb[key], 0)
    if (!same) return { where: 'state', key }
  }

  const ea = new Map<Entity, Record<string, unknown>>()
  for (const e of a.entities) ea.set(e.id, e.components)
  const eb = new Map<Entity, Record<string, unknown>>()
  for (const e of b.entities) eb.set(e.id, e.components)
  const ids = [...new Set([...ea.keys(), ...eb.keys()])].sort((x, y) => x - y)
  for (const entity of ids) {
    const ca = ea.get(entity)
    const cb = eb.get(entity)
    if (ca === undefined) return { where: 'entity', entity, change: 'added' }
    if (cb === undefined) return { where: 'entity', entity, change: 'removed' }
    let found: FieldChange | null = null
    walkNamed(ca, cb, 0, (component, path, bv, av) => {
      found = {
        entity,
        component,
        path,
        before: bv as JsonValue | undefined,
        after: av as JsonValue | undefined,
      }
      return false
    })
    if (found) return { where: 'entity', entity, change: found }
  }

  let resource: ResourceChange | null = null
  walkNamed(a.resources ?? {}, b.resources ?? {}, 0, (name, path, bv, av) => {
    resource = {
      resource: name,
      path,
      before: bv as JsonValue | undefined,
      after: av as JsonValue | undefined,
    }
    return false
  })
  if (resource) return { where: 'resource', change: resource }
  return null
}

function isHistoryEnvelope(v: unknown): v is HistoryEnvelope {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.version === 'number' && typeof o.index === 'number' && Array.isArray(o.snapshots)
}
