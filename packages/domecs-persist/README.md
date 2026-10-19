# @domecs/persist

Result-typed save / load / migrate over `WorldSnapshot` for DOMECS.

Every seam returns a `Result<…, DomecsError>` — I/O failures surface as
`persist_io` and version upgrades as `migration_failed`, never as thrown
exceptions. A failed save or migration leaves the target slot's prior bytes
intact. See `doc/BETTER_ERRORS.md` Phase 2 for the discipline this enforces.

> Status: v2.x — **API-stable** (semver honored; corrective patches ship as
> 2.0.x, additive surface like `loadIfPresent` ships as minor releases).

## Install

```bash
npm install @domecs/persist
```

## Quick start

```ts
import { createWorld, defineComponent, entry } from '@domecs/core'
import { save, load, loadIfPresent, createMemoryStorage } from '@domecs/persist'

const Health = defineComponent<{ hp: number }>('Health', { defaults: { hp: 10 } })

const storage = createMemoryStorage()
const world = createWorld()
world.spawn([entry(Health, { hp: 7 })])

// Stamps `savedAt` into the snapshot envelope; merge extra metadata via opts.
const saved = save(world, storage, 'slot-1', { meta: { label: 'checkpoint' } })
if (!saved.ok) console.error(saved.error)

const restored = createWorld()
// Boot path: missing slot is ok(false), not an error.
const boot = loadIfPresent(restored, storage, 'slot-1')
if (!boot.ok) console.error(boot.error)
else if (!boot.value) { /* first run */ }
// Strict path still available: load() returns persist_io on empty slots.
```

## Main API

- `save(world, storage, slot, opts?)` — serialize a snapshot; `opts.meta` is
  merged into the envelope and a numeric `savedAt` is stamped.
- `load(world, storage, slot, opts?)` — parse, migrate to `targetVersion`
  (default `SNAPSHOT_VERSION`), then restore. `opts.migrations` is overlaid on
  `BUILTIN_MIGRATIONS` (caller keys win), so legacy v1 and v2 (2.0) saves
  upgrade transparently with no caller config. Empty slots return `persist_io` with
  `retryable: false` (message includes `empty`).
- `loadIfPresent(world, storage, slot, opts?)` — boot-friendly (O-28):
  `ok(true)` loaded, `ok(false)` missing slot, `err(...)` for real failures.
  Prefer this for first-run restore paths.
- `createMemoryStorage(initial?)` — in-memory `Storage` adapter (tests, SSR).
- `createLocalStorageStorage(prefix?)` — browser `localStorage` adapter
  (default prefix `'domecs:'`); resolves the backing store lazily from
  `globalThis`, so it is safe to import in headless/Node hosts.
- `migrate(snapshot, target, migrations)` — run a version migration chain.
- `BUILTIN_MIGRATIONS` — framework-supplied steps applied as the floor beneath
  any caller chain. Ships the `1 → 2` resources bump (a v1 snapshot simply
  lacks `resources`) and, from 2.1, the `2 → 3` bump (a v2 snapshot simply
  lacks `rngRoot`, `rngStreams` and `pendingEvents`); both are pure version
  bumps. A loaded v2 save uses the world's `createWorld` root and re-derives every
  `rng: 'own'` stream. `save()` writes v3, which 2.0 engines reject.
- `withBuiltinMigrations(user?)` — overlay a caller `MigrationMap` on the
  built-ins (caller keys win); returns the built-ins unchanged when `user` is
  empty. `load()` uses this internally.
- Transient resources (`defineResource(name, { transient: true })`, core 2.3,
  O-36) are never written by `save()` or kept by `createSnapshotHistory`, and
  `load()` / `undo()` keep their live values — a camera or HUD cache is not
  restored over freshly derived state. A save written before a resource was
  declared transient still loads; its stale value is ignored.
- `pruneTransientOnlyEntities()` — plugin; install once to strip
  transient-only / bare entities from every saved envelope (the persisted-path
  equivalent of core's `snapshot({ pruneEmptyEntities: true })`). It hooks
  every `world.snapshot()`, so history snapshots are pruned too, and an undo
  despawns those entities. Entities other entities point at (a scene `Parent`
  group, a target id) need a persistent component of their own.
- `createSnapshotHistory(world, opts?)` — bounded undo/redo ring over
  snapshots: `push` / `undo` / `redo` / `canUndo` / `canRedo` / `clear`, with
  redo-branch truncation, a `limit` ring, and `toJSON` / `load` for export.
- `diffSnapshots(prev, next, options?)` — entity-level diff (added / removed /
  changed, compared as data so key order is ignored). With `{ fields: true }`
  it also lists `componentsAdded` / `componentsRemoved`, `fieldChanges`
  (`{ entity, component, path: "inv.items[2].qty", before, after }`) and
  `resourceChanges`, in ascending entity id, sorted component name and key;
  `epsilon` (absolute) for numbers, `components` to restrict, `limit` (default
  10 000) with `truncated`.
- `firstDivergence(a, b)` — the first difference in canonical order (state
  fields, including in-flight `pendingEvents`, then the lowest entity id, then
  resources), or `null`. `save()` and `createSnapshotHistory` take default
  snapshots, which carry no pending events.
- `createMemoryStorage()` — in-memory `Storage` for tests/non-persistent use.
- `serializeComponentType(type, world.describeComponent(type))` /
  `registerComponentTypes(data, reserved)` — persist user-authored component
  types (`ComponentTypeData`) and rebuild them; every `FieldSchema` key
  round-trips, `description` included. `registerComponentTypes` never throws:
  defects come back as `SchemaProblem`s.
- Types: `SaveOptions`, `LoadOptions`, `Migration`, `MigrationMap`,
  `MigrationFailedError`, `Storage`, `SnapshotHistory`,
  `SnapshotHistoryOptions`, `SnapshotDiff`, `SnapshotDiffOptions`,
  `FieldChange`, `ResourceChange`, `Divergence`, `ComponentTypeData`,
  `ComponentFieldData`, `SchemaProblem`.

## Related packages

- `@domecs/core` — provides `world.snapshot()` / `world.restore()`.

## License

MIT
