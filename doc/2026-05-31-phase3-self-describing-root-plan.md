# Phase 3 — Self-Describing Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the additive, opt-in self-describing root (design spec §6) so an agent/inspector can read one machine-readable manifest to learn the whole live world.

**Architecture:** Mirror the already-shipped `world.describeComponent()` pattern for resources and events, then compose all `describe*` reflectors plus O(1)/O(archetype) live-population counts into `world.describe(): WorldManifest`. Add a serializable `InspectorView.export()`. Everything is **additive** — no consumer breaks. Branch off `v1-break-phase2` (this builds on Phase 2 types: `SystemSchedule`, the renamed accessors, `ComponentDescriptor`).

**Tech Stack:** TypeScript-first pnpm workspace (`pnpm@10.30.2`), vitest 2.1.9 per package (`packages/*/test/*.test.ts`), repo-level `node:test` for API-surface, committed `.d.ts` surface snapshots with a CI no-drift gate.

**Already shipped in Phase 2 (do NOT redo):** the error half of §6 (`retryable` on every `DomecsError`, `idempotent?` on `SystemFault`, `getErrorRepairHint`, `ERROR_KINDS`, `isKnownDomecsErrorKind`); `world.describeComponent()` + `ComponentDescriptor`/`ComponentSchema`/`FieldSchema`/`FieldKind` exports; `InternalComponentType` already absent from the public barrel.

**Deliberate deviation from spec §6 (surfaced for review):** spec's `WorldManifest` literal declares `plugins: InstalledPlugin[]`. `InstalledPlugin` is `{ plugin, handle, options }` — it carries live functions (`plugin.install`, `handle.teardown`) and arbitrary `options`, which are non-serializable and leak internals. A manifest that exists to be *read and polled* must be serializable, so this plan projects to a legible `PluginManifestEntry { name; version?; provides }`. Same reasoning keeps `events`/`systems` as flat serializable rows (already what the spec shows). If you want the raw `InstalledPlugin[]` instead, say so before Task 3.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `packages/domecs/src/types.ts` | Component/resource value & descriptor types | **Modify** — add `ResourceDescriptor` |
| `packages/domecs/src/events.ts` | Event types + bus | **Modify** — `EventDefOptions`, `InternalEventType.__schema`, `defineEvent` options, `internalEvent`, `EventDescriptor`, `EventBus.knownTypes()` |
| `packages/domecs/src/manifest.ts` | The composed manifest types | **Create** — `WorldManifest`, `PluginManifestEntry` |
| `packages/domecs/src/world.ts` | World interface + impl | **Modify** — add `resourceTypes`, `describeResource`, `describeEvent`, `describe` (interface ~119–284, impl object ~1044–1715) |
| `packages/domecs/src/index.ts` | Public barrel | **Modify** — export `ResourceDescriptor`, `EventDescriptor`, `WorldManifest`, `PluginManifestEntry` |
| `packages/domecs-inspector/src/inspector.ts` | Inspector view | **Modify** — `InspectorSnapshot` + `InspectorView.export()` |
| `packages/domecs-inspector/src/index.ts` | Inspector barrel | **Modify** — export `InspectorSnapshot` |
| `doc/LEGIBILITY.md` | Contributor law | **Modify** — flip L2 `describe*` half ⏳→✅ |
| `doc/api-surface/{core,inspector}.d.ts` | Committed surface contract | **Regenerate** (Task 6) |

**Verified internals (quote-accurate, `packages/domecs/src/`):**
- `world.ts:430` `const alive = new Set<Entity>()` → `alive.size` is **O(1)** total entities.
- `world.ts:432` `const stores = new Map<string, Map<Entity, unknown>>()` → iterate for per-component counts, **O(#types)**.
- `world.ts:437` `const archetypes = new Map<string, ArchetypeBucket>()`; bucket is `{ key, types: Set<string>, entities: Set<Entity> }` (`:365–369`) → **O(#archetypes)** populations.
- `world.ts:459–460` `resources: Map<string, unknown>`, `resourceRegistry: Map<string, ResourceType<unknown>>`.
- `world.ts:671` `requireRegisteredResource(type)` registers-on-touch and returns `internalResource(type)`; `InternalResourceType` (`resource.ts:6`) has `__default: (() => T) | undefined`. `hasDefault = meta.__default !== undefined`; `hasValue = resources.has(type.name)`.
- `world.ts:189`/`:1200` `componentTypes(): ComponentType<unknown>[]` (already exists). `:1222` `describeComponent` impl is the pattern to mirror.
- `scheduler.ts:142`/`:265` `systemsByMode(mode: SystemSchedule): CompiledSystem[]`; `CompiledSystem` has `name`, `schedule`, `enabled`. The five modes: `'tick' | 'fixed' | 'event' | 'once' | 'reactive'`.
- `plugin.ts:15` `Plugin` has `name`, `version?`, `provides?: readonly string[]`; `:92` registry `list(): ReadonlyArray<InstalledPlugin>`; `world.ts:280` `capability(name)` delegates to the registry local.
- `snapshot.ts` exports `SNAPSHOT_VERSION` (re-exported at `index.ts:48`).

> **Before wiring `describe()` (Task 4), confirm two local variable names inside the `world.ts` impl scope:** the **event bus** local (search the impl for `createEventBus(` / `.flush()` / `.pendingEvents()`) and the **plugin registry** local (search for `createPluginRegistry(` / `.list()` / the `capability()` delegate). The plan uses `bus` and `plugins` as placeholders for these two locals — substitute the real names. `scheduler` is confirmed (used at `world.ts:752+`).

---

### Task 1: Resource reflection — `resourceTypes()` + `describeResource()`

**Files:**
- Modify: `packages/domecs/src/types.ts` (add `ResourceDescriptor` after `ComponentDescriptor`, ~line 76)
- Modify: `packages/domecs/src/world.ts` (interface ~189; impl ~1200, beside `componentTypes`/`describeComponent`)
- Modify: `packages/domecs/src/index.ts` (types export block, lines 53–67)
- Test: `packages/domecs/test/describe-resource.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/domecs/test/describe-resource.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { defineResource } from '../src/resource.js'
import { createWorld } from '../src/world.js'

const Score = defineResource<{ points: number }>('Score', {
  default: () => ({ points: 0 }),
})
const Config = defineResource<{ hard: boolean }>('Config') // no default

describe('world.describeResource — resource reflection (§6)', () => {
  it('reports name, hasDefault, and hasValue=false before first read', () => {
    const w = createWorld()
    const d = w.describeResource(Config)
    expect(d).toEqual({ name: 'Config', hasValue: false, hasDefault: false })
  })

  it('hasDefault is true when a default factory was declared', () => {
    const w = createWorld()
    expect(w.describeResource(Score).hasDefault).toBe(true)
  })

  it('hasValue flips to true after the resource is materialized', () => {
    const w = createWorld()
    expect(w.describeResource(Score).hasValue).toBe(false)
    w.getResource(Score) // materializes the default
    expect(w.describeResource(Score).hasValue).toBe(true)
  })

  it('resourceTypes() enumerates every touched resource type', () => {
    const w = createWorld()
    w.describeResource(Score)
    w.describeResource(Config)
    const names = w.resourceTypes().map((t) => t.name).sort()
    expect(names).toEqual(['Config', 'Score'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @domecs/core exec vitest run test/describe-resource.test.ts`
Expected: FAIL — `describeResource`/`resourceTypes` do not exist on `World` (TS error / runtime `not a function`).

- [ ] **Step 3: Add the `ResourceDescriptor` type**

In `packages/domecs/src/types.ts`, immediately after the `ComponentDescriptor` interface (ends ~line 76):

```typescript
/**
 * Result of `world.describeResource(type)` — parity with
 * {@link ComponentDescriptor} for world-singleton values. `hasDefault` is
 * true when a `default` factory/value was declared at `defineResource`;
 * `hasValue` is true once the resource has been materialized in this world
 * (read at least once, or set explicitly).
 */
export interface ResourceDescriptor {
  readonly name: string
  readonly hasValue: boolean
  readonly hasDefault: boolean
}
```

- [ ] **Step 4: Add the interface declarations on `World`**

In `packages/domecs/src/world.ts`, in the `World` interface next to `componentTypes(): ComponentType<unknown>[]` (line 189). First ensure `ResourceDescriptor` is imported from `./types.js` (add it to the existing `import type { … } from './types.js'` group). Then add:

```typescript
  /** Every resource type registered or touched in this world. */
  resourceTypes(): ResourceType<unknown>[]

  /**
   * Reflect a resource's name, whether a default was declared, and whether it
   * has been materialized in this world. Registers the type on first call,
   * the same as any resource access.
   */
  describeResource<T>(type: ResourceType<T>): ResourceDescriptor
```

- [ ] **Step 5: Add the implementations**

In the `const world: World = { … }` object literal, next to the `componentTypes()` / `describeComponent()` implementations (~line 1200–1244), add:

```typescript
    resourceTypes(): ResourceType<unknown>[] {
      return Array.from(resourceRegistry.values())
    },

    describeResource<T>(type: ResourceType<T>): ResourceDescriptor {
      const meta = requireRegisteredResource(type as ResourceType<unknown>)
      return {
        name: type.name,
        hasValue: resources.has(type.name),
        hasDefault: meta.__default !== undefined,
      }
    },
```

(`requireRegisteredResource`, `resources`, and `resourceRegistry` are all in scope per `world.ts:459–460`/`:671`.)

- [ ] **Step 6: Export `ResourceDescriptor` from the barrel**

In `packages/domecs/src/index.ts`, add `ResourceDescriptor` to the `export type { … } from './types.js'` block (lines 53–67), e.g. on the line with `ResourceType`:

```typescript
  ResourceType,
  ResourceDescriptor,
  ResourceValue,
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @domecs/core exec vitest run test/describe-resource.test.ts`
Expected: PASS (4/4).

- [ ] **Step 8: Commit**

```bash
git add packages/domecs/src/types.ts packages/domecs/src/world.ts packages/domecs/src/index.ts packages/domecs/test/describe-resource.test.ts
git commit -m "feat(core): add resourceTypes() + describeResource() reflection (Phase 3 §6)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Event reflection — `defineEvent` schema + `describeEvent()`

**Files:**
- Modify: `packages/domecs/src/events.ts` (`EventDefOptions`, `InternalEventType`, `defineEvent` options, `internalEvent`, `EventDescriptor`)
- Modify: `packages/domecs/src/world.ts` (interface + impl: `describeEvent`)
- Modify: `packages/domecs/src/index.ts` (export `EventDescriptor`)
- Test: `packages/domecs/test/describe-event.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/domecs/test/describe-event.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { defineEvent } from '../src/events.js'
import type { ComponentSchema } from '../src/types.js'
import { createWorld } from '../src/world.js'

const DamageSchema: ComponentSchema = {
  fields: {
    amount: { kind: 'number', min: 0 },
    crit: { kind: 'boolean' },
  },
}
const Damage = defineEvent<{ amount: number; crit: boolean }>('Damage', {
  schema: DamageSchema,
})
const Ping = defineEvent<void>('Ping') // no schema

describe('world.describeEvent — event reflection (§6)', () => {
  it('reports the declared schema fields with fieldsSource=schema', () => {
    const w = createWorld()
    const d = w.describeEvent(Damage)
    expect(d.name).toBe('Damage')
    expect(d.fieldsSource).toBe('schema')
    expect(d.fields).toEqual(DamageSchema.fields)
  })

  it('reports empty fields with fieldsSource=none when no schema declared', () => {
    const w = createWorld()
    const d = w.describeEvent(Ping)
    expect(d).toEqual({ name: 'Ping', fields: {}, fieldsSource: 'none' })
  })

  it('returns a copy of fields, not the original schema reference', () => {
    const w = createWorld()
    expect(w.describeEvent(Damage).fields).not.toBe(DamageSchema.fields)
  })

  it('defineEvent without options still works (back-compatible signature)', () => {
    const E = defineEvent<number>('Legacy')
    const w = createWorld()
    expect(w.describeEvent(E).fieldsSource).toBe('none')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @domecs/core exec vitest run test/describe-event.test.ts`
Expected: FAIL — `defineEvent` rejects a 2nd arg / `describeEvent` missing.

- [ ] **Step 3: Extend `events.ts`**

In `packages/domecs/src/events.ts`, add the import at the top and the new types/functions. Replace the existing `defineEvent` (lines 14–16) and add around it:

```typescript
import type { ComponentSchema, FieldSchema } from './types.js'
```

```typescript
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
```

(`name` on `EventType` is the opaque diagnostic label — identity is the internal `eventTag` symbol, unchanged.)

- [ ] **Step 4: Add `describeEvent` to `World`**

In `packages/domecs/src/world.ts`: ensure `EventType` is imported (it is, via `./events.js`) and add `internalEvent` + `EventDescriptor` to that import. Add to the `World` interface (next to `describeComponent`, ~line 205):

```typescript
  /**
   * Reflect an event's name and optional payload schema. `name` is an opaque
   * diagnostic label; event identity is the internal symbol.
   */
  describeEvent(type: EventType<unknown>): EventDescriptor
```

And to the impl object (next to `describeComponent`, ~line 1244):

```typescript
    describeEvent(type: EventType<unknown>): EventDescriptor {
      const meta = internalEvent(type)
      if (meta.__schema) {
        return { name: type.name, fields: { ...meta.__schema.fields }, fieldsSource: 'schema' }
      }
      return { name: type.name, fields: {}, fieldsSource: 'none' }
    },
```

- [ ] **Step 5: Export `EventDescriptor`**

In `packages/domecs/src/index.ts`, add `EventDescriptor` (and `EventDefOptions`) to the `export type { … } from './events.js'` block (line 31):

```typescript
export type { EventType, EventView, EmittedEvent, EventDescriptor, EventDefOptions } from './events.js'
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @domecs/core exec vitest run test/describe-event.test.ts`
Expected: PASS (4/4).

- [ ] **Step 7: Commit**

```bash
git add packages/domecs/src/events.ts packages/domecs/src/world.ts packages/domecs/src/index.ts packages/domecs/test/describe-event.test.ts
git commit -m "feat(core): add defineEvent payload schema + describeEvent() reflection (Phase 3 §6)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Manifest types + `EventBus.knownTypes()`

**Files:**
- Create: `packages/domecs/src/manifest.ts`
- Modify: `packages/domecs/src/events.ts` (`EventBus.knownTypes()` + register types in `on()`)
- Modify: `packages/domecs/src/index.ts` (export `WorldManifest`, `PluginManifestEntry`)
- Test: `packages/domecs/test/event-known-types.test.ts` (create)

- [ ] **Step 1: Write the failing test (bus enumeration)**

Create `packages/domecs/test/event-known-types.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { createEventBus, defineEvent } from '../src/events.js'

const A = defineEvent<number>('A')
const B = defineEvent<number>('B')

describe('EventBus.knownTypes — enumerates types the bus has seen', () => {
  it('lists a type after it is emitted', () => {
    const bus = createEventBus()
    bus.emit(A, 1)
    expect(bus.knownTypes().map((t) => t.name)).toEqual(['A'])
  })

  it('lists a type after subscription, before any emit', () => {
    const bus = createEventBus()
    bus.on(B, () => {})
    expect(bus.knownTypes().map((t) => t.name)).toContain('B')
  })

  it('does not duplicate a type seen multiple times', () => {
    const bus = createEventBus()
    bus.emit(A, 1)
    bus.emit(A, 2)
    bus.on(A, () => {})
    expect(bus.knownTypes().filter((t) => t.name === 'A')).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @domecs/core exec vitest run test/event-known-types.test.ts`
Expected: FAIL — `bus.knownTypes is not a function`.

- [ ] **Step 3: Implement `knownTypes()` and register on subscribe**

In `packages/domecs/src/events.ts`:

(a) Add to the `EventBus` interface (after `pendingEvents()`, ~line 46):

```typescript
  /**
   * Every event type this bus has observed — emitted or subscribed to — in
   * first-seen order. Powers `world.describe().events`. Note: an event type
   * defined but never used in this world is unknowable and will not appear.
   */
  knownTypes(): EventType<unknown>[]
```

(b) In `on<T>(...)` (the `EventBus` impl, ~line 87), register the type in `typeByTag` before adding the subscriber, mirroring `emit`:

```typescript
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
```

(c) Add the implementation to the returned object (next to `pendingEvents`):

```typescript
    knownTypes(): EventType<unknown>[] {
      return Array.from(typeByTag.values())
    },
```

- [ ] **Step 4: Run the bus test to verify it passes**

Run: `pnpm --filter @domecs/core exec vitest run test/event-known-types.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Create the manifest types**

Create `packages/domecs/src/manifest.ts`:

```typescript
import type { SystemSchedule } from './scheduler.js'
import type { ComponentDescriptor, ResourceDescriptor } from './types.js'

/**
 * Serializable projection of an installed plugin for {@link WorldManifest}.
 * Deliberately NOT the internal `InstalledPlugin` (which carries live
 * `install`/`teardown` functions and arbitrary `options`) — a manifest exists
 * to be read and polled, so it stays JSON-shaped.
 */
export interface PluginManifestEntry {
  readonly name: string
  readonly version?: string
  readonly provides: readonly string[]
}

/**
 * The single machine-readable description of a live world (§6). Schema fields
 * answer "what *can* exist"; debug fields answer "what *does* exist right
 * now". All debug counts are O(1)/O(archetype) reads, never full scans, so
 * `world.describe()` is cheap enough to poll.
 */
export interface WorldManifest {
  // schema surface — composed from the describe* family
  readonly components: ComponentDescriptor[]
  readonly resources: ResourceDescriptor[]
  readonly events: { readonly name: string }[]
  readonly systems: {
    readonly name: string
    readonly schedule: SystemSchedule
    readonly enabled: boolean
  }[]
  readonly plugins: PluginManifestEntry[]
  readonly capabilities: string[]
  readonly snapshotVersion: number
  // debug-tooling necessaries (decided 2026-05-30)
  readonly entityCount: number
  readonly componentCounts: Record<string, number>
  readonly archetypes: { readonly components: string[]; readonly entityCount: number }[]
}
```

- [ ] **Step 6: Export the manifest types**

In `packages/domecs/src/index.ts`, add after the `./events.js` type export:

```typescript
export type { WorldManifest, PluginManifestEntry } from './manifest.js'
```

- [ ] **Step 7: Typecheck (no new test — types only)**

Run: `pnpm --filter @domecs/core typecheck`
Expected: PASS — no errors. (`manifest.ts` references only existing exported types.)

- [ ] **Step 8: Commit**

```bash
git add packages/domecs/src/manifest.ts packages/domecs/src/events.ts packages/domecs/src/index.ts packages/domecs/test/event-known-types.test.ts
git commit -m "feat(core): WorldManifest types + EventBus.knownTypes() (Phase 3 §6)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `world.describe(): WorldManifest`

**Files:**
- Modify: `packages/domecs/src/world.ts` (interface + impl: `describe`; imports)
- Test: `packages/domecs/test/describe-world.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/domecs/test/describe-world.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import { defineResource } from '../src/resource.js'
import { defineEvent } from '../src/events.js'
import { createWorld } from '../src/world.js'

const Position = defineComponent<{ x: number; y: number }>('Position', {
  defaults: { x: 0, y: 0 },
})
const Velocity = defineComponent<{ dx: number }>('Velocity', { defaults: { dx: 0 } })
const Score = defineResource<{ points: number }>('Score', { default: () => ({ points: 0 }) })
const Tick = defineEvent<void>('Tick')

describe('world.describe — composed manifest (§6)', () => {
  it('composes the describe* family and the static surface', () => {
    const w = createWorld()
    w.describeComponent(Position)
    w.describeResource(Score)
    w.on(Tick, () => {})
    w.system('mover', () => {}, { schedule: 'tick' })

    const m = w.describe()
    expect(m.components.map((c) => c.name)).toContain('Position')
    expect(m.resources.map((r) => r.name)).toContain('Score')
    expect(m.events.map((e) => e.name)).toContain('Tick')
    expect(m.systems.find((s) => s.name === 'mover')).toMatchObject({
      schedule: 'tick',
      enabled: true,
    })
    expect(typeof m.snapshotVersion).toBe('number')
    expect(Array.isArray(m.capabilities)).toBe(true)
    expect(Array.isArray(m.plugins)).toBe(true)
  })

  it('reports live debug counts: entityCount, componentCounts, archetypes', () => {
    const w = createWorld()
    w.spawn([[Position, { x: 1, y: 2 }]])
    w.spawn([[Position, { x: 3, y: 4 }], [Velocity, { dx: 1 }]])

    const m = w.describe()
    expect(m.entityCount).toBe(2)
    expect(m.componentCounts.Position).toBe(2)
    expect(m.componentCounts.Velocity).toBe(1)

    const archByKey = Object.fromEntries(
      m.archetypes.map((a) => [a.components.join('|'), a.entityCount]),
    )
    expect(archByKey.Position).toBe(1)
    expect(archByKey['Position|Velocity']).toBe(1)
  })

  it('is a snapshot — counts reflect the moment describe() was called', () => {
    const w = createWorld()
    const e = w.spawn([[Position, { x: 0, y: 0 }]])
    expect(w.describe().entityCount).toBe(1)
    w.despawn(e)
    expect(w.describe().entityCount).toBe(0)
  })
})
```

> **Note:** confirm `w.spawn`, `w.despawn`, `w.on`, and the `w.system(name, fn, def)` signatures against the current `World` interface; adjust the test's spawn/system calls to match (the shape of `spawn`/`system` is unchanged by this phase — use whatever the rest of `packages/domecs/test/` uses). The assertions on `m` are the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @domecs/core exec vitest run test/describe-world.test.ts`
Expected: FAIL — `w.describe is not a function`.

- [ ] **Step 3: Add imports + interface declaration**

In `packages/domecs/src/world.ts`:

(a) Add imports near the top (with the other local imports):

```typescript
import type { WorldManifest, PluginManifestEntry } from './manifest.js'
import { SNAPSHOT_VERSION } from './snapshot.js'
import type { SystemSchedule } from './scheduler.js'
```

(`SystemSchedule` may already be imported from `./scheduler.js`; if so, just add it to that group rather than duplicating. `SNAPSHOT_VERSION` is a value import.)

(b) Add to the `World` interface (after `describeEvent`, ~line 206):

```typescript
  /**
   * One machine-readable manifest of the whole live world: the schema surface
   * (components/resources/events/systems/plugins/capabilities/snapshotVersion)
   * plus live debug counts (entityCount/componentCounts/archetypes). All
   * counts are O(1)/O(archetype) reads — cheap enough to poll.
   */
  describe(): WorldManifest
```

- [ ] **Step 4: Add the `describe()` implementation**

In the `const world: World = { … }` literal, after `describeEvent` (~line 1245). **Substitute the confirmed event-bus local (`bus`) and plugin-registry local (`plugins`) names** per the File-Structure note:

```typescript
    describe(): WorldManifest {
      const components = world.componentTypes().map((t) => world.describeComponent(t))
      const resources = world.resourceTypes().map((t) => world.describeResource(t))
      const events = bus.knownTypes().map((t) => ({ name: t.name }))

      const modes: SystemSchedule[] = ['tick', 'fixed', 'event', 'once', 'reactive']
      const systems = modes.flatMap((mode) =>
        scheduler.systemsByMode(mode).map((s) => ({
          name: s.name,
          schedule: s.schedule,
          enabled: s.enabled,
        })),
      )

      const installed = plugins.list()
      const pluginEntries: PluginManifestEntry[] = installed.map((e) => ({
        name: e.plugin.name,
        ...(e.plugin.version !== undefined ? { version: e.plugin.version } : {}),
        provides: e.plugin.provides ?? [],
      }))
      const capabilities = Array.from(
        new Set(installed.flatMap((e) => e.plugin.provides ?? [])),
      ).sort()

      const componentCounts: Record<string, number> = {}
      for (const [name, store] of stores) componentCounts[name] = store.size

      const archetypeList = Array.from(archetypes.values()).map((b) => ({
        components: Array.from(b.types).sort(),
        entityCount: b.entities.size,
      }))

      return {
        components,
        resources,
        events,
        systems,
        plugins: pluginEntries,
        capabilities,
        snapshotVersion: SNAPSHOT_VERSION,
        entityCount: alive.size,
        componentCounts,
        archetypes: archetypeList,
      }
    },
```

(`stores`, `archetypes`, `alive`, `scheduler` are all in the impl scope per `world.ts:432`/`:437`/`:430`/`:752`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @domecs/core exec vitest run test/describe-world.test.ts`
Expected: PASS (3/3).

- [ ] **Step 6: Run the full core suite (no regressions)**

Run: `pnpm --filter @domecs/core test`
Expected: all green (prior 234 + the new resource/event/known-types/world tests).

- [ ] **Step 7: Commit**

```bash
git add packages/domecs/src/world.ts packages/domecs/test/describe-world.test.ts
git commit -m "feat(core): world.describe() composed WorldManifest with O(1)/O(archetype) counts (Phase 3 §6)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Inspector — `InspectorView.export(): InspectorSnapshot`

**Files:**
- Modify: `packages/domecs-inspector/src/inspector.ts` (`InspectorSnapshot` type + `export()` on interface and view factory)
- Modify: `packages/domecs-inspector/src/index.ts` (export `InspectorSnapshot`)
- Test: `packages/domecs-inspector/test/export.test.ts` (create — match the directory's existing test layout)

> **Before coding, read `packages/domecs-inspector/src/inspector.ts`** to see how the `InspectorView` object is constructed (the factory that exposes `entries`/`systemic`/`entityScoped`/`timeline`). `export()` must be added to BOTH the `InspectorView` interface (`:63–78`) and that factory.

- [ ] **Step 1: Write the failing test**

Create `packages/domecs-inspector/test/export.test.ts` (adapt imports/setup to mirror an existing inspector test in that folder — e.g. how it builds a world, installs the inspector plugin via `world.use`, and provokes a fault to populate entries):

```typescript
import { describe, expect, it } from 'vitest'
import { createInspector } from '../src/index.js'
// ...import createWorld + whatever an existing inspector test uses to record an entry

describe('InspectorView.export — serializable snapshot', () => {
  it('returns a plain-object snapshot with copies of the live arrays', () => {
    const { plugin, view } = createInspector()
    // install on a world and produce at least one entry + timeline event,
    // mirroring the setup in the sibling inspector test.

    const snap = view.export()
    expect(snap).toHaveProperty('entries')
    expect(snap).toHaveProperty('systemic')
    expect(snap).toHaveProperty('entityScoped')
    expect(snap).toHaveProperty('timeline')
    // copies, not the live references
    expect(snap.entries).not.toBe(view.entries)
    expect(Array.isArray(snap.entries)).toBe(true)
    expect(Array.isArray(snap.timeline)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @domecs/inspector exec vitest run test/export.test.ts`
Expected: FAIL — `view.export is not a function`.

- [ ] **Step 3: Add the `InspectorSnapshot` type**

In `packages/domecs-inspector/src/inspector.ts`, near the `InspectorView` interface:

```typescript
/**
 * A point-in-time, serializable copy of an {@link InspectorView}: the fault
 * buckets and the timeline as plain arrays. Unlike the live view (whose arrays
 * mutate as the world runs), a snapshot is safe to hand to an agent or persist.
 */
export interface InspectorSnapshot {
  readonly entries: InspectorEntry[]
  readonly systemic: InspectorEntry[]
  readonly entityScoped: InspectorEntry[]
  readonly timeline: TimelineEvent[]
}
```

- [ ] **Step 4: Add `export()` to the interface + factory**

(a) In the `InspectorView` interface (`:63–78`), add:

```typescript
  /** Point-in-time serializable copy of this view (fault buckets + timeline). */
  export(): InspectorSnapshot
```

(b) In the view factory object, add (using the same names the factory uses for its live arrays):

```typescript
    export(): InspectorSnapshot {
      return {
        entries: [...this.entries],
        systemic: [...this.systemic],
        entityScoped: [...this.entityScoped],
        timeline: [...this.timeline],
      }
    },
```

> If the factory closes over local arrays rather than exposing them via `this`, copy from those locals instead (`[...entries]`, etc.). The contract: each field is a fresh array, never the live reference.

- [ ] **Step 5: Export `InspectorSnapshot`**

In `packages/domecs-inspector/src/index.ts`, add `type InspectorSnapshot` to the existing export block (lines 11–19):

```typescript
  type InspectorSnapshot,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @domecs/inspector exec vitest run test/export.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the inspector suite (no regressions)**

Run: `pnpm --filter @domecs/inspector test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add packages/domecs-inspector/src/inspector.ts packages/domecs-inspector/src/index.ts packages/domecs-inspector/test/export.test.ts
git commit -m "feat(inspector): InspectorView.export() -> serializable InspectorSnapshot (Phase 3 §6)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Surface regen + no-drift, LEGIBILITY L2 flip, full gate

**Files:**
- Regenerate: `doc/api-surface/core.d.ts`, `doc/api-surface/inspector.d.ts`
- Modify: `doc/LEGIBILITY.md` (L2)

- [ ] **Step 1: Build + regenerate the API surface**

Run:
```bash
pnpm -r build
pnpm api:surface
git diff --stat -- doc/api-surface
```
Expected diff: `core.d.ts` gains `describeResource`/`describeEvent`/`describe` on `World` and the new exported types `ResourceDescriptor`, `EventDescriptor`, `EventDefOptions`, `WorldManifest`, `PluginManifestEntry`; `inspector.d.ts` gains `InspectorSnapshot` + `export()`. `dom`/`input`/`persist` unchanged. (Recall the surface diff is barrel/name-level; the added `World` methods show only as the changed `World` type block — that's expected.)

- [ ] **Step 2: Flip LEGIBILITY L2 (`describe*` half)**

In `doc/LEGIBILITY.md`, change the L2 header marker from ⏳ to ✅:

```markdown
## L2 — Self-describing schemas and errors are first-class ✅
```

And rewrite the **Enforcement status** paragraph (currently "the `describe*` family + `world.describe()` land in Phase 3; the error half shipped…") to:

```markdown
**Enforcement status:** shipped in full. The error half shipped in the v1.0 break
(Phase 2) — every `DomecsError` carries `retryable`, plus `getErrorRepairHint`,
`ERROR_KINDS`, and `isKnownDomecsErrorKind`. The `describe*` family
(`describeComponent`/`describeResource`/`describeEvent`) and the composing root
`world.describe(): WorldManifest` shipped in Phase 3. Every new descriptor kind
must be reachable through this typed surface, not an ad-hoc field reach-in.
```

Also update the **Enforcement legend** at the top (line ~12–15) so L2 is listed among the shipped laws rather than the ⏳ set, if it enumerates them.

- [ ] **Step 3: Commit surface + docs**

```bash
git add doc/api-surface doc/LEGIBILITY.md
git commit -m "docs(legibility): regen surface + flip L2 describe* family to shipped (Phase 3)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Full release gate (must be green)**

Run from `C:\dev\HyperNova\domecs`:
```bash
pnpm -r --parallel typecheck
pnpm -r build
pnpm api:surface
git diff --exit-code -- doc/api-surface   # no-drift gate: must be clean (already committed in Step 3)
pnpm -r --parallel test
pnpm api:check
```
Expected: typecheck 5/5; build OK; surface drift clean; all package tests green (core 234 + new Phase-3 tests, inspector + new export test, others unchanged); `pnpm api:check` 2/2 pass.

- [ ] **Step 5: Verify no consumer breakage (additive guarantee)**

Phase 3 is purely additive, so the 8 consumer apps on their `domecs-v1-migration` branches must still typecheck against the live engine source. Spot-check the two heaviest:
```bash
cd C:/dev/HyperNova/railroad_game && npm run typecheck
cd C:/dev/HyperNova/dashboard && npm run typecheck
```
Expected: 0 errors (no API was removed or renamed).

---

## Self-Review

**1. Spec coverage (§6):**
- Component reflection — shipped Phase 2 (noted, not re-done). ✅
- Resource: `resourceTypes()` + `describeResource(): {name, hasValue, hasDefault}` + export — **Task 1**. ✅
- Error half — shipped Phase 2 (noted). ✅
- Event: `defineEvent(name,{schema?})` reusing `FieldSchema` vocab + `describeEvent()` — **Task 2**. ✅ (define→emit→subscribe→tick-delay *doctest* belongs to Phase 4 snippet-CI per §7/§8; the reflection behavior is tested here.)
- Root: `world.describe(): WorldManifest` composing the family + `entityCount`/`componentCounts`/`archetypes` O(1)/O(archetype) — **Tasks 3+4**. ✅
- Inspector `export()` — **Task 5**. ✅
- "Remove `InternalComponentType` from barrel" — already absent (Phase 2 Task 10), nothing to do. ✅
- "Document `PluginRegistry`/`InstalledPlugin` in `api.md`" — this is `api.md` prose, folded into the **Phase 4** `api.md` sync (§7), not Phase 3 code. (Flag.)

**2. Placeholder scan:** No "TBD"/"handle edge cases"/uncoded steps. Two explicit *confirm-the-local-name* instructions (event-bus & plugin-registry vars in `world.ts`; inspector view factory's array source) — these are real lookups with the search terms given, not vague placeholders. The `describe-world.test.ts` spawn/system calls carry a confirm-signature note because those APIs are out of this phase's scope.

**3. Type consistency:** `ResourceDescriptor {name,hasValue,hasDefault}` defined Task 1, consumed in `WorldManifest.resources` Task 3 + `describe()` Task 4 — consistent. `EventDescriptor {name,fields,fieldsSource:'schema'|'none'}` Task 2, not embedded in the manifest (manifest `events` is `{name}[]` per spec) — intentional. `WorldManifest`/`PluginManifestEntry` defined Task 3, implemented Task 4 — field names match (`components`, `resources`, `events`, `systems`, `plugins`, `capabilities`, `snapshotVersion`, `entityCount`, `componentCounts`, `archetypes`). `SystemSchedule` reused from `scheduler.ts` (not redefined). `knownTypes()` defined Task 3, consumed Task 4.

**Gaps found & resolved:** none requiring new tasks. One scope clarification logged: `api.md` plugin docs → Phase 4.
