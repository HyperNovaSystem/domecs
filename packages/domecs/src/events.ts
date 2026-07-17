import type { ComponentSchema, FieldSchema } from './types.js'

/**
 * Per-event nominal-identity tag. Stored on every `EventType` returned by
 * `defineEvent`; the bus keys all internal maps on this symbol so distinct
 * `defineEvent('Same')` calls never collide. F-8.
 */
export const eventTag: unique symbol = Symbol('domecs.eventTag')

export interface EventType<T> {
  readonly name: string
  readonly [eventTag]: symbol
  readonly __t?: T
}

/** Options for {@link defineEvent}. */
export interface EventDefOptions {
  /**
   * Optional payload field-schema for reflection, reusing the component
   * {@link ComponentSchema} vocabulary so tooling renders an event payload the
   * same way it renders a component.
   */
  readonly schema?: ComponentSchema
}

/** Internal view of an {@link EventType} carrying its optional payload schema. */
export interface InternalEventType<T> extends EventType<T> {
  readonly __schema?: ComponentSchema
}

export function defineEvent<T>(name: string, options?: EventDefOptions): EventType<T> {
  return {
    name,
    [eventTag]: Symbol(name),
    ...(options?.schema ? { __schema: options.schema } : {}),
  } as InternalEventType<T>
}

export function internalEvent<T>(type: EventType<T>): InternalEventType<T> {
  return type as InternalEventType<T>
}

/**
 * Result of `world.describeEvent(type)`. `fields` is the declared
 * `schema.fields` when present (`fieldsSource: 'schema'`), otherwise empty
 * (`fieldsSource: 'none'`). Events have no defaults to infer from, so unlike
 * {@link ComponentDescriptor} there is no `'defaults'` source.
 */
export interface EventDescriptor {
  readonly name: string
  readonly fields: Readonly<Record<string, FieldSchema>>
  readonly fieldsSource: 'schema' | 'none'
}

export interface EventView {
  of<T>(type: EventType<T>): readonly T[]
  emit<T>(type: EventType<T>, payload: T): void
}

/** A single buffered emission, paired with its originating `EventType`. */
export interface EmittedEvent {
  readonly type: EventType<unknown>
  readonly payload: unknown
}

export interface EventBus {
  /** Enqueue for delivery at step 1 of next tick. */
  emit<T>(type: EventType<T>, payload: T): void
  /** Subscribe directly; fn fires at flush time for events of that type. */
  on<T>(type: EventType<T>, fn: (e: T) => void): () => void
  /** Swap pending -> current, returning the view for event systems this tick. */
  flush(): EventView
  /** Current view (for inspection). */
  view(): EventView
  /** Whether any events are queued for the next tick. */
  hasPending(): boolean
  /**
   * Snapshot the currently-pending emissions as `{ type, payload }` pairs in
   * deterministic order: by first-emit of each type, then payload order within
   * a type. Used by `world.action` to report the events a command produced
   * during its tick (which are buffered for next tick at the time of reading).
   */
  pendingEvents(): EmittedEvent[]
  /**
   * Every event type this bus has observed — emitted or subscribed to — in
   * first-seen order. Powers `world.describe().events`. Note: an event type
   * defined but never used in this world is unknowable and will not appear.
   */
  knownTypes(): EventType<unknown>[]
  /**
   * Drop all pending (undelivered) events. Called by `world.restore()`:
   * events queued before a restore belong to the abandoned timeline and
   * must not fire into the first tick after it (SPEC §7.1). The current
   * (already-flushed) view is left alone — it is replaced wholesale at the
   * next flush.
   */
  clear(): void
}

/**
 * Optional sink invoked when a direct `on()` subscriber throws during
 * `flush()`. The bus catches the throw, reports `(eventName, cause)` here,
 * and continues delivering the remaining subscribers/events. The world wires
 * this to build an `event_handler_threw` fault and route it to
 * `signals.faultRaised`; the bus itself stays decoupled from fault plumbing.
 */
export type HandlerFaultSink = (eventName: string, cause: unknown) => void

export function createEventBus(onHandlerFault?: HandlerFaultSink): EventBus {
  // Keyed by the per-type `eventTag` symbol — identity-based, not name-based.
  let pending = new Map<symbol, unknown[]>()
  let current = new Map<symbol, unknown[]>()
  const subs = new Map<symbol, Set<(e: unknown) => void>>()
  // Reverse map tag -> EventType so pendingEvents can reconstruct typed pairs;
  // the pending/current maps only carry the symbol. Populated on first emit of
  // each type and never cleared (bounded by the number of distinct types).
  const typeByTag = new Map<symbol, EventType<unknown>>()

  const makeView = (src: Map<symbol, unknown[]>): EventView => ({
    of<T>(type: EventType<T>): readonly T[] {
      const arr = src.get(type[eventTag])
      return (arr ?? []) as readonly T[]
    },
    emit<T>(type: EventType<T>, payload: T): void {
      const key = type[eventTag]
      if (!typeByTag.has(key)) typeByTag.set(key, type as EventType<unknown>)
      let a = pending.get(key)
      if (!a) {
        a = []
        pending.set(key, a)
      }
      a.push(payload)
    },
  })

  return {
    emit<T>(type: EventType<T>, payload: T): void {
      const key = type[eventTag]
      if (!typeByTag.has(key)) typeByTag.set(key, type as EventType<unknown>)
      let a = pending.get(key)
      if (!a) {
        a = []
        pending.set(key, a)
      }
      a.push(payload)
    },
    on<T>(type: EventType<T>, fn: (e: T) => void): () => void {
      const key = type[eventTag]
      if (!typeByTag.has(key)) typeByTag.set(key, type as EventType<unknown>)
      let s = subs.get(key)
      if (!s) {
        s = new Set()
        subs.set(key, s)
      }
      s.add(fn as (e: unknown) => void)
      return () => s!.delete(fn as (e: unknown) => void)
    },
    flush(): EventView {
      // promote pending -> current, reset pending
      current = pending
      pending = new Map()
      // deliver to direct subscribers synchronously at flush
      for (const [key, arr] of current) {
        const s = subs.get(key)
        if (!s || s.size === 0) continue
        for (const payload of arr) {
          for (const fn of s) {
            // Quarantine a throwing subscriber as a fault (via the sink) so one
            // bad handler cannot starve the remaining subscribers/events. The
            // throw must not escape flush() -> step(). The event name is
            // recovered from typeByTag for the fault's `event` field.
            try {
              fn(payload)
            } catch (cause) {
              if (onHandlerFault) {
                onHandlerFault(typeByTag.get(key)?.name ?? '<unknown>', cause)
              }
            }
          }
        }
      }
      return makeView(current)
    },
    view(): EventView {
      return makeView(current)
    },
    hasPending(): boolean {
      return pending.size > 0
    },
    pendingEvents(): EmittedEvent[] {
      const out: EmittedEvent[] = []
      for (const [key, arr] of pending) {
        const type = typeByTag.get(key)
        if (!type) continue
        for (const payload of arr) out.push({ type, payload })
      }
      return out
    },
    knownTypes(): EventType<unknown>[] {
      return Array.from(typeByTag.values())
    },
    clear(): void {
      pending = new Map()
    },
  }
}
