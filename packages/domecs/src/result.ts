/**
 * Result<T, E> — the framework's contract at recoverable seams (system
 * returns, plugin lifecycle, persistence, services). Discipline lives in
 * doc/BETTER_ERRORS.md; this file holds the primitives.
 *
 * Programmer-error invariants still throw. `Result` is for *expected*
 * failure modes that callers should acknowledge.
 */

/** The success arm of a {@link Result}. */
export type Ok<T> = { readonly ok: true; readonly value: T }
/** The failure arm of a {@link Result}. */
export type Err<E> = { readonly ok: false; readonly error: E }

export type Result<T, E> = Ok<T> | Err<E>

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

// Predicate on the *named* union constituents (not inline shapes) so TS
// narrows BOTH branches: after `if (isErr(r))` the else-branch is `Ok<T>`,
// and after `if (!isOk(r))` the then-branch is `Err<E>`. Inline predicate
// types left `r` as the full union on the negative branch.
export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok

export function mapR<T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r
}

export function mapErr<T, E, F>(r: Result<T, E>, f: (e: E) => F): Result<T, F> {
  return r.ok ? r : err(f(r.error))
}

export function andThen<T, U, E>(
  r: Result<T, E>,
  f: (t: T) => Result<U, E>,
): Result<U, E> {
  return r.ok ? f(r.value) : r
}

export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback
}

/**
 * Run a side effect on the success value and pass the Result through
 * unchanged. For logging/telemetry in a Result pipeline without unwrapping:
 * `tap(world.use(p), () => log('plugin installed'))`.
 */
export function tap<T, E>(r: Result<T, E>, f: (t: T) => void): Result<T, E> {
  if (r.ok) f(r.value)
  return r
}

/**
 * Run a side effect on the error and pass the Result through unchanged.
 * Pairs with {@link describeError}:
 * `tapErr(world.use(p), (e) => console.warn(describeError(e)))`.
 */
export function tapErr<T, E>(r: Result<T, E>, f: (e: E) => void): Result<T, E> {
  if (!r.ok) f(r.error)
  return r
}

export function all<T, E>(
  rs: ReadonlyArray<Result<T, E>>,
): Result<readonly T[], E> {
  const out: T[] = []
  for (const r of rs) {
    if (!r.ok) return r
    out.push(r.value)
  }
  return ok(out)
}

export function attempt<T>(
  fn: () => T,
): Result<T, { kind: 'thrown'; cause: SerializedError }> {
  try {
    return ok(fn())
  } catch (e) {
    return err({ kind: 'thrown', cause: normalizeCause(e) })
  }
}

export async function attemptAsync<T>(
  fn: () => Promise<T>,
): Promise<Result<T, { kind: 'thrown'; cause: SerializedError }>> {
  try {
    return ok(await fn())
  } catch (e) {
    return err({ kind: 'thrown', cause: normalizeCause(e) })
  }
}

/**
 * Exhaustive discriminated-union dispatch. Primary error-handling idiom —
 * adding a new variant to a closed union breaks every `match` site at
 * compile time until the new case is added.
 */
export function match<E extends { kind: string }, R>(
  e: E,
  cases: { [K in E['kind']]: (e: Extract<E, { kind: K }>) => R },
): R {
  const handler = cases[e.kind as E['kind']] as (e: E) => R
  return handler(e)
}

/**
 * Escape hatch for the rare manual `switch (err.kind)` site. The compiler
 * will flag any unhandled discriminant before this throws at runtime.
 */
export function assertNever(x: never): never {
  throw new Error(`unhandled discriminant: ${JSON.stringify(x)}`)
}

// ---------- Serialization ----------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export interface SerializedError {
  name?: string
  message: string
  stack?: string
  cause?: JsonValue
}

export const MAX_CAUSE_DEPTH = 3

/**
 * Normalize an arbitrary thrown value into a JSON-serializable form. Walks
 * `Error.cause` chains to {@link MAX_CAUSE_DEPTH}; deeper chains truncate
 * silently. Non-Error / non-JSON-stringifiable values fall back to
 * `String(value)`.
 *
 * Runs once at framework boundaries (scheduler, persistence, plugin host) —
 * user code never needs to call it.
 */
export function normalizeCause(value: unknown, depth = MAX_CAUSE_DEPTH): SerializedError {
  if (value instanceof Error) {
    const out: SerializedError = {
      message: value.message,
    }
    if (value.name !== undefined) out.name = value.name
    if (value.stack !== undefined) out.stack = value.stack
    if ((value as Error & { cause?: unknown }).cause !== undefined && depth > 0) {
      out.cause = normalizeCause(
        (value as Error & { cause?: unknown }).cause,
        depth - 1,
      ) as unknown as JsonValue
    }
    return out
  }
  try {
    const s = JSON.stringify(value)
    return { message: s ?? String(value) }
  } catch {
    return { message: String(value) }
  }
}

/**
 * Coerce an arbitrary value into a JsonValue, recursing with the same
 * depth budget as {@link normalizeCause}. Non-serializable leaves
 * (`bigint`, `symbol`, `function`, `undefined`, cyclic graphs) fall back
 * to `String(value)`. Used by the scheduler when projecting a returned
 * `SystemFault`'s payload into a `FaultEntry.detail`.
 */
export function toJsonValue(value: unknown, depth = MAX_CAUSE_DEPTH): JsonValue {
  if (value === null) return null
  const t = typeof value
  if (t === 'boolean' || t === 'number' || t === 'string') {
    return value as JsonValue
  }
  if (value instanceof Error) {
    return normalizeCause(value, depth) as unknown as JsonValue
  }
  if (Array.isArray(value)) {
    if (depth <= 0) return []
    return value.map((v) => toJsonValue(v, depth - 1))
  }
  if (t === 'object') {
    if (depth <= 0) return {}
    const out: Record<string, JsonValue> = {}
    try {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue
        out[k] = toJsonValue(v, depth - 1)
      }
      return out
    } catch {
      return { message: String(value) }
    }
  }
  return String(value)
}
