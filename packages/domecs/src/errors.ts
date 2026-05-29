/**
 * Closed core error union, plugin error namespacing, and the system fault
 * contract returned by user systems. Discipline lives in doc/BETTER_ERRORS.md.
 */
import type { Entity } from './types.js'
import type { JsonValue, Result, SerializedError } from './result.js'
import { match } from './result.js'

export type SystemId = string
export type ComponentId = string
export type EventId = string

/**
 * Closed discriminated union owned by `@domecs/core`. Plugin APIs compose
 * their own error unions with {@link PluginError} rather than mutating
 * this union — see {@link PluginResult}.
 *
 * `migration_failed` carries `recoverable: boolean` so userland can choose
 * to retry / partial-load. `system_threw` and `event_handler_threw` are
 * for explicit framework-owned isolation points; they are NOT a blanket
 * promise that every user `throw` becomes recoverable data.
 */
export type DomecsError =
  | { kind: 'plugin_install_failed'; plugin: string; cause: SerializedError }
  | { kind: 'system_threw'; system: SystemId; cause: SerializedError; tick: number }
  | { kind: 'persist_io'; op: 'save' | 'load'; cause: SerializedError }
  | { kind: 'migration_failed'; from: number; to: number; reason: string; recoverable: boolean }
  | { kind: 'schema_mismatch'; component: ComponentId; expected: string; got: string }
  | { kind: 'query_invalid'; reason: string }
  | { kind: 'event_handler_threw'; event: EventId; cause: SerializedError }

/**
 * Render a {@link DomecsError} as a single human-readable line for logs,
 * toasts, and inspector UI. Built on {@link match}, so adding a variant to
 * the union breaks this at compile time until a case is supplied — no
 * silent `[object Object]` fallthrough. Pairs with `tapErr` (review #5):
 * `tapErr(world.use(p), (e) => console.warn(describeError(e)))`.
 */
export function describeError(e: DomecsError): string {
  return match(e, {
    plugin_install_failed: (x) =>
      `Plugin "${x.plugin}" failed to install: ${x.cause.message}`,
    system_threw: (x) =>
      `System "${x.system}" threw at tick ${x.tick}: ${x.cause.message}`,
    persist_io: (x) => `Persistence ${x.op} failed: ${x.cause.message}`,
    migration_failed: (x) =>
      `Snapshot migration ${x.from}→${x.to} failed ` +
      `(${x.recoverable ? 'recoverable' : 'unrecoverable'}): ${x.reason}`,
    schema_mismatch: (x) =>
      `Component "${x.component}" schema mismatch: expected ${x.expected}, got ${x.got}`,
    query_invalid: (x) => `Invalid query: ${x.reason}`,
    event_handler_threw: (x) =>
      `Event "${x.event}" handler threw: ${x.cause.message}`,
  })
}

/**
 * Template-literal constraint forces plugin error kinds to carry a
 * `PluginName/` prefix, eliminating silent cross-plugin collisions when
 * two plugins independently choose the same short label (e.g. `'timeout'`).
 * The prefix should reuse {@link Plugin.name}, which the dependency
 * resolver already requires to be unique within a world.
 */
export interface PluginError {
  kind: `${string}/${string}`
}

/**
 * Composition helper for plugin-exposed services: a `Result` whose error
 * channel is `DomecsError` unioned with the plugin's own namespaced
 * variants. Keeps `match` exhaustive at the call site without growing the
 * core union.
 */
export type PluginResult<T, E extends PluginError = never> = Result<T, DomecsError | E>

/**
 * A single fault returned from a system. `entity` absent ⇒ systemic
 * (routes to the world error stream rather than attaching `Faulted`).
 *
 * `error.kind` is the structural label and is copied into the resulting
 * `FaultEntry.kind`; the rest of the error payload is normalized into
 * `FaultEntry.detail` by the scheduler.
 */
export interface SystemFault<E extends { kind: string } = DomecsError> {
  entity?: Entity
  component?: ComponentId
  error: E
  recoverable: boolean
}

/**
 * Return type for systems that participate in the Result contract.
 * Returning `void` (the common ergonomic case) is treated as success.
 */
export interface SystemResult<E extends { kind: string } = DomecsError> {
  errors?: readonly SystemFault<E>[]
}

/**
 * One row in the `Faulted` buffer. The scheduler builds this from a
 * returned `SystemFault` — system authors never construct it directly.
 */
export interface FaultEntry {
  kind: string
  detail?: JsonValue
  source: SystemId
  tick: number
  component?: ComponentId
  recoverable: boolean
}

/** Systemic fault forwarded to the world error stream. */
export interface SystemicFault {
  source: SystemId
  tick: number
  entry: FaultEntry
}
