# @domecs/persist

Result-typed save / load / migrate over `WorldSnapshot` for DOMECS.

Every seam returns a `Result<…, DomecsError>` — I/O failures surface as
`persist_io` and version upgrades as `migration_failed`, never as thrown
exceptions. A failed save or migration leaves the target slot's prior bytes
intact. See `doc/BETTER_ERRORS.md` Phase 2 for the discipline this enforces.

> Status: early alpha.

## Install

```bash
npm install @domecs/persist
```

## Quick start

```ts
import { createWorld, defineComponent, entry } from '@domecs/core'
import { save, load, createMemoryStorage } from '@domecs/persist'

const Health = defineComponent<{ hp: number }>('Health', { defaults: { hp: 10 } })

const storage = createMemoryStorage()
const world = createWorld()
world.spawn([entry(Health, { hp: 7 })])

// Stamps `savedAt` into the snapshot envelope; merge extra metadata via opts.
const saved = save(world, storage, 'slot-1', { meta: { label: 'checkpoint' } })
if (!saved.ok) console.error(saved.error)

const restored = createWorld()
const loaded = load(restored, storage, 'slot-1')
if (!loaded.ok) console.error(loaded.error)
```

## Main API

- `save(world, storage, slot, opts?)` — serialize a snapshot; `opts.meta` is
  merged into the envelope and a numeric `savedAt` is stamped.
- `load(world, storage, slot, opts?)` — parse, migrate to `targetVersion`
  (default `SNAPSHOT_VERSION`), then restore. `opts.migrations` is overlaid on
  `BUILTIN_MIGRATIONS` (caller keys win), so a legacy v1 save upgrades
  transparently with no caller config.
- `migrate(snapshot, target, migrations)` — run a version migration chain.
- `BUILTIN_MIGRATIONS` — framework-supplied steps applied as the floor beneath
  any caller chain. Ships the `1 → 2` resources bump (a v1 snapshot simply
  lacks `resources`, so the step is a pure version bump).
- `withBuiltinMigrations(user?)` — overlay a caller `MigrationMap` on the
  built-ins (caller keys win); returns the built-ins unchanged when `user` is
  empty. `load()` uses this internally.
- `pruneTransientOnlyEntities()` — plugin; install once to strip
  transient-only / bare entities from every saved envelope (the persisted-path
  equivalent of core's `snapshot({ pruneEmptyEntities: true })`).
- `createSnapshotHistory(world, opts?)` — bounded undo/redo ring over
  snapshots: `push` / `undo` / `redo` / `canUndo` / `canRedo` / `clear`, with
  redo-branch truncation, a `limit` ring, and `toJSON` / `load` for export.
- `diffSnapshots(prev, next)` — entity-level diff (added / removed / changed).
- `createMemoryStorage()` — in-memory `Storage` for tests/non-persistent use.
- Types: `SaveOptions`, `LoadOptions`, `Migration`, `MigrationMap`,
  `MigrationFailedError`, `Storage`, `SnapshotHistory`,
  `SnapshotHistoryOptions`, `SnapshotDiff`.

## Related packages

- `@domecs/core` — provides `world.snapshot()` / `world.restore()`.

## License

MIT
