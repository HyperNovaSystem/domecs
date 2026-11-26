import type { ComponentSchema, ComponentType, Entity, FieldSchema } from './types.js'

/**
 * Per-event nominal-identity tag. Stored on every `EventType` returned by
 * `defineEvent`; the bus keys all internal maps on the per-event symbol
 * stored under it, so distinct `defineEvent('Same')` calls never collide.
 * F-8.
 *
 * The tag key itself is a registered symbol, so a token made by a second
 * copy of `@domecs/core` (a duplicate install, a bundled dependency) is
 * still read correctly here. Per-event identity is unchanged: each
 * `defineEvent` call still mints its own unregistered `Symbol(name)`.
 */
export const eventTag: unique symbol = Symbol.for('domecs.eventTag')

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

/**
 * The payload schema `defineEvent` was given, or `undefined` — the same
 * fields `world.describeEvent(type)` reports, without a world (for rule
 * compilers and other tools that check payloads ahead of time).
 */
export function eventSchema(type: EventType<unknown>): ComponentSchema | undefined {
  return internalEvent(type).__schema
}

const hasOwn = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key)

/**
 * What {@link validateEventPayload} needs of a world to check `entity`
 * fields: a `World` is one.
 */
export interface PayloadWorld {
  isAlive(entity: Entity): boolean
  has(entity: Entity, type: ComponentType<unknown>): boolean
  lookupComponent(name: string): ComponentType<unknown> | undefined
}

/** Options for {@link validateEventPayload}. */
export interface PayloadCheckOptions {
  /**
   * Check `entity` fields against this world: the id must be alive and
   * hold every `with` component. Without it only their shape is checked.
   * `world.action()` always passes its world.
   */
  readonly world?: PayloadWorld
  /**
   * Check only the fields present: `required` is not enforced. For tools
   * that build a payload a field at a time (`@domecs/rules` emit effects).
   */
  readonly partial?: boolean
}

/**
 * O-39, H-6: payload validation against an event's declared schema, used by
 * `world.action()` / `bridge.act()` so the typed command boundary rejects
 * malformed commands before any tick instead of accepting them as no-ops.
 * Only applies when the event was defined with `{ schema }` — schema-less
 * events stay unvalidated (always `null`).
 *
 * Public so hosts (editors, agent harnesses) can pre-validate a payload with
 * exactly the check `action()` applies, without emitting or stepping. For a
 * rejected payload, `action()` reports
 * `invalid payload for "<event name>": <this fragment>`.
 *
 * Rules:
 * - payload must be a non-null, non-array object
 * - own keys not declared in the schema are rejected (catches typo'd
 *   fields; names inherited from `Object.prototype` count as undeclared)
 * - a `required` field must be present (not `undefined`), unless
 *   `options.partial`; other declared fields may be left out
 * - present fields must match their `kind`: `number` a finite number, within
 *   `min` / `max` (inclusive) and an integer when `integer`; `enum` a member
 *   of `options`; `entity` an integer >= 0 and, given `options.world`, a
 *   live entity holding every `with` component; `unknown` accepts anything
 *
 * @returns `null` when valid, else a human-readable reason fragment.
 */
export function validateEventPayload(
  type: EventType<unknown>,
  payload: unknown,
  options: PayloadCheckOptions = {},
): string | null {
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
    // Never read a declared name through the prototype chain.
    const v = hasOwn(payload, key) ? (payload as Record<string, unknown>)[key] : undefined
    if (v === undefined) {
      if (spec.required === true && options.partial !== true) return `missing required field "${key}"`
      continue
    }
    const problem = fieldProblem(key, spec, v, options.world)
    if (problem !== null) return problem
  }
  return null
}

function fieldProblem(key: string, spec: FieldSchema, v: unknown, world: PayloadWorld | undefined): string | null {
  switch (spec.kind) {
    case 'number':
      if (typeof v !== 'number') return `field "${key}" must be a number, got ${typeof v}`
      if (!Number.isFinite(v)) return `field "${key}" must be a finite number, got ${String(v)}`
      if (spec.integer === true && !Number.isInteger(v)) return `field "${key}" must be an integer, got ${v}`
      if (spec.min !== undefined && v < spec.min) return `field "${key}" must be >= ${spec.min}, got ${v}`
      if (spec.max !== undefined && v > spec.max) return `field "${key}" must be <= ${spec.max}, got ${v}`
      return null
    case 'string':
    case 'boolean':
      return typeof v === spec.kind ? null : `field "${key}" must be a ${spec.kind}, got ${typeof v}`
    case 'enum':
      return spec.options?.includes(v as string | number)
        ? null
        : `field "${key}" must be one of ${JSON.stringify(spec.options ?? [])}`
    case 'object':
      return v === null || typeof v !== 'object' ? `field "${key}" must be an object` : null
    case 'entity': {
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
        return `field "${key}" must be an entity id (an integer >= 0), got ${typeof v === 'number' ? String(v) : typeof v}`
      }
      if (world === undefined) return null
      if (!world.isAlive(v)) return `field "${key}" must name a live entity; entity ${v} is not alive`
      for (const name of spec.with ?? []) {
        const component = world.lookupComponent(name)
        if (component === undefined || !world.has(v, component)) {
          return `field "${key}" must name an entity with ${name}; entity ${v} has no ${name}`
        }
      }
      return null
    }
    case 'unknown':
      return null
  }
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
  /**
   * A command (`defineCommand`, P-1): something to ask the world to do,
   * whose handler's verdict `action()` returns — as against a notification
   * of something that happened. Absent for plain events.
   */
  readonly command?: true
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
  /** How many events of `type` are queued for the next tick, and for the next fixed step (P-1). */
  pendingCount(type: EventType<unknown>): { readonly tick: number; readonly fixed: number }
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
   * H-17: collect every emit for the fixed sub-steps too, or (`false`) stop
   * and drop what is collected. The world turns it on while a fixed event
   * system is registered.
   */
  collectFixed(on: boolean): void
  /**
   * The events emitted since the last call — a fixed sub-step's delivery —
   * and start collecting the next one. Empty when not collecting.
   */
  takeFixed(): EventView
  /** The collected, not yet delivered fixed events, as {@link pendingEvents}. */
  pendingFixedEvents(): EmittedEvent[]
  /** Queue `events` ahead of the collected fixed events, in their order (restore). */
  prependFixed(events: readonly EmittedEvent[]): void
  /**
   * Set all pending (undelivered) events aside — the next tick's and the
   * fixed sub-steps' — and start empty queues, returning the set-aside
   * events. Called by `world.restore()`: events queued before a restore
   * belong to the abandoned timeline and must not fire into the first tick
   * after it (SPEC §7.1). The current (already-flushed) view is left alone —
   * it is replaced wholesale at the next flush.
   */
  takePending(): PendingEvents
  /**
   * Empty the current (already-flushed) view. Called by a successful
   * `world.restore()`: the view holds what the abandoned timeline delivered
   * and no snapshot carries it, so a restored world reads the same (empty)
   * view as a fresh world restored from the same snapshot (§6.3, O-88:
   * `world.events` and `runSystems`' `ctx.events` before the next flush).
   */
  clearCurrent(): void
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
export interface PendingEvents {
  readonly tick: Map<symbol, unknown[]>
  readonly fixed: Map<symbol, unknown[]>
}

/**
 * Optional sink invoked when a direct `on()` subscriber throws during
 * `flush()`. The bus catches the throw, reports `(eventName, cause)` here,
 * and continues delivering the remaining subscribers/events. The world wires
 * this to build an `event_handler_threw` fault and route it to
 * `signals.faultRaised`; the bus itself stays decoupled from fault plumbing.
 */
export type HandlerFaultSink = (eventName: string, cause: unknown) => void

/**
 * Optional observer of every emit (`bus.emit` and a view's `emit`), called
 * after the event is queued. Not called for events re-queued by
 * {@link EventBus.prependPending}. The world uses it for the act-log tap
 * (§7.1).
 */
export type EmitObserver = (type: EventType<unknown>, payload: unknown) => void

export function createEventBus(onHandlerFault?: HandlerFaultSink, onEmit?: EmitObserver): EventBus {
  // Keyed by the per-type `eventTag` symbol — identity-based, not name-based.
  let pending = new Map<symbol, unknown[]>()
  let current = new Map<symbol, unknown[]>()
  // H-17: the same emits again, for the next fixed sub-step's delivery.
  let collecting = false
  let fixedInbox = new Map<symbol, unknown[]>()
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

  function push(into: Map<symbol, unknown[]>, key: symbol, payload: unknown): void {
    let a = into.get(key)
    if (!a) {
      a = []
      into.set(key, a)
    }
    a.push(payload)
  }

  /** Append `payload` to the pending queue for `type`, and to the fixed inbox while collecting. */
  function enqueue(type: EventType<unknown>, payload: unknown): void {
    const key = type[eventTag]
    know(type)
    push(pending, key, payload)
    if (collecting) push(fixedInbox, key, payload)
  }

  function listed(from: Map<symbol, unknown[]>): EmittedEvent[] {
    const out: EmittedEvent[] = []
    for (const [key, arr] of from) {
      const type = typeByTag.get(key)
      if (!type) continue
      for (const payload of arr) out.push({ type, payload })
    }
    return out
  }

  /** `events` first, then what `after` held, per type. */
  function ahead(events: readonly EmittedEvent[], after: Map<symbol, unknown[]>): Map<symbol, unknown[]> {
    const out = new Map<symbol, unknown[]>()
    for (const { type, payload } of events) {
      know(type)
      push(out, type[eventTag], payload)
    }
    for (const [key, arr] of after) {
      const a = out.get(key)
      if (a) a.push(...arr)
      else out.set(key, arr)
    }
    return out
  }

  const makeView = (src: Map<symbol, unknown[]>): EventView => ({
    of<T>(type: EventType<T>): readonly T[] {
      const arr = src.get(type[eventTag])
      return (arr ?? []) as readonly T[]
    },
    emit<T>(type: EventType<T>, payload: T): void {
      enqueue(type as EventType<unknown>, payload)
      onEmit?.(type as EventType<unknown>, payload)
    },
  })

  return {
    emit<T>(type: EventType<T>, payload: T): void {
      enqueue(type as EventType<unknown>, payload)
      onEmit?.(type as EventType<unknown>, payload)
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
    pendingCount(type: EventType<unknown>): { tick: number; fixed: number } {
      const key = type[eventTag]
      return { tick: pending.get(key)?.length ?? 0, fixed: fixedInbox.get(key)?.length ?? 0 }
    },
    pendingEvents(): EmittedEvent[] {
      return listed(pending)
    },
    collectFixed(on: boolean): void {
      collecting = on
      if (!on) fixedInbox = new Map()
    },
    takeFixed(): EventView {
      const delivered = fixedInbox
      fixedInbox = new Map()
      return makeView(delivered)
    },
    pendingFixedEvents(): EmittedEvent[] {
      return listed(fixedInbox)
    },
    prependFixed(events: readonly EmittedEvent[]): void {
      if (collecting) fixedInbox = ahead(events, fixedInbox)
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
      const taken = { tick: pending, fixed: fixedInbox }
      pending = new Map()
      fixedInbox = new Map()
      return taken
    },
    clearCurrent(): void {
      current = new Map()
    },
    putBackPending(taken: PendingEvents): void {
      pending = taken.tick
      fixedInbox = collecting ? taken.fixed : new Map()
    },
    prependPending(events: readonly EmittedEvent[]): void {
      // The tick queue only: restore puts the fixed inbox back with prependFixed.
      pending = ahead(events, pending)
    },
  }
}
