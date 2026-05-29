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
- `load(world, storage, slot, opts?)` — parse, migrate to `targetVersion`,
  then restore.
- `migrate(snapshot, target, migrations)` — run a version migration chain.
- `pruneTransientOnlyEntities()` — plugin; install once to strip
  transient-only / bare entities from every saved envelope (the persisted-path
  equivalent of core's `snapshot({ pruneEmptyEntities: true })`).
- `createMemoryStorage()` — in-memory `Storage` for tests/non-persistent use.
- Types: `SaveOptions`, `LoadOptions`, `Migration`, `MigrationMap`, `Storage`.

## Related packages

- `@domecs/core` — provides `world.snapshot()` / `world.restore()`.

## License

MIT
