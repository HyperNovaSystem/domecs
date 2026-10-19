import type { EventType, EventView } from './events.js'
import type { InputSnapshot } from './input.js'
import { normalize, treeHas, type EntityView, type QueryDef, type QueryNode, type QueryResult } from './query.js'
import type { JsonValue } from './result.js'
import type { Rng } from './rng.js'
import { cloneSerializable } from './snapshot.js'
import type { TimeState } from './time.js'
// Type-only import breaks the scheduler<->world value cycle (TYPE_EVAL §3.1).
import type { World } from './world.js'

export type SystemSchedule = 'tick' | 'fixed' | 'event' | 'once' | 'reactive'

/**
 * Fields shared across all SystemDef variants: query, priority, enabled gate,
 * initial state, and the erased Fields phantom.
 */
interface SystemDefBase<Fields = Record<string, unknown>, State = unknown> {
  query?: QueryDef
  priority?: number
  /**
   * Secondary sort key within a priority (default 0; finite). Run order in a
   * mode is priority, then order, then registration index. Lets a library
   * place its systems deterministically regardless of when they were
   * (re)registered (SPEC §3; O-76).
   */
  order?: number
  enabled?: () => boolean
  state?: State
  /**
   * JSON-safe annotation surfaced (cloned) in `describe().systems[i].meta`
   * for tools and agents — e.g. `@domecs/rules` sets `{ rule: name }`.
   * Cloned at registration; the runtime never reads it. A value JSON cannot
   * carry (function, `undefined`, non-finite number, class instance, cycle)
   * makes `world.system()` throw `TypeError`.
   */
  meta?: JsonValue
  /**
   * Erased Fields phantom — keeps a structural slot for the inferred field
   * shape so callers can ascribe it explicitly when needed. The runtime
   * never reads this; declaring it lets `system<T>(...)` propagate Fields
   * into the system function signature.
   */
  readonly __fields?: Fields
}

/** Per-tick system (the default when `schedule` is omitted). */
export interface TickSystemDef<
  Fields = Record<string, unknown>,
  State = unknown,
> extends SystemDefBase<Fields, State> {
  schedule?: 'tick'
}

/** Fixed-rate system; `rateHz` must be a whole-number divisor of the world's base rate. */
export interface FixedSystemDef<
  Fields = Record<string, unknown>,
  State = unknown,
> extends SystemDefBase<Fields, State> {
  schedule: 'fixed'
  rateHz?: number
}

/** Event-driven system; runs when any of `triggers` fired this tick. */
export interface EventSystemDef<
  Fields = Record<string, unknown>,
  State = unknown,
> extends SystemDefBase<Fields, State> {
  schedule: 'event'
  triggers?: EventType<unknown>[]
}

/** Runs exactly once, on the first tick after registration. */
export interface OnceSystemDef<
  Fields = Record<string, unknown>,
  State = unknown,
> extends SystemDefBase<Fields, State> {
  schedule: 'once'
}

/** Reactive system; `ctx.entities` is the change-delta from `reactsTo`. */
export interface ReactiveSystemDef<
  Fields = Record<string, unknown>,
  State = unknown,
> extends SystemDefBase<Fields, State> {
  schedule: 'reactive'
  reactsTo: QueryDef
}

/**
 * Discriminated union of all system definition variants. The `schedule` field
 * acts as the discriminant; invalid field combinations (e.g. `rateHz` on a
 * `'tick'` system) are unrepresentable at compile time.
 */
export type SystemDef<Fields = Record<string, unknown>, State = unknown> =
  | TickSystemDef<Fields, State>
  | FixedSystemDef<Fields, State>
  | EventSystemDef<Fields, State>
  | OnceSystemDef<Fields, State>
  | ReactiveSystemDef<Fields, State>

export interface SystemContext<
  Fields = Record<string, unknown>,
  State = unknown,
> {
  entities: ReadonlyArray<EntityView<Fields>>
  time: Readonly<TimeState>
  input: InputSnapshot
  events: EventView
  world: World
  rand: Rng
  state: State
}

/**
 * A system returns `void` (treated as success — no `Faulted` attached) or
 * a `SystemResult` whose `errors` are appended to the targeted entities'
 * `Faulted` buffer. The declared return type is `void` (TypeScript's
 * void-return special rule lets the function return anything; the scheduler
 * shape-checks for SystemResult at runtime). Authors who want compile-time
 * validation should annotate the return type explicitly with
 * `SystemResult<E>`. See doc/BETTER_ERRORS.md.
 */
export type System<
  Fields = Record<string, unknown>,
  State = unknown,
> = (ctx: SystemContext<Fields, State>) => void

export interface SystemHandle {
  readonly name: string
  readonly schedule: SystemSchedule
  enabled: boolean
  enable(): void
  disable(): void
  remove(): void
  replaceFn?(fn: System): void
}

export interface CompiledSystem {
  id: number
  name: string
  def: SystemDef
  fn: System
  pendingFn?: System
  schedule: SystemSchedule
  priority: number
  /** Secondary sort key within a priority (default 0). */
  order: number
  /** Sorted names of the components its query / reactsTo reference (manifest). */
  components: string[]
  /** Clone of `def.meta` taken at registration (manifest). */
  meta?: JsonValue
  enabled: boolean
  state: unknown
  query?: QueryResult
  reactsTo?: QueryResult
  /** for fixed: divisor = baseHz / rateHz */
  fixedDivisor: number
  /** for once: has it already run? */
  ranOnce: boolean
  /** Monotonic tie-break for equal priorities; never reused (O-43). */
  registrationIndex: number
  /** Set by remove(); a phase already iterating skips it (O-43). */
  removed: boolean
  /**
   * O-42 change window: the change-log stamp this system has seen through.
   * A run reports marks in `(seenThrough, runStart]`; when it ends,
   * `seenThrough` moves to the stamp at that point, so the system's own
   * writes are not reported back to it.
   */
  seenThrough: number
  /** The change-log stamp when the current run started. */
  runStart: number
  /** True while the system's function is executing. */
  running: boolean
  /** Its query or reactsTo has a change-detection node (snapshot cursor). */
  watchesChanges: boolean
  /** Its query or reactsTo has an `OnRemoved` node (removal-mark pruning). */
  watchesRemoved: boolean
}

export interface Scheduler {
  register(name: string, def: SystemDef, fn: System): SystemHandle
  /**
   * The systems of one schedule in run order. The array is never mutated:
   * register/remove swap in a new one, so a phase iterating it is not
   * disturbed by systems added or removed mid-phase (O-43). Callers skip
   * entries whose `removed` flag is set.
   */
  systemsByMode(mode: SystemSchedule): readonly CompiledSystem[]
  /** Every registered system, in registration order. */
  all(): readonly CompiledSystem[]
  /** The live SystemHandle for a registered system by name, or undefined. */
  getHandle(name: string): SystemHandle | undefined
  /** Remove a system by handle (no-op if already removed). */
  remove(s: CompiledSystem): void
  applyPendingReplacements(): void
}

function comparator(a: CompiledSystem, b: CompiledSystem): number {
  return (
    a.priority - b.priority ||
    a.order - b.order ||
    a.registrationIndex - b.registrationIndex
  )
}

const CHANGE_KINDS: ReadonlySet<QueryNode['kind']> = new Set([
  'added',
  'removed',
  'changed',
  'changedResource',
])
const REMOVED_KIND: ReadonlySet<QueryNode['kind']> = new Set(['removed'])

/**
 * @param makeQuery builds a live query owned by `owner`: its change window
 *   is the system's (O-42).
 * @param initialSeen the change-log stamp a newly registered system's
 *   window starts after.
 */
export function createScheduler(
  makeQuery: (def: QueryDef, owner: CompiledSystem) => QueryResult,
  fixedStep: number,
  initialSeen: (name: string) => number,
): Scheduler {
  const systems: CompiledSystem[] = []
  // name -> live handle, so getHandle(name) hands back the SAME object whose
  // enabled/disable() drive scheduling. Last registration wins on a name clash.
  const handlesByName = new Map<string, SystemHandle>()
  const byMode = new Map<SystemSchedule, readonly CompiledSystem[]>([
    ['tick', []],
    ['fixed', []],
    ['event', []],
    ['once', []],
    ['reactive', []],
  ])
  let nextId = 0

  // Copy-on-write: a phase loop holds the array it started with, so adding
  // or removing a system mid-phase neither skips nor repeats one (O-43).
  function addToMode(s: CompiledSystem): void {
    byMode.set(s.schedule, [...byMode.get(s.schedule)!, s].sort(comparator))
  }

  function removeFromMode(s: CompiledSystem): void {
    const arr = byMode.get(s.schedule)!
    if (arr.includes(s)) byMode.set(s.schedule, arr.filter((x) => x !== s))
  }

  function drop(s: CompiledSystem): void {
    s.removed = true
    const idx = systems.indexOf(s)
    if (idx >= 0) systems.splice(idx, 1)
    removeFromMode(s)
  }

  return {
    register(name, def, fn): SystemHandle {
      const schedule = def.schedule ?? 'tick'
      const priority = def.priority ?? 0
      const order = def.order ?? 0
      if (typeof order !== 'number' || !Number.isFinite(order)) {
        throw new Error(
          `domecs: system "${name}" order=${String(order)} must be a finite number (SPEC §3 ordering: priority, then order, then registration index).`,
        )
      }

      if (def.meta !== undefined) {
        // §4.5: meta is a JSON-safe annotation for the plain-data manifest.
        // Refuse what JSON cannot carry before any state changes (like a
        // non-finite order) rather than leak a function / NaN into
        // describe() or overflow the stack cloning a cycle.
        const problem = jsonProblem(def.meta, 'meta', [])
        if (problem !== null) {
          throw new TypeError(
            `domecs: system "${name}" ${problem}; meta must be JSON-safe (null, boolean, finite number, string, array, plain object).`,
          )
        }
      }

      if (def.schedule === 'reactive') {
        // defensive — unrepresentable in TS, retained for untyped JS callers
        if (!def.reactsTo) {
          throw new Error(
            `domecs: reactive system "${name}" requires a reactsTo query (SPEC §4 step 6).`,
          )
        }
        const rNode = normalize(def.reactsTo) as QueryNode
        if (!treeHas(rNode, CHANGE_KINDS)) {
          throw new Error(
            `domecs: reactive system "${name}" reactsTo query must contain at least one change-detection node (Added/Removed/Changed/ChangedResource). ` +
              `SPEC §4 step 6: reactive fires on queries that changed in steps 3–5; a reactsTo query that contains no Added/Removed/Changed/ChangedResource leaves nothing to change.`,
          )
        }
      }

      let fixedDivisor = 1
      if (def.schedule === 'fixed') {
        const baseHz = 1 / fixedStep
        const rateHz = def.rateHz ?? baseHz
        // baseHz and rateHz may be non-integer due to float math (e.g., 1/60).
        // Use integer-scale comparison.
        const ratio = baseHz / rateHz
        const rounded = Math.round(ratio)
        if (rounded < 1 || Math.abs(ratio - rounded) > 1e-9) {
          throw new Error(
            `domecs: system "${name}" rateHz=${rateHz} is not an integer divisor of baseHz=${baseHz} (fixedStep=${fixedStep}). SPEC §3 fixed-rate rule.`,
          )
        }
        fixedDivisor = rounded
      }

      const id = nextId++
      const nodes = [def.query, def.schedule === 'reactive' ? def.reactsTo : undefined]
        .filter((d): d is QueryDef => d !== undefined)
        .map((d) => normalize(d) as QueryNode)
      const compiled: CompiledSystem = {
        id,
        name,
        def,
        fn,
        schedule,
        priority,
        order,
        components: referencedComponentNames(nodes),
        ...(def.meta !== undefined ? { meta: cloneSerializable(def.meta) } : {}),
        enabled: true,
        state: def.state,
        fixedDivisor,
        ranOnce: false,
        registrationIndex: id,
        removed: false,
        seenThrough: initialSeen(name),
        runStart: 0,
        running: false,
        watchesChanges: nodes.some((n) => treeHas(n, CHANGE_KINDS)),
        watchesRemoved: nodes.some((n) => treeHas(n, REMOVED_KIND)),
      }
      if (def.query) compiled.query = makeQuery(def.query, compiled)
      if (def.schedule === 'reactive') compiled.reactsTo = makeQuery(def.reactsTo, compiled)

      systems.push(compiled)
      addToMode(compiled)

      const handle: SystemHandle = {
        name,
        schedule,
        get enabled() {
          return compiled.enabled
        },
        set enabled(v: boolean) {
          compiled.enabled = v
        },
        enable() {
          compiled.enabled = true
        },
        disable() {
          compiled.enabled = false
        },
        remove() {
          drop(compiled)
          // Only drop the name mapping if it still points at THIS handle — a
          // later registration under the same name must not be evicted.
          if (handlesByName.get(name) === handle) handlesByName.delete(name)
          compiled.query?.dispose()
          compiled.reactsTo?.dispose()
        },
        replaceFn(fn: System) {
          compiled.pendingFn = fn
        },
      }
      handlesByName.set(name, handle)
      return handle
    },

    systemsByMode(mode): readonly CompiledSystem[] {
      return byMode.get(mode) ?? []
    },

    all(): readonly CompiledSystem[] {
      return systems
    },

    getHandle(name): SystemHandle | undefined {
      return handlesByName.get(name)
    },

    remove(s): void {
      drop(s)
    },

    applyPendingReplacements(): void {
      for (const s of systems) {
        if (!s.pendingFn) continue
        s.fn = s.pendingFn
        delete s.pendingFn
      }
    },
  }
}

/**
 * Sorted, de-duplicated names of every component a query tree references —
 * `Has`, `Where`, `OnAdded`, `OnRemoved`, `OnChanged` leaves, `Not` branches
 * included (a `Not(Dead)` system still depends on `Dead`). Resource leaves
 * are not components and are skipped. For `describe().systems` (§4.5).
 */
function referencedComponentNames(nodes: readonly QueryNode[]): string[] {
  const out = new Set<string>()
  const walk = (n: QueryNode): void => {
    if (n.kind === 'and' || n.kind === 'or') n.children.forEach(walk)
    else if (n.kind === 'not') walk(n.child)
    else if (n.kind !== 'changedResource') out.add(n.type.name)
  }
  nodes.forEach(walk)
  return Array.from(out).sort()
}

/**
 * `null` when `value` is a JSON value (null, boolean, finite number, string,
 * dense array, plain or null-prototype object, acyclic), otherwise a short
 * description of the first offending location (`path`). `ancestors` holds the
 * containers on the current branch, so a shared but acyclic reference passes.
 */
function jsonProblem(value: unknown, path: string, ancestors: object[]): string | null {
  if (value === null) return null
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return null
    case 'number':
      return Number.isFinite(value) ? null : `${path} is ${String(value)}`
    case 'object':
      break
    case 'undefined':
      return `${path} is undefined`
    default:
      return `${path} is a ${typeof value}`
  }
  const obj = value as object
  if (ancestors.includes(obj)) return `${path} is a cyclic reference`
  ancestors.push(obj)
  try {
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const at = `${path}[${i}]`
        if (!(i in obj)) return `${at} is a hole`
        const p = jsonProblem(obj[i], at, ancestors)
        if (p !== null) return p
      }
      return null
    }
    const proto = Object.getPrototypeOf(obj)
    if (proto !== Object.prototype && proto !== null) {
      return `${path} is not a plain object`
    }
    for (const key of Object.keys(obj)) {
      const p = jsonProblem((obj as Record<string, unknown>)[key], `${path}.${key}`, ancestors)
      if (p !== null) return p
    }
    return null
  } finally {
    ancestors.pop()
  }
}
