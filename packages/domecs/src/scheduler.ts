import type { EventType, EventView } from './events.js'
import type { InputSnapshot } from './input.js'
import { normalize, treeHas, type QueryDef, type QueryNode, type QueryResult } from './query.js'
import type { Rng } from './rng.js'
import type { TimeState } from './time.js'

export type SystemSchedule = 'tick' | 'fixed' | 'event' | 'once' | 'reactive'

export interface SystemDef {
  query?: QueryDef
  schedule?: SystemSchedule
  priority?: number
  rateHz?: number
  triggers?: EventType<unknown>[]
  reactsTo?: QueryDef
  enabled?: () => boolean
  state?: unknown
}

export interface SystemContext {
  entities: ReadonlyArray<unknown>
  time: Readonly<TimeState>
  input: InputSnapshot
  events: EventView
  world: unknown
  rand: Rng
  state: unknown
}

export type System = (ctx: SystemContext) => void

export interface SystemHandle {
  readonly name: string
  readonly schedule: SystemSchedule
  enabled: boolean
  enable(): void
  disable(): void
  remove(): void
}

export interface CompiledSystem {
  id: number
  name: string
  def: SystemDef
  fn: System
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

      if (schedule === 'reactive') {
        if (!def.reactsTo) {
          throw new Error(
            `domecs: reactive system "${name}" requires a reactsTo query (SPEC §4 step 6).`,
          )
        }
        const rNode = normalize(def.reactsTo) as QueryNode
        const CHANGE_KINDS = new Set<QueryNode['kind']>(['added', 'removed', 'changed'])
        if (!treeHas(rNode, CHANGE_KINDS)) {
          throw new Error(
            `domecs: reactive system "${name}" reactsTo query must contain at least one change-detection node (Added/Removed/Changed). ` +
              `SPEC §4 step 6: reactive fires on queries that changed in steps 3–5; a reactsTo query that contains no Added/Removed/Changed leaves nothing to change.`,
          )
        }
      }

      let fixedDivisor = 1
      if (schedule === 'fixed') {
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
      if (def.reactsTo) compiled.reactsTo = makeQuery(def.reactsTo)

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
  }
}
