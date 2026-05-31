# Errors in DOMECS

> If a failure is something the caller should acknowledge, it's data.
> If it's a programmer mistake, it's a throw.

This document is the day-to-day reference for the error discipline introduced by [BETTER_ERRORS.md](BETTER_ERRORS.md). That spec is the design rationale; this is the cookbook.

---

## Philosophy

DOMECS treats expected failure modes as **data that flows through the same machinery as everything else**. There are two channels, and only two:

1. **`Result<T, E>`** at recoverable seams — system returns, plugin lifecycle, persistence, services. Callers either acknowledge the failure or refuse to compile.
2. **`Faulted`** as a component, holding a buffer of `FaultEntry` records on the affected entity. Faults flow through normal query and system machinery: a renderer can show "degraded" by querying `[Sprite, Faulted]`, a retry system can query `[Retryable, Faulted]`, an escalator can query `Faulted` filtered by tick age.

Three properties keep the discipline coherent:

- **Closed unions, exhaustive matching.** `DomecsError` is a closed discriminated union. Adding a variant breaks every `match` site in the codebase at compile time until a case is added. Developers never have to *remember* which errors exist.
- **Normalization at the framework boundary.** `normalizeCause` runs at the scheduler, persistence, and plugin host before any user code sees a fault. System authors return raw `Error` / `unknown` causes; the framework guarantees serializability into `Faulted`, the inspector, or a snapshot.
- **Throwing is reserved for programmer errors.** Returning `void` from a system is success. Returning a `SystemResult<E>` is "I have something to report." Throwing is "the program is broken." The scheduler never auto-promotes a `throw` into recoverable data (see [BETTER_ERRORS §"Non-Goals"](BETTER_ERRORS.md#non-goals)).

---

## Two channels at a glance

| Where you are | What you return | What happens |
|---|---|---|
| Inside a system | `void` | Success — no fault attached. |
| Inside a system | `{ errors: [{ entity, error, recoverable, component? }] }` | Scheduler appends a `FaultEntry` to that entity's `Faulted` buffer. |
| Inside a system | `{ errors: [{ error, recoverable }] }` (no `entity`) | Scheduler emits a `SystemicFault` on `world.signals.faultRaised`. |
| Plugin `install` | `Result<PluginHandle, DomecsError>` | `world.use()` returns the same Result; failed installs unwind capabilities. |
| Persistence | `Result<void, DomecsError>` / `Result<WorldSnapshot, MigrationFailedError>` | `save` / `load` / `migrate` never throw on expected failures. |

---

## The `match` idiom

`match` is the primary way to handle a `DomecsError`. Adding a new variant to the union breaks every `match` site at compile time — the type system asks the questions for you.

```ts
import { match, type DomecsError } from '@domecs/core'

function summarize(e: DomecsError): string {
  return match<DomecsError, string>(e, {
    plugin_install_failed: (e) => `plugin "${e.plugin}" failed: ${e.cause.message}`,
    persist_io:            (e) => `${e.op} I/O: ${e.cause.message}`,
    migration_failed:      (e) => `migrate ${e.from}→${e.to}: ${e.reason}`,
    schema_mismatch:       (e) => `${e.component} expected ${e.expected}, got ${e.got}`,
    query_invalid:         (e) => `query: ${e.reason}`,
    event_handler_threw:   (e) => `event "${e.event}": ${e.cause.message}`,
  })
}
```

`switch (e.kind)` plus `assertNever` is the documented low-level form. Use it only when the per-case body is too long for an object literal:

```ts
import { assertNever, type DomecsError } from '@domecs/core'

function shouldRetry(e: DomecsError): boolean {
  switch (e.kind) {
    case 'persist_io':       return true
    case 'migration_failed': return e.recoverable
    case 'plugin_install_failed':
    case 'schema_mismatch':
    case 'query_invalid':
    case 'event_handler_threw':
      return false
    default: return assertNever(e)
  }
}
```

---

## Cookbook

### 1. Returning a fault from a system

Entity-scoped — attaches to `Faulted.faults`:

```ts
world.system('hp-validator', { query: [Health] as const }, ({ entities }) => {
  const errors = entities
    .filter((e) => e.Health.hp < 0)
    .map((e) => ({
      entity: e.id,
      component: 'Health',
      error: { kind: 'schema_mismatch', component: 'Health', expected: 'hp>=0', got: `hp=${e.Health.hp}` },
      recoverable: true,
    } as const))
  return { errors }
})
```

Systemic — routes to `world.signals.faultRaised`, never attaches a phantom entity:

```ts
world.system('persistence-watcher', { schedule: 'tick' }, () => {
  if (!storageAvailable()) {
    return {
      errors: [{
        error: { kind: 'persist_io', op: 'save', cause: { name: 'Error', message: 'storage offline' } },
        recoverable: true,
      }],
    }
  }
})
```

The common case stays ergonomic — a system that has nothing to report returns nothing.

### 2. Retry

Pair `Faulted` with a marker component. The retry system clears the marker once the work succeeds; the validator re-attaches `Faulted` on the next tick if it fails again.

```ts
const Retryable = defineComponent<{ attempts: number; maxAttempts: number }>('Retryable')

world.system(
  'retry-recoverable',
  { query: [Faulted, Retryable] as const, schedule: 'tick' },
  ({ entities }) => {
    for (const e of entities) {
      const recoverable = e.Faulted.faults.some((f) => f.recoverable)
      if (!recoverable) continue
      if (e.Retryable.attempts >= e.Retryable.maxAttempts) continue
      e.Retryable.attempts += 1
      world.markChanged(e.id, Retryable)
      world.removeComponent(e.id, Faulted)  // re-attaches if the next tick still faults
    }
  },
)
```

### 3. Escalation

Faults older than N ticks are no longer transient — surface them.

```ts
world.system('escalate-stuck-faults', { query: [Faulted] as const, schedule: 'tick' }, ({ entities, time }) => {
  for (const e of entities) {
    const stuck = e.Faulted.faults.find((f) => time.tick - f.tick > 600)
    if (!stuck) continue
    world.emit(OperatorAlert, { entity: e.id, fault: stuck })
  }
})
```

### 4. Degraded rendering

A view that binds to `[Sprite, Faulted]` only renders when the entity is broken. Pair it with the normal sprite view (binds `[Sprite]` without `Not(Faulted)`, or with — your call) to show both layers, or with `Not(Faulted)` to hide the healthy view entirely while the entity is faulting.

```ts
mountDOM(world, {
  slots: { stage: stageEl },
  views: [
    defineView({
      slot: 'stage',
      query: [Sprite, Faulted] as const,
      create: () => {
        const el = document.createElement('div')
        el.className = 'sprite sprite--degraded'
        return el
      },
      update: (el, e) => {
        const latest = e.Faulted.faults[e.Faulted.faults.length - 1]
        el.title = latest ? `${latest.source}: ${latest.kind}` : ''
      },
    }),
  ],
})
```

### 5. Defining a plugin error union

Plugin errors must be namespaced — the kind satisfies `` `${PluginName}/${string}` ``. The compiler enforces the prefix; two plugins can both have a `timeout` without colliding.

```ts
import type { PluginError, PluginResult } from '@domecs/core'
import { err, ok } from '@domecs/core'

type NetworkError =
  | { kind: 'network/timeout';     ms: number }
  | { kind: 'network/unreachable'; host: string }
// Compile-time guarantee: NetworkError satisfies PluginError.
const _typeCheck: PluginError = (null as unknown as NetworkError)

export function fetchJson(url: string): PluginResult<unknown, NetworkError> {
  if (url.startsWith('offline://')) {
    return err({ kind: 'network/unreachable', host: new URL(url).host })
  }
  return ok({ /* parsed payload */ })
}
```

A call site that consumes `PluginResult<unknown, NetworkError>` gets exhaustive matching over `DomecsError | NetworkError` without any module augmentation.

### 6. Persistence — save / load / migrate

```ts
import { createWorld } from '@domecs/core'
import { createMemoryStorage, load, save, type Migration } from '@domecs/persist'

const storage = createMemoryStorage()

const world = createWorld()
const saved = save(world, storage, 'slot-1')
if (!saved.ok) {
  console.warn('save failed:', saved.error.kind)
}

const v0ToV1: Migration = (snap) => ok({
  ...snap,
  version: 1,
  entities: snap.entities.map(renameLegacyComponent),
})

const restored = load(world, storage, 'slot-1', {
  targetVersion: 1,
  migrations: new Map([[0, v0ToV1]]),
})
if (!restored.ok) {
  // Migration-failure semantics: the slot bytes are intact — userland
  // decides recovery (retry with a different chain, archive the slot,
  // surface to operator).
  match(restored.error, {
    persist_io:       (e) => warn(`I/O ${e.op}: ${e.cause.message}`),
    migration_failed: (e) => warn(`migration ${e.from}→${e.to}: ${e.reason}`),
    // ...all other kinds...
  })
}
```

### 7. Wrapping async work

The framework never returns `Promise<Result<...>>` itself — but storage adapters and userland services do. Use `attemptAsync` to wrap legacy throwing code:

```ts
import { attemptAsync } from '@domecs/core'

const result = await attemptAsync(() => fetch(url).then((r) => r.json()))
if (!result.ok) {
  // result.error is { kind: 'thrown'; cause: SerializedError } — convert
  // it into a domain-specific PluginError before propagating.
}
```

---

## Lint conventions

- **Always `await` a `Promise<Result<...>>`** before discarding the return value. A floating promise is also a silently-ignored Result. ESLint's `no-floating-promises` covers this.
- **Never `throw` inside a function whose return type is `Result<...>`.** It defeats the type system's promise to the caller. Catch at the boundary, wrap with `normalizeCause`, and return `err(...)`.
- **`unwrap`-style helpers belong in tests.** Production code should `match` on the error or propagate the Result up. Helpers that throw on `!r.ok` create the same surprise as a raw `throw`.
- **Plugin error variants must be namespaced.** `kind: 'timeout'` will be rejected by `` `${string}/${string}` ``; write `kind: 'my-plugin/timeout'`. The prefix should reuse `Plugin.name` (already unique within a world).
- **Don't construct a `FaultEntry` directly.** Return a `SystemFault` from a system; the scheduler builds the entry, fills `source` and `tick`, and normalizes the cause. See [`packages/domecs/src/world.ts`](../packages/domecs/src/world.ts) (`buildFaultEntry`).

---

## Type-test guarantees

Representative compile-time tests live in [`packages/domecs/test/errors.test.ts`](../packages/domecs/test/errors.test.ts):

- **§8 — `match()` over `DomecsError` is exhaustive.** Adding a new variant without updating the cases map fails to compile.
- **§8b — `assertNever` escape hatch.** A `switch` that misses a kind fails at the `default` branch via `assertNever(e)`.
- **§9 — `PluginError['kind']` satisfies `` `${string}/${string}` ``.** Verified with `expectTypeOf<PluginError['kind']>().toEqualTypeOf<\`${string}/${string}\`>()`. A flat `kind` is a compile error.

When you add a new `DomecsError` variant:

1. Add the case to the union in [`packages/domecs/src/errors.ts`](../packages/domecs/src/errors.ts).
2. Update the representative `match` in `errors.test.ts §8` so the test still compiles.
3. Run `pnpm -r typecheck` — every `match` site in the codebase will surface as a build break until handled. That's the discipline working.

---

## Dev-mode guardrail

`createWorld({ strictReturns: true })` enables a one-time-per-system `console.warn` when a system returns a non-`void`, non-`SystemResult` value (e.g. accidentally returning a number from a for-each). Default off — production worlds skip the runtime check; tests and dev builds opt in.

```ts
const world = createWorld({ strictReturns: true })
world.system('typo', { schedule: 'tick' }, () => {
  return { erorrs: [/* ... */] } // typo: erorrs vs errors — silent without strict
})
world.step(0.016)  // logs: "domecs: system \"typo\" returned a value that is not void or SystemResult..."
```

---

## Where to look in code

| File | Role |
|---|---|
| [`packages/domecs/src/result.ts`](../packages/domecs/src/result.ts) | `Result<T, E>`, `match`, `assertNever`, `normalizeCause`, `attempt`, `attemptAsync`. |
| [`packages/domecs/src/errors.ts`](../packages/domecs/src/errors.ts) | `DomecsError` union, `PluginError`, `SystemFault`, `SystemResult`, `FaultEntry`. |
| [`packages/domecs/src/faulted.ts`](../packages/domecs/src/faulted.ts) | `Faulted` component definition + consolidator constants. |
| [`packages/domecs/src/world.ts`](../packages/domecs/src/world.ts) | `runSystem` shape-check, `handleSystemResult`, `appendFault`, end-of-tick `consolidateFaults`. |
| [`packages/domecs-persist/`](../packages/domecs-persist/) | `save` / `load` / `migrate` — see §6 above. |
| [`packages/domecs-inspector/`](../packages/domecs-inspector/) | Headless `InspectorView` over the fault stream. |
| [`packages/domecs/test/errors.test.ts`](../packages/domecs/test/errors.test.ts) | Phase 1 test coverage and the representative type tests. |

---

## See also

- [BETTER_ERRORS.md](BETTER_ERRORS.md) — full proposal and design rationale.
- [FINDINGS.md](../FINDINGS.md) — consolidated cross-package status.
