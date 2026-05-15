# Errors as Data: A Result-Typed Error Handling Proposal for DOMECS

**Status:** Proposal · **Target:** `@domecs/core` v0.x · **Author:** fingerskier

---

## Summary

Adopt a `Result<T, E>` discipline at DOMECS's architectural seams — system returns, plugin lifecycle, persistence, event delivery, and service calls — combined with a first-class **errors-as-components** pattern in the ECS itself.
Errors become serializable, replayable, queryable data rather than out-of-band control flow.

This is not a blanket ban on `throw`. It is a contract: at named seams, the type system enforces that callers acknowledge failure modes.
Programmer-error invariants remain throws.

---

## Background

The JSF Air Vehicle C++ Coding Standards (Lockheed Martin, 2005) banned exceptions in safety-critical avionics code, mandating value-returned error status from every function.
The reasons were WCET predictability, DO-178 certifiability, and resource bounding — none of which apply to TypeScript.

But the *consequence* of the JSF discipline — errors as inspectable, structured data on the type-checked happy path — is the design choice that Rust (`Result<T, E>`), Swift (`throws`), Go (`error`), Zig (error unions), and C++23 (`std::expected`) have since converged on.
The industry has agreed: invisible control flow is a worse default than verbose-but-honest signatures.

DOMECS should adopt the same default at its seams.

---

## The Key Insight

> **A Result-returning API forces AI-generated code to acknowledge every failure path at the type level.**

LLM-generated systems silently swallow `try/catch` blocks.
They omit error handling the type checker doesn't demand.
They route exceptions to `console.error` and move on.
Overnight agent loops accrete these failures into a codebase that compiles and "works" but is opaque the moment something breaks.

A Result-typed API closes that hole.
`Result<T, E>` cannot be unwrapped without narrowing. A discriminated `DomecsError` union cannot be handled without exhaustive matching (or explicit acknowledgment via `assertNever`). The agent writing the code is forced — by the compiler, not by review — to make decisions about every failure mode the framework defines.

For a framework whose README pitches *"Tailored for AI-augmented development,"* this is not a secondary benefit.
**It is the primary lever.**
This benefit alone would justify the work; the others are additional upside.

---

## Alignment with DOMECS Design Values

| Stated value | How Result-typing reinforces it |
|---|---|
| **Determinism** — same inputs → same state | Exceptions create out-of-band exits from the tick state machine.  Results keep failure inside state. |
| **Replay / networked rollback** | Snapshotted state must include failures.  Exceptions don't serialize; Results and error components do. |
| **Persistence with migrations** | Migration that can fail unrecoverably must be able to say so.  The current `(from, to, snapshot) => snapshot` signature has no failure channel. |
| **Plugin isolation** | A failing plugin should not collapse the world.  Result-typed `install()` lets the host log and degrade. |
| **TypeScript-first, fully typed** | Result + discriminated unions + exhaustive switch is the modern TS idiom for fallible operations. |
| **AI-augmented development** | See "The Key Insight." |

---

## Scope

### Result types apply at

1. **System returns** — `SystemResult` describing emitted events, touched entities, and per-entity or systemic errors.  Failed systems are logged; the tick continues.
2. **Plugin lifecycle** — `install(world): Result<Teardown, PluginError>`. Failed installs are quarantined, not fatal.
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

### The DomecsError discriminated union

A discriminated union owned by core.  Plugins extend via module augmentation.

```ts
export type DomecsError =
  | { kind: 'plugin_install_failed'; plugin: string; cause: unknown }
  | { kind: 'system_threw';          system: SystemId; cause: unknown; tick: number }
  | { kind: 'persist_io';            op: 'save' | 'load'; cause: unknown }
  | { kind: 'migration_failed';      from: number; to: number; reason: string }
  | { kind: 'schema_mismatch';       component: ComponentId; expected: string; got: string }
  | { kind: 'query_invalid';         reason: string }
  | { kind: 'event_handler_threw';   event: EventId; cause: unknown }
```

### System return contract

```ts
export type SystemResult = {
  emitted: Event[]              // events to buffer for next tick
  errors:  DomecsError[]        // non-fatal failures observed this run
}

type SystemFn<Q> = (ctx: SystemContext<Q>) => SystemResult | void
```

A system that returns `void` is treated as `{ emitted: [], errors: [] }`.
The common case stays ergonomic.
Systems that care about reporting return the full shape.

The scheduler, on receiving `errors`, attaches them to its inspector channel.
Optionally (per scheduler config) it attaches `Faulted` components to associated entities.

### Plugin lifecycle contract

```ts
export type Plugin = {
  name: string
  version: string
  install: (world: World) => Result<Teardown, DomecsError>
}
```

### Persistence contract

```ts
persist.save(slot: string): Promise<Result<SaveMeta, DomecsError>>
persist.load(slot: string): Promise<Result<LoadMeta, DomecsError>>

migrate: (from: number, to: number, snapshot: Snapshot) =>
  Result<Snapshot, { reason: string; recoverable: boolean }>
```

### Exhaustiveness helper

```ts
export function assertNever(x: never): never {
  throw new Error(`unhandled discriminant: ${JSON.stringify(x)}`)
}
```

Used at the end of every `switch (err.kind)` to force the compiler to flag missing branches when the union grows.

---

## The ECS-Native Pattern: Errors as Components

The defining DOMECS contribution.
Failures attach to entities as components, flowing through the same query/system machinery as any other state.

```ts
export const Faulted = defineComponent<{
  kind:        string
  detail:      unknown
  source:      SystemId
  tick:        number
  recoverable: boolean
}>('Faulted')
```

### Properties this gives us for free

- **Inspector visibility** — query `[Faulted]`, see every degraded entity at a glance.
- **Replay** — faults live in snapshots, survive reload, reproduce in time-travel debugging.
- **Retry policy as a system** — a `retry_failed_reads` system queries `[Faulted, Sensor]` and clears `Faulted` after a backoff.  Standard ECS code; no new primitive.
- **Routing** — a `failure_router` system pipes faults to telemetry, UI badges, or rollback triggers.
- **Degraded rendering** — entities with `Faulted` are still entities.  Views render them differently (greyed out, error icon) by querying `[Sprite, Faulted]` separately from `[Sprite]:not[Faulted]`.

### Example: hardware sensor in a controls UI

```ts
world.system('load_cell_read', { query: [Sensor, NeedsRead] }, ({ entities, world, tick }) => {
  const errors: DomecsError[] = []
  for (const e of entities) {
    const result = readSensor(e.Sensor.handle)
    if (!result.ok) {
      world.attach(e.id, entry(Faulted, {
        kind:        'comm_timeout',
        detail:      result.error,
        source:      'load_cell_read',
        tick,
        recoverable: true,
      }))
      continue
    }
    e.Sensor.lastReading = result.value
    world.markChanged(e.id, Sensor)
  }
  return { emitted: [], errors }
})
```

Downstream systems can now:
- Query `[Faulted, Sensor]` and show a degraded indicator in the UI view.
- Query `[Faulted]` where `recoverable: true` and trigger retry.
- Query `[Faulted]` where `tick < world.tick - 600` and escalate to operator alert.

None of this is possible if the read just throws.

---

## Implementation Plan

### Phase 1 — Core primitives (1–2 days)

- Add `Result`, `ok`, `err`, `assertNever` to `@domecs/core`.
- Define `DomecsError` discriminated union.
- Define `SystemResult`; update `SystemFn` signature; void return remains valid.
- Define `Faulted` component, ship in core.
- Update scheduler to collect and surface `errors` from systems.
- Update plugin lifecycle to return `Result<Teardown, DomecsError>`.

### Phase 2 — Persistence (1 day)

- Convert `@domecs/persist` `save` / `load` / `migrate` to Result returns.
- Document migration failure semantics: unrecoverable migrations mark the slot, do not corrupt it.

### Phase 3 — Inspector integration (1–2 days)

- Inspector panel surfaces `Faulted` entities by source system, by tick, by kind.
- Replay timeline shows fault attachments inline with state changes.
- Filter views: only-faulted, hide-faulted.

### Phase 4 — Documentation (1 day)

- `doc/error-handling.md` — philosophy and patterns.
- README section: "Errors as Components."
- Update `FINDINGS.md` with rationale and links to this proposal.
- Cookbook examples: retry, escalation, degraded rendering.

### Phase 5 — Deferred (post-v0)

- Event-handler Result-ification (define the contract now; defer implementation).
- Query-construction Results (current API is loose; tighten later).
- Adapter packages (Svelte 5, React) — they consume Results, they don't define new ones.

**Total core effort estimate: 4–6 focused days.**

---

## Non-Goals

- **No blanket ban on `throw`.**  Programmer errors stay as throws.  The framework will not wrap user system code in `try/catch` by default — that hides bugs.
- **No Result library dependency.** Core owns the type.  `neverthrow`, `effect`, `true-myth` are user-space adapters.
- **No async-Result type.** `Promise<Result<T, E>>` is the contract.  Adapter packages may sugar this; core does not.
- **No runtime exhaustiveness enforcement.** Compile-time only, via `assertNever`.
- **No retrofitting of hot loops.** Component access stays direct.

---

## Open Questions

0. **Hot-Loop** This term needs to be defined.
>  It is not "any code that runs every tick."  It is code that runs per-entity, per-frame, where GC churn from Result wrappers would be catastrophic.  The exact boundary needs to be drawn and documented.
1. **Auto-attach `Faulted`?** Should the scheduler auto-attach `Faulted` components when a system returns errors, or is that policy left to userland?  **Recommendation:** opt-in via scheduler config flag; userland systems are explicit by default.
>  We need avoid config-hell: we should default to this new system;  userland can throw if they want ~ no fragmentation
2. **Migration partial-load?** Hard-fail the load, or load partial and mark entities as `Faulted`? **Recommendation:** hard-fail with a structured error.  Partial loads are dangerous; better to let userland opt into recovery explicitly.
>  hard-fail is simpler to deal with
3. **Plugin error extension.** Module augmentation of `DomecsError`, or a parallel `PluginError<P>` slot? Augmentation is cleaner ergonomically but couples plugins to core's union type.  **Lean:** module augmentation with a documented convention for `kind` prefixes (`physics_*`, `pathfind_*`).
>  module augmentation is better
4. **Naming.** `Failed`, `Error`, `Faulted`, `Degraded`? `Failed` is direct but carries English finality. `Faulted` is a state, not a verdict, and matches industrial controls vocabulary (which fits the controls-UI target). **Recommendation: `Faulted`.**
>  go with `Faulted`

---

## Why Now

DOMECS is at the right inflection point:

- Core is unfrozen. Contracts are still negotiable.
- The roadmap commits to **rollback and replay**, which compound the value of this discipline. Retrofitting it after rollback ships is significantly harder.
- The **"AI-augmented development"** pitch has not yet been backed by structural choices.  This is the first one.
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