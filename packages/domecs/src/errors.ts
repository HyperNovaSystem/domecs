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
 * to retry / partial-load. `event_handler_threw` is for an explicit
 * framework-owned isolation point; it is NOT a blanket promise that every
 * user `throw` becomes recoverable data.
 *
 * `retryable` signals whether the failure is transient (true — the same
 * operation could succeed on a subsequent attempt) or deterministic (false —
 * retrying without fixing the root cause will always fail).
 *
 * Retryability rationale per variant:
 * - plugin_install_failed: false — install contracts are deterministic; a bad
 *   return/throw won't fix itself without code changes.
 * - persist_io: true — storage backends can have transient outages (disk full
 *   briefly, network blip); a retry is worth attempting.
 * - migration_failed: false — a missing migrator or non-advancing version will
 *   always fail; code changes are required. (The existing `recoverable` field
 *   is distinct: it signals whether partial-load is safe, not retry-ability.)
 * - schema_mismatch: false — a type drift is deterministic until the schema or
 *   stored values are corrected.
 * - query_invalid: false — malformed query structure will always be rejected.
 * - event_handler_threw: true — handler may have hit transient state; a retry
 *   on re-emit could succeed.
 */
/** Closed union — adding a variant is a breaking change. */
export type DomecsError =
  | { kind: 'plugin_install_failed'; plugin: string; cause: SerializedError; retryable: boolean }
  | { kind: 'persist_io'; op: 'save' | 'load'; cause: SerializedError; retryable: boolean }
  | { kind: 'migration_failed'; from: number; to: number; reason: string; recoverable: boolean; retryable: boolean }
  | { kind: 'schema_mismatch'; component: ComponentId; expected: string; got: string; retryable: boolean }
  | { kind: 'query_invalid'; reason: string; retryable: boolean }
  | { kind: 'event_handler_threw'; event: EventId; cause: SerializedError; retryable: boolean }

/** All valid `DomecsError` kind literals, in source order. */
export const ERROR_KINDS = [
  'plugin_install_failed',
  'persist_io',
  'migration_failed',
  'schema_mismatch',
  'query_invalid',
  'event_handler_threw',
] as const

export type ErrorKind = (typeof ERROR_KINDS)[number]

/** Returns `true` when `k` is a known `DomecsError` kind literal. */
export function isKnownDomecsErrorKind(k: string): k is ErrorKind {
  return (ERROR_KINDS as readonly string[]).includes(k)
}

/**
 * Returns a non-empty, actionable repair hint for a given {@link DomecsError}.
 * Intended for developer consoles, inspector UIs, and error reporting tools.
 * Built on {@link match} for compile-time exhaustiveness — adding a variant
 * to the union breaks this until a case is supplied.
 */
export function getErrorRepairHint(e: DomecsError): string {
  return match(e, {
    plugin_install_failed: (x) =>
      `Plugin "${x.plugin}" failed to install. Check its install() return and dependency order.`,
    persist_io: (x) =>
      `Persistence ${x.op} failed. Verify the Storage backend is reachable and writable.`,
    migration_failed: (x) =>
      `Snapshot migration ${x.from}->${x.to} failed: ${x.reason}. ${
        x.recoverable
          ? 'Recoverable — retry with a fallback migrator.'
          : 'Not recoverable — discard or hand-migrate.'
      }`,
    schema_mismatch: (x) =>
      `Component "${x.component}" expected ${x.expected} but got ${x.got}. Align the schema or migrate stored values.`,
    query_invalid: (x) =>
      `Invalid query: ${x.reason}. Use a structural node (Has/Where/Not/And/Or) or a component tuple.`,
    event_handler_threw: (x) =>
      `Handler for event "${x.event}" threw. Guard the handler body and emit via Result.`,
  })
}

/**
 * Render a {@link DomecsError} as a single human-readable line for logs,
 * toasts, and inspector UI. Built on {@link match}, so adding a variant to
 * the union breaks this at compile time until a case is supplied — no
 * silent `[object Object]` fallthrough. Pairs with `tapErr`:
 * `tapErr(world.use(p), (e) => console.warn(describeError(e)))`.
 */
export function describeError(e: DomecsError): string {
  return match(e, {
    plugin_install_failed: (x) =>
      `Plugin "${x.plugin}" failed to install: ${x.cause.message}`,
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
  /** When `true`, re-running the fault-raising operation is safe to attempt multiple times. */
  idempotent?: boolean
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
  /** JSON-safe projection of the originating `SystemFault.error` payload,
   * produced by `toJsonValue` (see `result.ts`): a {@link JsonValue} tree with
   * non-serializable leaves stringified and recursion bounded by
   * `MAX_CAUSE_DEPTH`. Absent when the fault carried no payload beyond
   * its `kind`. */
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
