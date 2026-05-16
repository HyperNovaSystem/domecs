# Errors as Data: A Result-Typed Error Handling Proposal for DOMECS

**Status:** Proposal · **Target:** `@domecs/core` v0.x · **Author:** fingerskier

---

## Summary

Adopt a `Result<T, E>` discipline at DOMECS's architectural seams — system returns, plugin lifecycle, persistence, event delivery, and service calls — combined with a first-class **errors-as-components** pattern in the ECS itself.
Errors become serializable, replayable, queryable data rather than out-of-band control flow.

This is not a blanket ban on `throw`.
It is a contract: at named seams, the type system enforces that callers acknowledge failure modes.
Programmer-error invariants remain throws.

---

## Background

The JSF Air Vehicle C++ Coding Standards (Lockheed Martin, 2005) banned exceptions in safety-critical avionics code, mandating value-returned error status from every function.
The reasons were WCET predictability, DO-178 certifiability, and resource bounding — none of which apply to TypeScript.

But the *consequence* of the JSF discipline — errors as inspectable, structured data on the type-checked happy path — is the design choice that Rust (`Result<T, E>`), Swift (`throws`), Go (`error`), Zig (error unions), and C++23 (`std::expected`) have since converged on.
The industry has agreed: invisible control flow is a worse default than verbose-but-honest signatures.

DOMECS should adopt the same default at its seams.

---

## The Key DX Insight

> **A Result-returning API makes framework-defined failure visible at the type level.**

Developers can still write `throw` in application code.
The framework's job is different: at DOMECS-owned recoverable seams, failure should be structured data rather than an invisible control-flow edge.

A Result-typed API closes a real DX hole.
`Result<T, E>` cannot be unwrapped without narrowing. A discriminated `DomecsError` union cannot be handled exhaustively without naming every variant or explicitly acknowledging the fallback path with `assertNever`.
That improves code written by humans, examples, tests, and generated code for the same reason: the failure contract is in the signature.

TypeScript does not make this perfect by itself.
Callers can still ignore a returned value, so the proposal should be paired with project conventions that reinforce the discipline:

- lint rules such as `no-floating-promises` for async `Promise<Result<...>>` calls;
- `noUnusedLocals` / `noUnusedParameters` so discarded intermediate results are harder to hide;
- cookbook examples that use exhaustive `switch (err.kind)` handling;
- type tests that fail when a `DomecsError` variant is added without updating representative handlers.

For a framework whose README pitches *"Tailored for AI-augmented development,"* this is the right structural choice, but the benefit is broader than AI: it is ordinary developer ergonomics.

---

## Alignment with DOMECS Design Values

| Stated value | How Result-typing reinforces it |
|---|---|
| **Determinism** — same inputs → same state | Unchecked recoverable failures create out-of-band exits from the tick state machine.  Results keep expected failure inside state. |
| **Replay / networked rollback** | Snapshotted state must include failures.  Exceptions don't serialize; Results and error components do. |
| **Persistence with migrations** | Migration that can fail unrecoverably must be able to say so.  The current `(from, to, snapshot) => snapshot` signature has no failure channel. |
| **Plugin isolation** | A failing plugin should not collapse the world.  Result-typed `install()` / `world.use()` lets the host log and degrade. |
| **TypeScript-first, fully typed** | Result + discriminated unions + exhaustive switch is the modern TS idiom for fallible operations. |
| **Augmented development** | The same explicit contracts that help humans also make generated code easier to review and test. |

---

## Scope

### Result types apply at

1. **System returns** — `SystemResult` describing per-entity or systemic errors.  Reported failures are logged; the tick continues.
2. **Plugin lifecycle** — `install(world, options?): Result<PluginHandle | void, DomecsError>`. Failed installs are quarantined, not fatal.
3. **Persistence** — `save()`, `load()`, `migrate()`, `autosave()`. Migration errors are first-class.
4. **Query construction** — schema mismatches, unknown components, malformed signatures.
5. **Event bus delivery** — handler failures surface as inspectable data.
6. **Plugin-exposed services** — physics raycast, pathfinder route, dialogue evaluation.
7. **Component schema validation** — when components carry runtime schemas.

### Result types do NOT apply at

1. **Per-entity component access in hot loops.** `e.Position.x` stays direct.  Allocating Result wrappers per access destroys both ergonomics and GC behavior.  ECS hot loops are the wrong place.
2. **Pure transforms with no failure mode** — movement, integration, layout math.
3. **Programmer-error invariant violations.** Null deref, off-by-one, "this should never happen."  These remain throws.  Mirror the Rust `panic!`/`Result` split: `Result` for recoverable failure, `throw` for unrecoverable bugs.
4. **Renderer internals** below the system boundary.

---

## Core API

### The Result type

Defined in `@domecs/core`. Zero dependencies.

```ts
export type Result<T, E = DomecsError> =
  | { ok: true; value: T }
  | { ok: false; error: E }

export const ok  = <T>(value: T): Result<T, never> => ({ ok: true,  value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })
```

### Serializable error payloads

Failures that may enter snapshots, inspector timelines, or persistence metadata must be serializable.
Raw `Error` objects and arbitrary `unknown` causes are normalized at the seam — system authors never need to do this themselves.

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export type SerializedError = {
  name?: string
  message: string
  stack?: string
  cause?: JsonValue
}

export type SystemId = string
export type ComponentId = string
export type EventId = string
```

#### Normalization contract

Normalization happens **once, at the framework boundary** — scheduler, persistence, or plugin host — never in user code.
The framework owns a single `normalizeCause` helper:

```ts
const MAX_CAUSE_DEPTH = 3

export function normalizeCause(value: unknown, depth = MAX_CAUSE_DEPTH): SerializedError {
  if (value instanceof Error) {
    return {
      name:    value.name,
      message: value.message,
      stack:   value.stack,
      cause:   value.cause !== undefined && depth > 0
        ? (normalizeCause(value.cause, depth - 1) as unknown as JsonValue)
        : undefined,
    }
  }
  try {
    return { message: JSON.stringify(value) ?? String(value) }
  } catch {
    return { message: String(value) }
  }
}
```

- `Error.cause` chains are walked to a max depth of **3**. Deeper chains are truncated silently — a chain past depth 3 is almost always a wrapped-wrapped-wrapped exception with no new information.
- Non-`Error`, non-JSON-stringifiable values (`bigint`, cyclic graphs, etc.) fall back to `String(value)`.
- The helper is exported, but the scheduler re-runs it on attach, so plugin authors who forget still get normalized faults.

### The DomecsError discriminated union

A discriminated union owned by core.
Plugin APIs compose their own error unions with `DomecsError` at their boundary rather than mutating the core union.
This keeps Phase 1 simple and avoids TypeScript module-augmentation machinery until there is a concrete cross-plugin exhaustiveness need.

```ts
export type DomecsError =
  | { kind: 'plugin_install_failed'; plugin: string; cause: SerializedError }
  | { kind: 'system_threw';          system: SystemId; cause: SerializedError; tick: number }
  | { kind: 'persist_io';            op: 'save' | 'load'; cause: SerializedError }
  | { kind: 'migration_failed';      from: number; to: number; reason: string; recoverable: boolean }
  | { kind: 'schema_mismatch';       component: ComponentId; expected: string; got: string }
  | { kind: 'query_invalid';         reason: string }
  | { kind: 'event_handler_threw';   event: EventId; cause: SerializedError }
```

`system_threw` and `event_handler_threw` are for explicit framework-owned isolation points.
They are not a blanket promise that every user `throw` becomes recoverable data.

#### Plugin error namespacing

Plugin-defined error variants must namespace `kind` under the plugin name to prevent cross-plugin collisions when two plugins independently choose the same short label (e.g. `'timeout'`).
The convention is enforced by the type:

```ts
export type PluginError = { kind: `${string}/${string}` }

export type PluginResult<T, E extends PluginError = never> =
  Result<T, DomecsError | E>
```

A plugin author declares its errors as:

```ts
type PhysicsError =
  | { kind: 'physics/raycast_out_of_bounds'; ray: { x: number; y: number; dx: number; dy: number } }
  | { kind: 'physics/world_locked';          phase: 'simulate' | 'collide' }
```

The template-literal constraint forces the `PluginName/` prefix at compile time.
Use the **plugin name as declared in `Plugin.name`** as the prefix — the dependency resolver already requires that to be unique within a world, so the prefix is automatically unique too.

### System return contract

```ts
export type SystemFault<E extends { kind: string } = DomecsError> = {
  entity?: Entity              // absent means systemic, not entity-scoped
  component?: ComponentId
  error: E                     // may be a core DomecsError or app/plugin error
  recoverable: boolean
}

export type SystemResult<E extends { kind: string } = DomecsError> = {
  errors?: readonly SystemFault<E>[]
}

type SystemFn<Q, E extends { kind: string } = DomecsError> =
  (ctx: SystemContext<Q>) => SystemResult<E> | void
```

A system that returns `void` is treated as successful and produces no `Faulted` entity.
The common case stays ergonomic.
Systems that care about reporting return the full shape.

The scheduler, on receiving `errors`, attaches them to its inspector channel.
Entity-scoped faults are appended to the entity's `Faulted` component (see [Errors as Components](#the-ecs-native-pattern-errors-as-components)).
Systemic faults without an `entity` stay in the inspector/error stream and are not forced onto a fake entity.
The scheduler runs `normalizeCause` on every `cause`/`detail` payload at attach time, so systems may return raw `Error` instances or arbitrary `unknown` causes without ceremony — by the time the value lands in ECS state or a snapshot it is JSON-safe.

Events remain emitted through the existing event APIs:

```ts
ctx.events.emit(EventType, payload)
world.emit(EventType, payload)
```

### Plugin lifecycle contract

```ts
export type Plugin = {
  name: string
  version?: string
  depends?: readonly string[]
  provides?: readonly string[]
  install: (world: World, options?: unknown) =>
    Result<PluginHandle | void, DomecsError>
}

interface World {
  use(plugin: Plugin, options?: unknown): Result<() => void, DomecsError>
}
```

### Persistence contract

```ts
persist.save(slot: string): Promise<Result<SaveMeta, DomecsError>>
persist.load(slot: string): Promise<Result<LoadMeta, DomecsError>>

migrate: (from: number, to: number, snapshot: Snapshot) =>
  Result<Snapshot, Extract<DomecsError, { kind: 'migration_failed' }>>
```

Migration uses the same `DomecsError` discriminant as the rest of the system rather than its own shape — a caller can `match` against migration errors with the same idiom used for IO or schema errors.

### Result helpers

A small, fixed set of helpers ships in `@domecs/core`.
The goal is to keep the average call site free of `if (!r.ok) return r`-pyramids without growing into a full FP library.

```ts
export const isOk  = <T, E>(r: Result<T, E>): r is { ok: true;  value: T } => r.ok
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok

export function mapR<T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r
}

export function mapErr<T, E, F>(r: Result<T, E>, f: (e: E) => F): Result<T, F> {
  return r.ok ? r : err(f(r.error))
}

export function andThen<T, U, E>(r: Result<T, E>, f: (t: T) => Result<U, E>): Result<U, E> {
  return r.ok ? f(r.value) : r
}

export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback
}

export function all<T, E>(rs: ReadonlyArray<Result<T, E>>): Result<readonly T[], E> {
  const out: T[] = []
  for (const r of rs) {
    if (!r.ok) return r
    out.push(r.value)
  }
  return ok(out)
}

export function attempt<T>(fn: () => T): Result<T, { kind: 'thrown'; cause: SerializedError }> {
  try { return ok(fn()) }
  catch (e) { return err({ kind: 'thrown', cause: normalizeCause(e) }) }
}

export async function attemptAsync<T>(fn: () => Promise<T>):
  Promise<Result<T, { kind: 'thrown'; cause: SerializedError }>> {
  try { return ok(await fn()) }
  catch (e) { return err({ kind: 'thrown', cause: normalizeCause(e) }) }
}
```

That's the full surface.
Anything richer (`pipe`, `Task`, `TaskEither`, do-notation) is userland.

### Exhaustiveness — transparent by default

The proposal's goal is that **most developers never explicitly think about exhaustiveness**.
They reach for `match`, which is exhaustive by construction, and the type checker does the rest.
`assertNever` exists as an escape hatch for the rare case where a manual `switch` is the right tool, not as the daily idiom.

```ts
export function match<E extends { kind: string }, R>(
  e: E,
  cases: { [K in E['kind']]: (e: Extract<E, { kind: K }>) => R },
): R {
  return cases[e.kind as E['kind']](e as Extract<E, { kind: E['kind'] }>)
}

export function assertNever(x: never): never {
  throw new Error(`unhandled discriminant: ${JSON.stringify(x)}`)
}
```

`match` forces every kind to be handled at the call site — adding a new variant to `DomecsError` produces a compile error at every `match` site until the new case is added.  No discipline required from the developer; the compiler enforces it.

```ts
const message = match(err, {
  plugin_install_failed: (e) => `plugin ${e.plugin} failed: ${e.cause.message}`,
  system_threw:          (e) => `system ${e.system} threw at tick ${e.tick}`,
  persist_io:            (e) => `persist ${e.op} failed: ${e.cause.message}`,
  migration_failed:      (e) => `migration ${e.from}→${e.to} failed: ${e.reason}`,
  schema_mismatch:       (e) => `${e.component}: expected ${e.expected}, got ${e.got}`,
  query_invalid:         (e) => `bad query: ${e.reason}`,
  event_handler_threw:   (e) => `event ${e.event} handler threw: ${e.cause.message}`,
})
```

Cookbook and docs use `match` as the only error-handling idiom.
`switch (err.kind) { ... default: assertNever(err) }` is documented as the equivalent low-level form but is not the recommended path.

---

## The ECS-Native Pattern: Errors as Components

The defining DOMECS contribution.
Entity-scoped failures attach to entities as components, flowing through the same query/system machinery as any other state.

### Shape: a buffer of fault entries

DOMECS stores at most one component of a given type per entity, so `Faulted` cannot be a single record — multiple systems may fault the same entity in the same tick.
`Faulted` is therefore a **buffer** of entries:

```ts
export interface FaultEntry {
  kind:        string
  detail?:     JsonValue
  source:      SystemId
  tick:        number
  component?:  ComponentId
  recoverable: boolean
}

export const Faulted = defineComponent<{
  faults: readonly FaultEntry[]
}>('Faulted')
```

When the scheduler receives a `SystemFault` from a returned `SystemResult`, it:

1. Looks up (or creates) `Faulted` on the target entity.
2. Calls `normalizeCause` on the fault's `detail`/`cause` payload.
3. Appends a new `FaultEntry` with `source = currentSystem.name` and `tick = world.time.tick`.
4. Calls `world.markChanged(entity, Faulted)` so reactive systems watching `[Faulted]` fire predictably.

The system reports faults; the framework records ECS state.
System authors never construct `FaultEntry` directly.

### Accumulation and consolidation

The scheduler **appends within a tick** — order preserved, no deduplication during a single tick.
A built-in `consolidateFaults` system runs once per tick at end-of-tick priority (after all user systems, before render) and collapses redundant entries by `(source, kind, component)`, keeping the most recent.
This keeps the buffer bounded without dropping diagnostic information mid-tick.

```ts
world.system('consolidateFaults', {
  schedule: 'tick',
  priority: Number.MAX_SAFE_INTEGER,   // runs last
  query:    [Faulted],
}, ({ entities, world }) => {
  for (const e of entities) {
    const seen = new Map<string, FaultEntry>()
    for (const f of e.Faulted.faults) {
      seen.set(`${f.source}|${f.kind}|${f.component ?? ''}`, f)
    }
    const collapsed = Array.from(seen.values())
    if (collapsed.length !== e.Faulted.faults.length) {
      e.Faulted = { faults: collapsed }
      world.markChanged(e.id, Faulted)
    }
  }
})
```

The system is part of core and registers automatically. Userland may disable it (`world.system('consolidateFaults').disable()`) if a project wants raw fault history — for example, a forensic build that retains every diagnostic.

### Properties this gives us for free

- **Inspector visibility** — query `[Faulted]`, see every degraded entity at a glance.
- **Replay** — faults live in snapshots, survive reload, reproduce in time-travel debugging.
- **Retry policy as a system** — a `retry_failed_reads` system queries `[Faulted, Sensor]` and clears `Faulted` after a backoff.  Standard ECS code; no new primitive.
- **Routing** — a `failure_router` system pipes faults to telemetry, UI badges, or rollback triggers.
- **Degraded rendering** — entities with `Faulted` are still entities.  Views render them differently (greyed out, error icon) by querying `[Sprite, Faulted]` separately from `[Sprite]:not[Faulted]`.

### Example: hardware sensor in a controls UI

```ts
type SensorReadError =
  | { kind: 'sensor_comm_timeout'; detail: JsonValue }

world.system('load_cell_read', { query: [Sensor, NeedsRead] }, ({ entities, world }) => {
  const errors: SystemFault<SensorReadError>[] = []
  for (const e of entities) {
    const result = readSensor(e.Sensor.handle)
    if (!result.ok) {
      errors.push({
        entity:      e.id,
        component:   Sensor.name,
        error:       { kind: 'sensor_comm_timeout', detail: result.error },
        recoverable: true,
      })
      continue
    }
    e.Sensor.lastReading = result.value
    world.markChanged(e.id, Sensor)
  }
  return { errors }
})
```

Downstream systems can now:
- Query `[Faulted, Sensor]` and show a degraded indicator in the UI view.
- Query `[Faulted]` and trigger retry for any entry where `recoverable === true`.
- Query `[Faulted]` and escalate to operator alert for any entry where `tick < world.tick - 600`.

Iteration is over the `faults` buffer, e.g. `e.Faulted.faults.some(f => f.recoverable)`.

None of this becomes queryable ECS state if the read just throws and the failure is not reported.

---

## Implementation Plan

### Sequencing with TYPE_EVAL.md

This proposal runs **concurrently with the TYPE_EVAL.md tightening work in Phase 1**, not after it. `SystemFault` references typed `Entity` and per-component fields that only exist once `SystemContext` is generic, so the two streams of work need to land together. Phase 1 below explicitly bundles the TYPE_EVAL items it depends on.

Items from TYPE_EVAL.md that this proposal **subsumes** (do not implement separately):

- **§3.2(a) Plugin options generic** — superseded by the new `Plugin.install` signature here, which already changes the return type. Settling the options generic and the Result return in one Plugin API revision avoids two breaking changes back-to-back.
- **§3.2(b) Typed snapshot hooks** — folded into the persistence/plugin contract work in Phase 1; the new `onSnapshot/onRestore` signatures use `WorldSnapshot` directly.

Items from TYPE_EVAL.md that remain **independent** and can land in either order:

- **§3.3 `CapabilityMap` augmentation point.**
- **§3.4 `RuntimeHost` shim for globalThis access.**
- **§3.5** is no-change; nothing to do.

### Phase 1 — Typed context + core primitives + system faults + plugin API (concurrent, 4–6 days)

**TYPE_EVAL §3.1 — generic `SystemContext` (prerequisite for everything below):**

- Switch `scheduler.ts` to `import type { World } from './world.js'` to break the cycle.
- Make `SystemContext<Fields, State>` and `SystemDef<Fields, State>` generic.
- Add the typed `World.system` overload mirroring `World.query`'s tuple-form overload.
- Update every example system to use the inferred field shape (additive change; no example currently relies on `ctx.entities: unknown`).

**Core Result primitives (`@domecs/core`):**

- Add `Result`, `ok`, `err`, `isOk`, `isErr`.
- Add `mapR`, `mapErr`, `andThen`, `unwrapOr`, `all`.
- Add `attempt`, `attemptAsync`.
- Add `match` (primary idiom) and `assertNever` (escape hatch).
- Add `JsonValue`, `SerializedError`, `normalizeCause` with `MAX_CAUSE_DEPTH = 3`.

**Error union and plugin namespacing:**

- Define the closed core `DomecsError` union, with `migration_failed` carrying `recoverable: boolean`.
- Define `PluginError = { kind: \`${string}/${string}\` }` and `PluginResult<T, E extends PluginError>` for plugin-specific composition.

**System fault contract:**

- Define `SystemFault<E>` and `SystemResult<E>` parameterized on the system's error union.
- `System` signature accepts `void` returns (common case stays ergonomic) or `SystemResult<E>`.
- Update `runSystem` to inspect returned `SystemResult.errors` and call `normalizeCause` on every `cause`/`detail` payload at attach time.

**`Faulted` component as a buffer:**

- Define `FaultEntry` and `Faulted = defineComponent<{ faults: readonly FaultEntry[] }>('Faulted')`.
- Scheduler appends entries within a tick, fills `source` and `tick` from context.
- Register the built-in `consolidateFaults` system at end-of-tick priority.
- Systemic faults (no `entity`) route to the inspector/error stream — never forced onto a fake entity.

**Plugin lifecycle (subsumes TYPE_EVAL §3.2):**

- `Plugin<O>.install(world, options: O): Result<PluginHandle | void, DomecsError>`.
- `World.use(plugin, options): Result<() => void, DomecsError>`.
- `PluginHandle.onSnapshot/onRestore: (snap: WorldSnapshot) => WorldSnapshot` (typed; delete the existing `as WorldSnapshot` casts).
- Failed installs are quarantined, not fatal; provided capabilities are unwound on failure (already implemented; just convert the catch to a Result return).

**Tests:**

- `void` system returns producing no faults.
- Returned entity-scoped faults appending to `Faulted.faults`.
- Two systems faulting the same entity in one tick: both entries present until `consolidateFaults` runs.
- `consolidateFaults` collapses `(source, kind, component)` duplicates.
- Systemic faults reaching the error stream without fake entities.
- Thrown user systems remaining exceptions unless an explicit isolation mode is added later.
- Plugin install failure unwinding provided capabilities and returning `Result.err`.
- Type tests: adding a new `DomecsError` variant breaks every `match` site (representative samples).
- Plugin error `kind` must satisfy the `${string}/${string}` template; a flat kind is a compile error.

### Phase 2 — Persistence (1–2 days) — **shipped**

- New `@domecs/persist` package wraps the core `world.snapshot()` /
  `world.restore()` primitives. `save` / `load` / `migrate` all return
  `Result`.
- `migrate(snap, target, migrations)` returns
  `Result<WorldSnapshot, Extract<DomecsError, { kind: 'migration_failed' }>>`.
  Defensive guard: a step that fails to advance the version returns
  `migration_failed` rather than infinite-looping.
- Migration-failure semantics: on any failed step, `load` never writes
  the partially-migrated snapshot back to storage. The original bytes
  stay intact for inspection or a userland recovery flow — "mark the
  slot, do not corrupt it."
- Hard-fail by default. The single-step `Migration` signature returns
  `Result`; partial load is layered on top by userland and never silent.
- `JSON.stringify` / `JSON.parse` / `world.restore` throws are caught at
  the boundary and normalized via `normalizeCause` into `persist_io`.
- `Storage` is a slot-keyed text adapter (`read`/`write`/`remove`/`list`,
  all Result-returning). A missing slot is `ok(null)`, not an error.
  `createMemoryStorage()` ships for tests; filesystem / IndexedDB /
  network adapters live outside this package.

### Phase 3 — Inspector integration (1–2 days) — **shipped**

- New `@domecs/inspector` package ships the data layer only (no DOM). UI
  panels (Studio, custom devtools) wrap it. Splitting the surface keeps
  this package usable by inspectors that don't render to the DOM and
  prevents an early UI commitment from locking the schema.
- Subscribes to live signals — never routes through `world.snapshot()`,
  which would force `onSnapshot` redaction and clones (see
  `FINDINGS_STUDIO.md` 2026-05-13). Sources: `signals.faultRaised`
  (systemic), `observe(Has(Faulted))` onAdd, `observe(Changed(Faulted))`
  onChange (entity-scoped). Dedupe is a `WeakSet<FaultEntry>` —
  `FaultEntry` identity survives the consolidator's in-place rewrite
  (verified at world.ts:1281-1289), so the WeakSet correctly skips
  re-records after consolidation reorders or shrinks the buffer.
- `InspectorView` is filter-composable and immutable per call. Filters
  (`bySource`/`byKind`/`byTick`/`byTickRange`/`recoverableOnly`/
  `onlyFaulted`/`hideFaulted`) capture the entries snapshot at call time
  and return a leaf view; chaining is supported.
- Buffer-aware per-entity view via `entriesFor(entity)` exposes every
  recorded entry, not just the latest.
- Optional replay timeline (`recordStateChanges: true`) interleaves
  `spawn`/`despawn`/`componentAdded`/`componentRemoved`/`fault` events
  ordered by ingestion. Off by default — timeline stays fault-only
  unless requested.
- Systemic and entity-scoped buckets are tracked separately
  (`view.systemic` vs `view.entityScoped`) — systemic faults are never
  forced into the entity-keyed log.
- Ring buffer (default 1024) caps memory; oldest entries drop on
  overflow. `clear()` empties both buffers.

### Phase 4 — DX guardrails and documentation (1 day)

- `doc/error-handling.md` — philosophy, `match`-first idiom, cookbook patterns.
- README section: "Errors as Components."
- Update `FINDINGS.md` with rationale and links to this proposal.
- Cookbook examples: retry, escalation, degraded rendering, plugin error definition.
- Add or document lint conventions for `Promise<Result<...>>` handling.
- Add representative `match`-based type tests for `DomecsError`.

### Phase 5 — Deferred (post-v0)

- Event-handler Result-ification (define the contract now; defer implementation).
- Query-construction Results (current API is loose; tighten later).
- Optional thrown-system isolation mode, if the framework later wants `system_threw` to be recoverable data.
- Module-augmentation error registries, only if generic plugin error composition proves insufficient.
- Adapter packages (Svelte 5, React) — they consume Results, they don't define new ones.
- Dev-mode `faultMode: 'strict' | 'permissive'` toggle that re-throws on attach in strict mode for test discipline.

**Total effort estimate: 7–11 focused days** for the combined Phase 1 (typed context + Result core + system faults + plugin API), persistence, inspector, and docs. Phase 1's first ~3 days are TYPE_EVAL §3.1 prerequisite work; the remainder is BETTER_ERRORS-specific.

---

## Non-Goals

- **No blanket ban on `throw`.**  Application code may still throw. Programmer errors stay as throws. Returned `SystemFault`s are the first-class recoverable channel; a thrown exception or `void` return does not automatically create a `Faulted` entity.
- **No Result library dependency.** Core owns the type.  `neverthrow`, `effect`, `true-myth` are user-space adapters.
- **No async-Result type.** `Promise<Result<T, E>>` is the contract.  Adapter packages may sugar this; core does not.
- **No runtime exhaustiveness enforcement.** Compile-time only, via `assertNever`.
- **No retrofitting of hot loops.** Component access stays direct.

---

## Resolved Design Decisions

0. **Hot loop boundary.**
   "Hot loop" does not mean "any code that runs every tick."
   It means per-entity, per-frame code where allocating `Result` wrappers would create measurable GC churn.
   Component access and pure per-entity transforms stay direct.

1. **Auto-attach `Faulted`.**
   Returned entity-scoped `SystemFault`s attach `Faulted` by default.
   This avoids a config split between projects that use the new pattern and projects that do not.
   A `void` system return means no reported fault and therefore no `Faulted` component.

2. **Migration partial-load.**
   Hard-fail by default with a structured `Result` error in the unified `DomecsError` union (`migration_failed` kind).
   Partial loads are dangerous because they can create plausible but invalid worlds.
   Userland may build explicit recovery flows later.

3. **Plugin error extension.**
   Start with generic composition, not module augmentation:
   plugin services return `PluginResult<T, PluginSpecificError>`.
   This keeps the implementation small while preserving exhaustive matching at the call site.
   Module augmentation can be added later if cross-plugin global exhaustiveness becomes worth the machinery.

4. **Naming.**
   Use `Faulted`.
   It describes a recoverable state rather than a final verdict, and it matches the controls-UI vocabulary DOMECS already cares about.

5. **Plugin error namespace.**
   Plugin error variants carry `kind: \`${PluginName}/${string}\``.
   Two plugins independently choosing the short label `'timeout'` would otherwise produce silently colliding variants that no exhaustive `match` could distinguish.
   The template-literal constraint enforces the prefix at compile time, and the prefix reuses `Plugin.name` (already required unique within a world by the dependency resolver).

6. **`Faulted` accumulation.**
   `Faulted` is a buffer of `FaultEntry` records, not a single record.
   The scheduler appends entries within a tick (preserving diagnostic order) and a built-in `consolidateFaults` end-of-tick system collapses redundant entries by `(source, kind, component)`, keeping the most recent.
   DOMECS stores at most one component of a given type per entity, so a single-record `Faulted` would silently lose multi-system faults within a tick — a buffer plus consolidator is the cheapest correct shape.
   Userland may disable `consolidateFaults` for forensic builds that retain full history.

7. **Normalization at the framework boundary.**
   `normalizeCause` runs at the scheduler / persistence / plugin boundary, not in user code.
   System authors return raw `Error`/`unknown` causes freely; the framework guarantees serializability before the value reaches `Faulted`, the inspector, or a snapshot.
   `Error.cause` chains are walked to depth 3 and silently truncated past that — beyond depth 3 a chain is almost always wrapped redundancy with no incremental information.

8. **`match` is the primary idiom; exhaustiveness is transparent.**
   The cookbook teaches `match(err, { ... })` for every `DomecsError` and plugin-error site.
   `match` forces every variant to be handled at compile time without the developer thinking about it: adding a new `DomecsError` variant breaks every `match` site until handled.
   `switch (err.kind)` plus `assertNever` remains a documented low-level form but is not the recommended path.
   The intent: most developers never explicitly reason about which realm of error they are handling — the type system asks the questions for them.

9. **Core Result helpers.**
   `@domecs/core` exports a fixed minimal set: `ok`, `err`, `isOk`, `isErr`, `mapR`, `mapErr`, `andThen`, `unwrapOr`, `all`, `attempt`, `attemptAsync`, `match`, `assertNever`, `normalizeCause`.
   These are sufficient to keep call sites flat without growing core into a full FP library.
   Richer combinators (`pipe`, `Task`, `TaskEither`, do-notation) stay in userland.

---

## Why Now

DOMECS is at the right inflection point:

- Core is unfrozen. Contracts are still negotiable.
- The roadmap commits to **rollback and replay**, which compound the value of this discipline. Retrofitting it after rollback ships is significantly harder.
- The **"AI-augmented development"** pitch should be backed by ordinary structural DX choices, not just documentation language.
- Retrofit cost is near zero today.  After v1.0 and external adopters, it becomes a major version bump.

Adopting this now is cheap.  Adopting it later is a breaking change.

---

## Appendix: Comparison to Prior Art

| System | Approach | Notes |
|---|---|---|
| **JSF C++** (2005) | Banned exceptions; mandated status returns | Safety-critical motivation; same ergonomic conclusion |
| **Rust** | `Result<T, E>`, `?` operator, `panic!` for unrecoverable | Closest spiritual ancestor of this proposal |
| **bevy ECS** (Rust) | Result-typed systems via Rust idioms | No equivalent in JS-land |
| **Swift** | `throws` (compile-checked Result) | Syntactic sugar; same semantics |
| **Go** | `(T, error)` tuple | Cultural pressure to check errors, no compiler enforcement |
| **C++23** | `std::expected<T, E>` | Standards committee acknowledging JSF was right |
| **TypeScript ecosystem** | `neverthrow`, `effect`, `true-myth`, `ts-results` | Userland; no framework has made it native |

**DOMECS's novel contribution: errors as ECS components.** No JS ECS framework has made this a first-class pattern. It is the natural extension of "behavior as data" to "failure as data."
