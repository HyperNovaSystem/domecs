import { internal } from './component.js'
import type { ChangeCursor, ChangeLog } from './change-log.js'
import { restoreRng, rewindRng, type Rng } from './rng.js'
import type { EmittedEvent, EventType } from './events.js'
import type { JsonValue } from './result.js'
import {
  cloneSerializable,
  SNAPSHOT_VERSION,
  type SnapshotPendingEvent,
  type WorldSnapshot,
} from './snapshot.js'
import { fixedStepsDue, type TimeState } from './time.js'
import type { ComponentType, Entity } from './types.js'
import type { SortedIdSet } from './id-set.js'
import type { EntityView, QueryNode } from './query.js'
import type { ResourceState } from './world-resources.js'

/**
 * Snapshot/restore mechanics, extracted from world.ts (O-23). The public
 * `World.snapshot()`/`World.restore()` stay in the factory as orchestration
 * (they run the plugin onSnapshot/onRestore hook chains); the entity/
 * resource/clock serialization work lives here, threaded through a
 * {@link WorldStateCtx} that exposes the factory's closure state.
 */

export interface ArchetypeBucket {
  readonly key: string
  readonly types: Set<string>
  readonly entities: SortedIdSet
}

export interface CompiledQuery {
  id: number
  node: QueryNode
  hasTickFilter: boolean
  hasRemoved: boolean
  /** Has a change-detection node (OnAdded/OnChanged/OnRemoved/OnChangedResource). */
  temporal: boolean
  /**
   * O-42: the system whose `query`/`reactsTo` this is — its change window
   * is the system's. Null for any other live query, whose window runs from
   * `seenThrough` to the read and advances at tick end to `readThrough`.
   */
  owner: { seenThrough: number; runStart: number; running: boolean } | null
  seenThrough: number
  readThrough: number
  /** `time.tick` of its last read; -1 if never read (idle-driver check). */
  lastReadTick: number
  /** Whether a read now would report anything, without counting as one. */
  peekUnread: () => boolean
  matchingArchetypes: Set<ArchetypeBucket>
  structuralMembers: SortedIdSet
  onAddFns: Set<(v: EntityView) => void>
  onRemoveFns: Set<(v: EntityView) => void>
}

/**
 * F-3 drift-free fixed-step bookkeeping. Restore rebuilds it from the
 * snapshot's `scaledTime` (O-40): every field is a pure function of
 * `totalScaledSeconds` and `time.fixedStep` after a completed tick.
 */
export interface StepClock {
  fixedStepCounter: number
  totalScaledSeconds: number
  fixedStepsFired: number
  lastQuantizedElapsedMs: number
}

export interface WorldStateCtx {
  alive: Set<Entity>
  stores: Map<string, Map<Entity, unknown>>
  typeRegistry: Map<string, ComponentType<unknown>>
  archetypes: Map<string, ArchetypeBucket>
  entityArchetype: Map<Entity, ArchetypeBucket>
  changes: ChangeLog
  /** Cursors of the systems that read change-detection filters (O-42). */
  changeCursors(): ChangeCursor[]
  /**
   * Restore re-issued the snapshot's marks as stamps `base+1 … base+count`;
   * move every reader's window to match `seen` (O-42).
   */
  resumeChangeWindows(base: number, count: number, seen: Readonly<Record<string, number>>): void
  viewCache: Map<Entity, EntityView>
  queries: CompiledQuery[]
  time: TimeState
  clock: StepClock
  resources: ResourceState
  makeView(entity: Entity): EntityView
  ensureArchetype(types: Set<string>): ArchetypeBucket
  // Reassignable factory closure vars, threaded as accessors.
  getRand(): Rng
  setRand(r: Rng): void
  getNextId(): Entity
  setNextId(id: Entity): void
  setEmptyArch(arch: ArchetypeBucket): void
}

/**
 * Build the snapshot envelope. `pending` is the bus's undelivered events when
 * the caller asked for `{ pendingEvents: true }` (§4.7), else `undefined`;
 * the field is written only when at least one event is in flight, so the
 * option does not change the hash of a world with an empty queue (restoring
 * an absent field and an empty one both leave the queue empty).
 */
export function buildSnapshot(
  ctx: WorldStateCtx,
  pruneEmpty: boolean,
  pending?: readonly EmittedEvent[],
  lookup?: (name: string) => EventType<unknown> | undefined,
): WorldSnapshot {
  const entities: Array<{ id: Entity; components: Record<string, unknown> }> = []
  const sortedAlive = Array.from(ctx.alive).sort((a, b) => a - b)
  for (const id of sortedAlive) {
    const arch = ctx.entityArchetype.get(id)
    if (!arch) continue
    const components: Record<string, unknown> = {}
    for (const name of arch.types) {
      const type = ctx.typeRegistry.get(name)
      if (type && internal(type).__transient) continue
      const store = ctx.stores.get(name)
      if (!store) continue
      const v = store.get(id)
      if (v !== undefined) components[name] = cloneSerializable(v)
    }
    if (pruneEmpty && Object.keys(components).length === 0) continue
    entities.push({ id, components })
  }
  // #16: serialize materialized resources by name; the field is omitted
  // entirely when there are none.
  const resourcesSnap = ctx.resources.snapshotValues()
  // O-40: fixed steps the clock has accumulated but not run — normally 0;
  // positive when a tickStart hook paused the world after time advanced, or
  // when the snapshot is taken inside the fixed-step loop.
  const fixedBacklog =
    fixedStepsDue(ctx.clock.totalScaledSeconds, ctx.time.fixedStep) - ctx.clock.fixedStepsFired
  // O-42: marks a system has not seen yet, so restore can re-issue them.
  const changes = ctx.changes.encode(ctx.changeCursors())
  return {
    version: SNAPSHOT_VERSION,
    seed: ctx.getRand().seed(),
    tick: ctx.time.tick,
    scaledTime: ctx.clock.totalScaledSeconds,
    ...(fixedBacklog > 0 ? { fixedBacklog, fixedStep: ctx.time.fixedStep } : {}),
    entities,
    nextId: ctx.getNextId(),
    ...(resourcesSnap !== undefined ? { resources: resourcesSnap } : {}),
    ...(changes !== undefined ? { changes } : {}),
    ...(pending !== undefined && pending.length > 0
      ? { pendingEvents: encodePendingEvents(pending, lookup) }
      : {}),
  }
}

// ── Pending events (§4.7, O-90) ─────────────────────────────────────────

/**
 * Plain-data copies of the undelivered events, in bus order. A payload
 * that is not plain data throws `TypeError` naming the event and the path.
 *
 * Plain data: `null`, booleans, strings, finite numbers (`-0` kept), arrays
 * and objects whose prototype is `Object.prototype` or `null`. An
 * `undefined` object property is omitted (JSON semantics); an `undefined`
 * payload omits `payload` (a void event). Anything else — `undefined` in an
 * array, a non-finite number, BigInt, symbol, function, class instance
 * (`Date`, `Map`, …) or a cycle — is refused rather than coerced, since a
 * coerced payload would restore as a different value.
 *
 * `lookup` is the snapshotting world's name lookup (`bus.lookup`). The record
 * is by name, so an event whose name does not resolve back to its own type —
 * two distinct known types share it — throws `TypeError` too: restore would
 * refuse it as ambiguous, or re-queue it as the twin in a world that knows
 * only the other type.
 */
export function encodePendingEvents(
  events: readonly EmittedEvent[],
  lookup?: (name: string) => EventType<unknown> | undefined,
): SnapshotPendingEvent[] {
  return events.map((e, i) => {
    if (lookup !== undefined && lookup(e.type.name) !== e.type) {
      throw new TypeError(
        `domecs: snapshot: pending event "${e.type.name}" (pendingEvents[${i}]) cannot be recorded ` +
          `by name: distinct known event types share the name "${e.type.name}"; give each event type ` +
          `a unique name`,
      )
    }
    if (e.payload === undefined) return { event: e.type.name }
    try {
      return { event: e.type.name, payload: plainCopy(e.payload, []) }
    } catch (fault) {
      if (fault instanceof PlainFault) {
        throw new TypeError(
          `domecs: snapshot: pending event "${e.type.name}" (pendingEvents[${i}]) has a payload ` +
            `that is not plain data at payload${fault.path.reverse().join('')}: ${fault.what}`,
        )
      }
      throw fault
    }
  })
}

class PlainFault {
  readonly path: string[] = []
  constructor(readonly what: string) {}
}

const PATH_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function plainCopy(v: unknown, ancestors: object[]): JsonValue {
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v
    case 'number':
      if (!Number.isFinite(v)) throw new PlainFault(`non-finite number ${String(v)}`)
      return v
    case 'undefined':
      throw new PlainFault('undefined')
    case 'bigint':
      throw new PlainFault('a BigInt')
    case 'symbol':
      throw new PlainFault('a symbol')
    case 'function':
      throw new PlainFault('a function')
  }
  if (v === null) return null
  const obj = v as object
  if (ancestors.includes(obj)) throw new PlainFault('a cycle')
  ancestors.push(obj)
  try {
    if (Array.isArray(obj)) {
      const out: JsonValue[] = new Array<JsonValue>(obj.length)
      for (let i = 0; i < obj.length; i++) {
        try {
          out[i] = plainCopy(obj[i], ancestors)
        } catch (fault) {
          if (fault instanceof PlainFault) fault.path.push(`[${i}]`)
          throw fault
        }
      }
      return out
    }
    const proto = Object.getPrototypeOf(obj) as object | null
    if (proto !== Object.prototype && proto !== null) {
      const name = (obj.constructor as { name?: unknown } | undefined)?.name
      throw new PlainFault(typeof name === 'string' && name !== '' ? `a ${name} instance` : 'a class instance')
    }
    const out: Record<string, JsonValue> = {}
    for (const k of Object.keys(obj)) {
      const child = (obj as Record<string, unknown>)[k]
      if (child === undefined) continue
      try {
        out[k] = plainCopy(child, ancestors)
      } catch (fault) {
        if (fault instanceof PlainFault) {
          fault.path.push(PATH_IDENT.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`)
        }
        throw fault
      }
    }
    return out
  } finally {
    ancestors.pop()
  }
}

/**
 * Check a snapshot's `pendingEvents` field and resolve each name through
 * `lookup` (`world.lookupEvent`), touching no state (O-41 pattern): a
 * malformed field, an unknown name or an ambiguous one throws. Returns the
 * events to queue, with payloads cloned so the queue never aliases the
 * snapshot; `undefined` when the field is absent.
 */
export function resolvePendingEvents(
  s: WorldSnapshot,
  lookup: (name: string) => EventType<unknown> | undefined,
  known: () => readonly EventType<unknown>[],
): EmittedEvent[] | undefined {
  const field: unknown = (s as { pendingEvents?: unknown }).pendingEvents
  if (field === undefined) return undefined
  if (!Array.isArray(field)) throw invalid('pendingEvents', 'an array', field)
  return field.map((rec: unknown, i): EmittedEvent => {
    if (!isRecord(rec)) throw invalid(`pendingEvents[${i}]`, 'an object', rec)
    const name = rec.event
    if (typeof name !== 'string') throw invalid(`pendingEvents[${i}].event`, 'a string', name)
    const type = lookup(name)
    if (type === undefined) {
      const sharing = known().filter((t) => t.name === name).length
      throw new Error(
        sharing > 1
          ? `domecs: restore: pending event "${name}" (pendingEvents[${i}]) is ambiguous: ` +
              `${sharing} distinct known event types share the name`
          : `domecs: restore: pending event "${name}" (pendingEvents[${i}]) is not a known event type ` +
              `in this world; register it with world.register(...) before restoring`,
      )
    }
    return { type, payload: cloneSerializable(rec.payload) }
  })
}

/**
 * Replace world state with `s`. The caller has already passed `s` through
 * {@link validateSnapshot} — before any state is wiped, so an invalid
 * snapshot throws cleanly instead of leaving the world half-restored — and
 * hands over the clock it parsed.
 */
export function applySnapshot(ctx: WorldStateCtx, s: WorldSnapshot, clock: SnapshotClock): void {
  // Wipe world state (preserve plugins, system registrations, signals).
  // Capture each live query's current members AS POPULATED VIEWS before the
  // wipe: `makeView` reads stores eagerly, so views materialized here keep
  // their component values after the stores are cleared. Index positionally
  // — `q.id` is a world-global monotonic counter, NOT an index into the live
  // `queries` array (disposed queries are spliced out), so `prevMembers[q.id]`
  // looked up the wrong/undefined set after any dispose and onRemove misfired.
  const prevViews = ctx.queries.map((q) =>
    q.onRemoveFns.size > 0 ? Array.from(q.structuralMembers, (id) => ctx.makeView(id)) : null,
  )
  ctx.alive.clear()
  ctx.stores.clear()
  ctx.archetypes.clear()
  ctx.entityArchetype.clear()
  ctx.changes.clear()
  // #16: resource values are part of the snapshot; clear then rehydrate.
  // The registry (type identity) persists like `typeRegistry`.
  ctx.resources.clearForRestore()
  ctx.viewCache.clear()
  ctx.queries.forEach((q, i) => {
    const views = prevViews[i]
    if (views) for (const view of views) for (const fn of q.onRemoveFns) fn(view)
    q.matchingArchetypes.clear()
    q.structuralMembers.clear()
  })
  ctx.setEmptyArch(ctx.ensureArchetype(new Set<string>()))

  // PRNG state + tick + clock. The generator is rewound in place so a
  // captured `world.rand` handle follows the restore (O-46).
  if (!rewindRng(ctx.getRand(), s.seed)) ctx.setRand(restoreRng(s.seed))
  ctx.time.tick = s.tick
  ctx.time.delta = 0
  ctx.time.scaledDelta = 0
  resumeClock(ctx, clock)

  // Rehydrate entities + components (name-keyed; ComponentType objects
  // attach lazily when callers mutate via addComponent/markChanged).
  let maxId = -1
  for (const rec of s.entities) {
    ctx.alive.add(rec.id)
    if (rec.id > maxId) maxId = rec.id
    const types = new Set<string>()
    for (const [name, value] of Object.entries(rec.components)) {
      let store = ctx.stores.get(name)
      if (!store) {
        store = new Map()
        ctx.stores.set(name, store)
      }
      store.set(rec.id, cloneSerializable(value))
      types.add(name)
    }
    const arch = ctx.ensureArchetype(types)
    arch.entities.add(rec.id)
    ctx.entityArchetype.set(rec.id, arch)
    for (const q of ctx.queries) {
      if (q.matchingArchetypes.has(arch)) {
        q.structuralMembers.add(rec.id)
        if (q.onAddFns.size > 0) {
          const view = ctx.makeView(rec.id)
          for (const fn of q.onAddFns) fn(view)
        }
      }
    }
  }
  // O-38: honor the snapshot's id cursor so post-restore id assignment
  // matches the live world even when the max-id entity was despawned before
  // the snapshot. Older snapshots lack the field — fall back to the derived
  // cursor. Never allow a corrupt cursor to re-issue a live id.
  ctx.setNextId(Math.max(s.nextId ?? 0, maxId + 1))

  // #16: rehydrate resources by name (v1 snapshots have no `resources`,
  // leaving the world's resource set empty — defaults re-materialize lazily).
  if (s.resources) ctx.resources.restoreValues(s.resources)

  // O-42: re-issue the marks systems had not seen, after every stamp this
  // world has issued, and move each reader's window to match. A snapshot
  // without `changes` leaves no marks: every reader has seen everything.
  const { base, count } = ctx.changes.decode(s.changes)
  ctx.resumeChangeWindows(base, count, s.changes?.seen ?? {})
}

/** The clock fields of a snapshot, validated, with absent fields defaulted. */
export interface SnapshotClock {
  readonly scaledTime: number
  readonly fixedBacklog: number
  /** The step `fixedBacklog` is counted in; undefined means this world's. */
  readonly fixedStep: number | undefined
}

/**
 * Check everything restore would reject — the envelope shape, every entity
 * record, resource values and the clock fields — without touching any
 * state. `world.restore()` calls it on the envelope the `onRestore` hooks
 * produce, before it applies it, so a malformed snapshot throws while the
 * live world is still intact (O-41). Returns the parsed clock.
 */
export function validateSnapshot(ctx: WorldStateCtx, s: WorldSnapshot): SnapshotClock {
  validateEnvelope(s)
  // Resource values are validated for every *registered* resource type,
  // mirroring the setResource() contract; names with no registered type
  // pass through (the name-keyed lazy contract). Component values are
  // deliberately NOT validated: the live path validates only at
  // Component.create() and in-place field mutation is unvalidated, so a
  // snapshot may legitimately hold values a validator was never asked to
  // bless.
  if (s.resources) ctx.resources.validateSnapshot(s.resources)
  // O-40: absent means a pre-O-40 envelope (clock at 0). Present-but-invalid
  // — including null — is rejected rather than read as absent.
  const scaledTime = s.scaledTime === undefined ? 0 : s.scaledTime
  if (typeof scaledTime !== 'number' || !Number.isFinite(scaledTime) || scaledTime < 0) {
    throw new Error(
      `domecs: invalid snapshot scaledTime: expected a finite number >= 0, got ${String(s.scaledTime)}`,
    )
  }
  const fixedBacklog = s.fixedBacklog === undefined ? 0 : s.fixedBacklog
  if (typeof fixedBacklog !== 'number' || !Number.isInteger(fixedBacklog) || fixedBacklog < 0) {
    throw new Error(
      `domecs: invalid snapshot fixedBacklog: expected an integer >= 0, got ${String(s.fixedBacklog)}`,
    )
  }
  const fixedStep = s.fixedStep
  if (
    fixedStep !== undefined &&
    (typeof fixedStep !== 'number' || !Number.isFinite(fixedStep) || fixedStep <= 0)
  ) {
    throw new Error(
      `domecs: invalid snapshot fixedStep: expected a finite number > 0, got ${String(fixedStep)}`,
    )
  }
  return { scaledTime, fixedBacklog, fixedStep }
}

function invalid(what: string, expected: string, got: unknown): Error {
  return new Error(`domecs: invalid snapshot ${what}: expected ${expected}, got ${describe(got)}`)
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'an array'
  if (typeof v === 'object') return 'an object'
  return typeof v === 'string' ? JSON.stringify(v) : String(v)
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * O-41: the structural checks `applySnapshot` relies on. Everything it reads
 * after the wipe is checked here first: the seed, tick and id cursor, and
 * each entity record's id and component bag. Component values themselves
 * are not validated (see validateSnapshot).
 */
function validateEnvelope(s: WorldSnapshot): void {
  if (!isRecord(s)) throw invalid('envelope', 'an object', s)
  // O-63 (P3): a snapshot from a newer engine cannot be read; migrate older
  // ones with @domecs/persist's migrate() (SPEC §7.3).
  if (s.version !== undefined) {
    if (!isNonNegativeInt(s.version)) throw invalid('version', 'an integer >= 0', s.version)
    if (s.version > SNAPSHOT_VERSION) {
      throw new Error(
        `domecs: restore: snapshot version ${s.version} is newer than this engine supports (${SNAPSHOT_VERSION})`,
      )
    }
  }
  const seed: unknown = s.seed
  if (
    !Array.isArray(seed) ||
    seed.length !== 4 ||
    !seed.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    throw invalid('seed', 'an array of 4 finite numbers', seed)
  }
  if (!isNonNegativeInt(s.tick)) throw invalid('tick', 'an integer >= 0', s.tick)
  if (s.nextId !== undefined && !isNonNegativeInt(s.nextId)) {
    throw invalid('nextId', 'an integer >= 0', s.nextId)
  }
  if (s.resources !== undefined && !isRecord(s.resources)) {
    throw invalid('resources', 'an object', s.resources)
  }
  if (s.changes !== undefined) validateChanges(s.changes)
  const entities: unknown = s.entities
  if (!Array.isArray(entities)) throw invalid('entities', 'an array', entities)
  const seen = new Set<number>()
  entities.forEach((rec: unknown, i) => {
    if (!isRecord(rec)) throw invalid(`entities[${i}]`, 'an object', rec)
    if (!isNonNegativeInt(rec.id)) throw invalid(`entities[${i}].id`, 'an integer >= 0', rec.id)
    if (seen.has(rec.id)) throw invalid(`entities[${i}].id`, 'a unique id', rec.id)
    seen.add(rec.id)
    if (!isRecord(rec.components)) {
      throw invalid(`entities[${i}].components`, 'an object', rec.components)
    }
  })
}

const ENTITY_MARK_KINDS = new Set(['added', 'changed', 'removed'])

/** O-42: the `changes` field restore re-issues. */
function validateChanges(c: unknown): void {
  if (!isRecord(c)) throw invalid('changes', 'an object', c)
  const marks: unknown = c.marks
  if (!Array.isArray(marks)) throw invalid('changes.marks', 'an array', marks)
  marks.forEach((m: unknown, i) => {
    const ok =
      Array.isArray(m) &&
      typeof m[1] === 'string' &&
      ((m[0] === 'resource' && m.length === 2) ||
        (ENTITY_MARK_KINDS.has(m[0]) && m.length === 3 && isNonNegativeInt(m[2])))
    if (!ok) {
      throw invalid(`changes.marks[${i}]`, '[kind, name, id] or ["resource", name]', m)
    }
  })
  const seen: unknown = c.seen
  if (!isRecord(seen)) throw invalid('changes.seen', 'an object', seen)
  for (const [name, n] of Object.entries(seen)) {
    if (!isNonNegativeInt(n) || n > marks.length) {
      throw invalid(`changes.seen[${JSON.stringify(name)}]`, `an integer 0..${marks.length}`, n)
    }
  }
}

/**
 * O-40: rebuild the F-3 clock from the cumulative scaled time, using the
 * tick's own expressions (`fixedStepsDue`, the accumulator remainder), so
 * every value matches the live world bit for bit. The fixed-step count is
 * derived against this world's `fixedStep` rather than stored: a world
 * restored with a different `fixedStep` neither bursts through catch-up
 * steps nor stalls until the old count is reached. `fixedBacklog` keeps the
 * steps the live world still owed outstanding after the restore — under
 * another `fixedStep`, the time they stood for.
 */
function resumeClock(
  ctx: WorldStateCtx,
  { scaledTime, fixedBacklog, fixedStep }: SnapshotClock,
): void {
  const { clock, time } = ctx
  const quantizedMs = Math.round(scaledTime * 1000)
  // Steps the live world had run, in the step size the backlog counts in.
  const step = fixedStep ?? time.fixedStep
  const ran = Math.max(0, fixedStepsDue(scaledTime, step) - fixedBacklog)
  // Under another fixedStep, keep the fixed time those steps consumed and
  // count it in this world's steps, so the time still owed carries over
  // (within one step) rather than the number of steps.
  const fixedSteps = step === time.fixedStep ? ran : fixedStepsDue(ran * step, time.fixedStep)
  clock.totalScaledSeconds = scaledTime
  clock.lastQuantizedElapsedMs = quantizedMs
  clock.fixedStepsFired = fixedSteps
  clock.fixedStepCounter = fixedSteps
  time.elapsed = quantizedMs / 1000
  time.fixedAccumulator = scaledTime - fixedSteps * time.fixedStep
}
