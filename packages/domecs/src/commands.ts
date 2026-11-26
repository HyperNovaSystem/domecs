/**
 * Commands (H-5, P-1): an event with a handler whose verdict is the
 * command's. `world.action(Command, payload)` / `bridge.act('Name', …)` return
 * what the handler said, instead of `accepted: true` unless the caller
 * passed a resolver.
 */
import { defineEvent, isEventType, type EventType, type EventView } from './events.js'
import type { InputSnapshot } from './input.js'
import type { Rng } from './rng.js'
import type { TimeState } from './time.js'
import type { ComponentSchema } from './types.js'
// Type-only: breaks the commands <-> world value cycle.
import type { World } from './world.js'

/** Registered symbol: a command made by a second copy of `@domecs/core` is still one. */
export const commandTag: unique symbol = Symbol.for('domecs.commandTag')

/**
 * A command handler's answer: done, or refused with a reason for the caller
 * (shown to a player, read by an agent). Make one with {@link accept} or
 * {@link refuse}.
 */
export type CommandVerdict =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: string }

const ACCEPTED: CommandVerdict = Object.freeze({ accepted: true })

/** The command was carried out. A handler that returns nothing accepts too. */
export function accept(): CommandVerdict {
  return ACCEPTED
}

/** The command was not carried out, and why. `reason` must be a non-empty string. */
export function refuse(reason: string): CommandVerdict {
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new TypeError(`domecs: refuse(reason) needs a non-empty string reason; got ${JSON.stringify(reason)}`)
  }
  return Object.freeze({ accepted: false, reason })
}

/** What a command handler sees: a system's context without `entities` or `state`. */
export interface CommandContext {
  readonly time: Readonly<TimeState>
  readonly input: InputSnapshot
  /** The delivery the command came in; `emit` queues events, as from a system. */
  readonly events: EventView
  readonly world: World
  readonly rand: Rng
}

/** Options for {@link defineCommand}. */
export interface CommandDef<T> {
  /** What the command does, for humans and agents (`describe().events`). */
  readonly description?: string
  /**
   * Payload schema, enforced by `world.action()` before any tick (O-39, H-6):
   * mark the fields the handler needs `required`, ids `kind: 'entity'`.
   */
  readonly schema?: ComponentSchema
  /**
   * Carry out one command. Runs once per command, in emit order, in the
   * event phase (or, with `fixed`, in the next fixed step). Return
   * {@link refuse} to refuse it, {@link accept} or nothing to accept it. A
   * handler that throws refuses that command and raises an
   * `event_handler_threw` fault; the other commands are still handled.
   * Deterministic, like a system: AGENTS.md rule 9.
   */
  readonly handle: (ctx: CommandContext, payload: T) => CommandVerdict | void
  /**
   * Handle the command in the fixed schedule (H-17): in the next fixed step,
   * with the step's clock. For commands to a fixed-step simulation.
   * `world.action()` then needs a tick that runs a fixed step (`{ dt }`);
   * after one that runs none the command stays queued and the result says
   * so. Default `false`.
   */
  readonly fixed?: boolean
  /** The handler system's priority (default -100, the commands band of SPEC §3). */
  readonly priority?: number
  /** Which stream `ctx.rand` is: the shared one (default) or the handler's own (§4.4). */
  readonly rng?: 'shared' | 'own'
}

/** An event type made by {@link defineCommand}: `world.register` it to install its handler. */
export interface CommandType<T> extends EventType<T> {
  readonly [commandTag]: CommandDef<T>
}

/**
 * Define a command: an event type (`name`, `schema`, `description` as
 * `defineEvent`) with the handler that carries it out. `world.register(Cmd)`
 * installs the handler in a world, once, as the event system
 * `command:<name>`; `world.action(Cmd, payload)` then returns its verdict.
 * Other event systems may listen to a command too, but see it whatever the
 * verdict: react to the events the handler emits instead.
 */
export function defineCommand<T>(name: string, def: CommandDef<T>): CommandType<T> {
  if (def === null || typeof def !== 'object' || typeof def.handle !== 'function') {
    throw new TypeError(`domecs: defineCommand("${name}") needs a handle(ctx, payload) function`)
  }
  if (def.fixed !== undefined && typeof def.fixed !== 'boolean') {
    throw new TypeError(`domecs: defineCommand("${name}") fixed must be a boolean; got ${JSON.stringify(def.fixed)}`)
  }
  if (def.priority !== undefined && !(typeof def.priority === 'number' && Number.isFinite(def.priority))) {
    throw new TypeError(`domecs: defineCommand("${name}") priority must be a finite number; got ${String(def.priority)}`)
  }
  if (def.rng !== undefined && def.rng !== 'shared' && def.rng !== 'own') {
    throw new TypeError(`domecs: defineCommand("${name}") rng must be 'shared' or 'own'; got ${JSON.stringify(def.rng)}`)
  }
  const type = defineEvent<T>(name, {
    ...(def.schema !== undefined ? { schema: def.schema } : {}),
    ...(def.description !== undefined ? { description: def.description } : {}),
  })
  Object.defineProperty(type, commandTag, { value: Object.freeze({ ...def }), enumerable: false })
  return type as CommandType<T>
}

/** Whether `value` is a command type ({@link defineCommand}). */
export function isCommandType(value: unknown): value is CommandType<unknown> {
  return isEventType(value) && typeof (value as Partial<CommandType<unknown>>)[commandTag]?.handle === 'function'
}
