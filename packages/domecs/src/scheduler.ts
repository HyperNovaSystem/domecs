import type { EventType, EventView } from './events.js'
import type { InputSnapshot } from './input.js'
import { normalize, treeHas, type EntityView, type QueryDef, type QueryNode, type QueryResult } from './query.js'
import type { Rng } from './rng.js'
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
  enabled?: () => boolean
  state?: State
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
  enabled: boolean
  state: unknown
  query?: QueryResult
  reactsTo?: QueryResult
  /** for fixed: divisor = baseHz / rateHz */
  fixedDivisor: number
  /** for once: has it already run? */
  ranOnce: boolean
  registrationIndex: number
}

export interface Scheduler {
  register(name: string, def: SystemDef, fn: System): SystemHandle
  systemsByMode(mode: SystemSchedule): CompiledSystem[]
  /** Remove a system by handle (no-op if already removed). */
  remove(s: CompiledSystem): void
  applyPendingReplacements(): void
}

function comparator(a: CompiledSystem, b: CompiledSystem): number {
  return a.priority - b.priority || a.registrationIndex - b.registrationIndex
}

export function createScheduler(
  makeQuery: (def: QueryDef) => QueryResult,
  fixedStep: number,
): Scheduler {
  const systems: CompiledSystem[] = []
  const byMode = new Map<SystemSchedule, CompiledSystem[]>([
    ['tick', []],
    ['fixed', []],
    ['event', []],
    ['once', []],
    ['reactive', []],
  ])
  let nextId = 0

  function sortMode(mode: SystemSchedule): void {
    const arr = byMode.get(mode)!
    arr.sort(comparator)
  }

  return {
    register(name, def, fn): SystemHandle {
      const schedule = def.schedule ?? 'tick'
      const priority = def.priority ?? 0

      if (def.schedule === 'reactive') {
        // defensive — unrepresentable in TS, retained for untyped JS callers
        if (!def.reactsTo) {
          throw new Error(
            `domecs: reactive system "${name}" requires a reactsTo query (SPEC §4 step 6).`,
          )
        }
        const rNode = normalize(def.reactsTo) as QueryNode
        const CHANGE_KINDS = new Set<QueryNode['kind']>([
          'added',
          'removed',
          'changed',
          'changedResource',
        ])
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

      const compiled: CompiledSystem = {
        id: nextId++,
        name,
        def,
        fn,
        schedule,
        priority,
        enabled: true,
        state: def.state,
        fixedDivisor,
        ranOnce: false,
        registrationIndex: systems.length,
      }
      if (def.query) compiled.query = makeQuery(def.query)
      if (def.schedule === 'reactive') compiled.reactsTo = makeQuery(def.reactsTo)

      systems.push(compiled)
      byMode.get(schedule)!.push(compiled)
      sortMode(schedule)

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
          const idx = systems.indexOf(compiled)
          if (idx >= 0) systems.splice(idx, 1)
          const arr = byMode.get(schedule)!
          const j = arr.indexOf(compiled)
          if (j >= 0) arr.splice(j, 1)
          compiled.query?.dispose()
          compiled.reactsTo?.dispose()
        },
        replaceFn(fn: System) {
          compiled.pendingFn = fn
        },
      }
      return handle
    },

    systemsByMode(mode): CompiledSystem[] {
      return byMode.get(mode) ?? []
    },

    remove(s): void {
      const idx = systems.indexOf(s)
      if (idx >= 0) systems.splice(idx, 1)
      const arr = byMode.get(s.schedule)!
      const j = arr.indexOf(s)
      if (j >= 0) arr.splice(j, 1)
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
