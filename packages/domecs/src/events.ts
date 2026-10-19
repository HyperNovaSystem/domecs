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
  /**
   * Free-text meaning of the event (what the command does, when it is
   * emitted) for humans and agents. Surfaced by `describeEvent` and
   * `describe().events`; reflection only.
   */
  readonly description?: string
}

/** Internal view of an {@link EventType} carrying its optional payload schema. */
export interface InternalEventType<T> extends EventType<T> {
  readonly __schema?: ComponentSchema
  readonly __description?: string
}

export function defineEvent<T>(name: string, options?: EventDefOptions): EventType<T> {
  return {
    name,
    [eventTag]: Symbol(name),
    ...(options?.schema ? { __schema: options.schema } : {}),
    ...(options?.description !== undefined ? { __description: options.description } : {}),
  } as InternalEventType<T>
}

/** Whether `value` is an {@link EventType} (carries the `eventTag` brand). */
export function isEventType(value: unknown): value is EventType<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Partial<EventType<unknown>>)[eventTag] === 'symbol'
  )
}

export function internalEvent<T>(type: EventType<T>): InternalEventType<T> {
  return type as InternalEventType<T>
}

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key)

/**
 * O-39: shallow payload validation against an event's declared schema, used
 * by `world.action()` / `bridge.act()` so the typed command boundary rejects
 * malformed commands instead of accepting them as no-ops. Only applies when
 * the event was defined with `{ schema }` — schema-less events stay
 * unvalidated (always `null`).
 *
 * Public so hosts (editors, agent harnesses) can pre-validate a payload with
 * exactly the check `action()` applies, without emitting or stepping. For a
 * rejected payload, `action()` reports
 * `invalid payload for "<event name>": <this fragment>`.
 *
 * Rules (FieldSchema carries no required-marker, so absence is optional):
 * - payload must be a non-null, non-array object
 * - own keys not declared in the schema are rejected (catches typo'd
 *   fields; names inherited from `Object.prototype` count as undeclared)
 * - declared keys, when present, must match their `kind` (`enum` must be a
 *   member of `options`); `unknown` accepts anything
 *
 * @returns `null` when valid, else a human-readable reason fragment.
 */
export function validateEventPayload(type: EventType<unknown>, payload: unknown): string | null {
  const schema = internalEvent(type).__schema
  if (!schema) return null
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'expected an object payload'
  }
  const fields = schema.fields
  for (const key of Object.keys(payload)) {
    // Own keys only: `key in fields` would treat `toString`, `constructor`,
    // `__proto__` (inherited from Object.prototype) as declared.
    if (!hasOwn(fields, key)) {
      const declared = Object.keys(fields).join(', ') || '(none)'
      return `unknown field "${key}" — declared fields: ${declared}`
    }
  }
  for (const [key, spec] of Object.entries(fields)) {
    // Absent ⇒ optional; never read a declared name through the prototype chain.
    const v = hasOwn(payload, key) ? (payload as Record<string, unknown>)[key] : undefined
    if (v === undefined) continue
    switch (spec.kind) {
      case 'number':
      case 'string':
      case 'boolean':
        if (typeof v !== spec.kind) return `field "${key}" must be a ${spec.kind}, got ${typeof v}`
        break
      case 'enum':
        if (!spec.options?.includes(v as string | number)) {
          return `field "${key}" must be one of ${JSON.stringify(spec.options ?? [])}`
        }
        break
      case 'object':
        if (v === null || typeof v !== 'object') return `field "${key}" must be an object`
        break
      case 'unknown':
        break
    }
  }
  return null
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
  /** The `description` given to `defineEvent`; absent when none was. */
  readonly description?: string
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
   * Every event type this bus has observed — emitted, subscribed to, or
   * {@link note}d — in first-seen order. Powers `world.describe().events`.
   * Note: an event type defined but never used in this world is unknowable
   * and will not appear.
   */
  knownTypes(): EventType<unknown>[]
  /** Record `type` as known without emitting or subscribing (O-51). */
  note(type: EventType<unknown>): void
  /**
   * The known event type named `name`, or `undefined` when none is known or
   * when two distinct known types share the name (§4.5).
   */
  lookup(name: string): EventType<unknown> | undefined
  /** Whether a known event type other than `type` already holds `type.name`. */
  nameTakenByOther(type: EventType<unknown>): boolean
  /**
   * Set all pending (undelivered) events aside and start an empty queue,
   * returning the set-aside events. Called by `world.restore()`: events
   * queued before a restore belong to the abandoned timeline and must not
   * fire into the first tick after it (SPEC §7.1). The current
   * (already-flushed) view is left alone — it is replaced wholesale at the
   * next flush.
   */
  takePending(): PendingEvents
  /**
   * Make `taken` the pending queue again, dropping anything emitted since
   * {@link takePending}. `world.restore()` calls it when the restore throws,
   * so a failed restore leaves the pending events as they were.
   */
  putBackPending(taken: PendingEvents): void
  /**
   * Queue `events` ahead of whatever is pending, in their order (§4.7):
   * `world.restore()` replaces the restoring world's queue with a snapshot's
   * `pendingEvents`, keeping after them anything an `onRestore` hook emitted.
   */
  prependPending(events: readonly EmittedEvent[]): void
}

/** Pending events set aside by {@link EventBus.takePending}; opaque to callers. */
export type PendingEvents = Map<symbol, unknown[]>

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
  // Name index over typeByTag (§4.5): the type known under each name, or
  // `null` once two distinct types share it (F-8 lets them coexist; the name
  // is then ambiguous). Like typeByTag, never cleared.
  const byName = new Map<string, EventType<unknown> | null>()

  /** Record `type` as known (first-seen order) and index its name. */
  function know(type: EventType<unknown>): void {
    const key = type[eventTag]
    if (typeByTag.has(key)) return
    typeByTag.set(key, type)
    byName.set(type.name, byName.has(type.name) ? null : type)
  }

  /** Append `payload` to the pending queue for `type`. */
  function enqueue(type: EventType<unknown>, payload: unknown): void {
    const key = type[eventTag]
    know(type)
    let a = pending.get(key)
    if (!a) {
      a = []
      pending.set(key, a)
    }
    a.push(payload)
  }

  const makeView = (src: Map<symbol, unknown[]>): EventView => ({
    of<T>(type: EventType<T>): readonly T[] {
      const arr = src.get(type[eventTag])
      return (arr ?? []) as readonly T[]
    },
    emit<T>(type: EventType<T>, payload: T): void {
      enqueue(type as EventType<unknown>, payload)
    },
  })

  return {
    emit<T>(type: EventType<T>, payload: T): void {
      enqueue(type as EventType<unknown>, payload)
    },
    on<T>(type: EventType<T>, fn: (e: T) => void): () => void {
      const key = type[eventTag]
      know(type as EventType<unknown>)
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
    note(type: EventType<unknown>): void {
      know(type)
    },
    lookup(name: string): EventType<unknown> | undefined {
      return byName.get(name) ?? undefined
    },
    nameTakenByOther(type: EventType<unknown>): boolean {
      const held = byName.get(type.name)
      return held !== undefined && held !== type
    },
    takePending(): PendingEvents {
      const taken = pending
      pending = new Map()
      return taken
    },
    putBackPending(taken: PendingEvents): void {
      pending = taken
    },
    prependPending(events: readonly EmittedEvent[]): void {
      const after = pending
      pending = new Map()
      for (const { type, payload } of events) enqueue(type, payload)
      for (const [key, arr] of after) {
        const a = pending.get(key)
        if (a) a.push(...arr)
        else pending.set(key, arr)
      }
    },
  }
}
