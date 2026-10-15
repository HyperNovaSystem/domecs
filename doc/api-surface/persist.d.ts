// file: history.d.ts
import type { DomecsError, Entity, Result, World, WorldSnapshot } from '@domecs/core';
export interface SnapshotHistoryOptions {
    /**
     * Maximum number of checkpoints retained. Once exceeded, the oldest are
     * dropped (a ring). Default `50`. Must be `>= 1`.
     */
    limit?: number;
    /**
     * Capture the world's current state as the initial checkpoint at creation,
     * so `undo()` has a baseline to return to. Default `true`.
     */
    captureInitial?: boolean;
}
/**
 * Undo/redo ring over `WorldSnapshot`s. `push()` records the current world as
 * a checkpoint; `undo()`/`redo()` move a cursor through the ring and
 * `world.restore()` the checkpoint there. Pushing after an undo truncates the
 * orphaned redo branch (standard linear-history semantics). Bounded by
 * `limit`; serializable via `toJSON()` / `load()`.
 */
export interface SnapshotHistory {
    /** Snapshot the world and append it as the new current checkpoint. */
    push(): void;
    /** Restore the previous checkpoint. Returns `false` at the oldest. */
    undo(): boolean;
    /** Restore the next checkpoint. Returns `false` at the newest. */
    redo(): boolean;
    canUndo(): boolean;
    canRedo(): boolean;
    /** Drop every checkpoint; `length` becomes 0. */
    clear(): void;
    /** Number of checkpoints currently retained. */
    readonly length: number;
    /** Cursor: index of the current checkpoint, or `-1` when empty. */
    readonly index: number;
    /** The retained checkpoints, oldest-first. */
    snapshots(): readonly WorldSnapshot[];
    /** The checkpoint at the cursor, or `undefined` when empty. */
    current(): WorldSnapshot | undefined;
    /** Serialize the ring (+cursor) to JSON. */
    toJSON(): string;
    /**
     * Replace the ring from a {@link toJSON} payload and restore the world to
     * the saved cursor. `persist_io` on malformed input; the existing history
     * and world are left untouched on failure.
     */
    load(json: string): Result<void, DomecsError>;
}
export declare function createSnapshotHistory(world: World, opts?: SnapshotHistoryOptions): SnapshotHistory;
export interface SnapshotDiff {
    /** Entity ids present in `next` but not `prev`. */
    readonly addedEntities: readonly Entity[];
    /** Entity ids present in `prev` but not `next`. */
    readonly removedEntities: readonly Entity[];
    /** Entity ids in both whose component bag differs (shallow JSON equality). */
    readonly changedEntities: readonly Entity[];
}
/**
 * Entity-level diff between two snapshots. `changedEntities` compares each
 * shared entity's component bag by JSON equality — snapshots are JSON-shaped
 * and per-entity key order is archetype-deterministic, so value or
 * composition changes both register. Useful for history timelines / undo UIs.
 */
export declare function diffSnapshots(prev: WorldSnapshot, next: WorldSnapshot): SnapshotDiff;

// file: index.d.ts
/**
 * @domecs/persist — Result-typed save / load / migrate over WorldSnapshot.
 * See doc/BETTER_ERRORS.md Phase 2 for the discipline this enforces.
 */
export { load, loadIfPresent, pruneTransientOnlyEntities, save, type LoadOptions, type SaveOptions, } from './persist.js';
export { migrate, BUILTIN_MIGRATIONS, withBuiltinMigrations, type Migration, type MigrationFailedError, type MigrationMap, } from './migrate.js';
export { createLocalStorageStorage, createMemoryStorage, type Storage } from './storage.js';
export { createSnapshotHistory, diffSnapshots, type SnapshotHistory, type SnapshotHistoryOptions, type SnapshotDiff, } from './history.js';
export { registerComponentTypes, serializeComponentType, type ComponentFieldData, type ComponentTypeData, type SchemaProblem, } from './schema.js';

// file: migrate.d.ts
import type { DomecsError, Result, WorldSnapshot } from '@domecs/core';
export type MigrationFailedError = Extract<DomecsError, {
    kind: 'migration_failed';
}>;
/**
 * A single-step migration: takes a snapshot at version `from` and returns
 * one at `from + 1`. Returning `err` halts the chain — the framework
 * propagates a `migration_failed` Result to the caller without touching
 * the original slot bytes.
 */
export type Migration = (snap: WorldSnapshot) => Result<WorldSnapshot, MigrationFailedError>;
/** Keyed by the source version. `migrations.get(N)` returns the N → N+1 step. */
export type MigrationMap = ReadonlyMap<number, Migration>;
/**
 * Framework-supplied migration steps, applied as the floor beneath any
 * user-supplied chain in {@link load} (user keys win on collision).
 *
 * - `1 → 2`: resources were added to `WorldSnapshot` at v2. A v1
 *   snapshot simply lacks them, so the step is a pure version bump —
 *   `world.restore` treats the absent `resources` as an empty set.
 */
export declare const BUILTIN_MIGRATIONS: MigrationMap;
/**
 * Overlay `user` migrations on top of {@link BUILTIN_MIGRATIONS} so framework
 * version bumps load transparently while letting callers override or extend
 * any step. Returns the built-ins unchanged when `user` is empty.
 */
export declare function withBuiltinMigrations(user?: MigrationMap): MigrationMap;
/**
 * Applies the chain starting at `snap.version` until reaching
 * `targetVersion`. Hard-fail by default; partial loads are an explicit
 * userland recovery flow built on top of this primitive.
 *
 * Failure semantics: when a step fails, the returned `Result.err` carries
 * the `from`/`to` versions of the failing step. The caller (typically
 * {@link load}) must not write the partially-migrated snapshot back to
 * storage — the source bytes stay intact for inspection or recovery.
 *
 * Defensive guard: a migration that returns a snapshot whose version is
 * not strictly greater than the input would loop forever; this is caught
 * and reported as a non-recoverable `migration_failed`.
 */
export declare function migrate(snap: WorldSnapshot, targetVersion: number, migrations: MigrationMap): Result<WorldSnapshot, MigrationFailedError>;

// file: persist.d.ts
import type { DomecsError, Plugin, Result, World } from '@domecs/core';
import { type MigrationMap } from './migrate.js';
import type { Storage } from './storage.js';
export interface LoadOptions {
    /** Target version to migrate the snapshot to. Defaults to {@link SNAPSHOT_VERSION}. */
    targetVersion?: number;
    /**
     * Migration chain keyed by source version, overlaid on the framework's
     * {@link BUILTIN_MIGRATIONS} (caller keys win). Defaults to just the
     * built-ins, so e.g. a legacy v1 save upgrades to the current version
     * transparently.
     */
    migrations?: MigrationMap;
}
export interface SaveOptions {
    /**
     * Extra metadata merged into the snapshot envelope's `meta`. Sits on top
     * of any plugin-provided `meta` (from `onSnapshot`) and below the
     * auto-stamped `savedAt`, so a caller key wins over a plugin key.
     */
    meta?: Record<string, unknown>;
    /**
     * Override the `savedAt` timestamp (ms epoch) written into `meta`.
     * Defaults to `Date.now()`. Provided primarily for deterministic tests.
     */
    savedAt?: number;
}
/**
 * Captures `world.snapshot()`, serializes to JSON, and writes to `slot`.
 * Failures (non-serializable components, I/O) come back as `persist_io`
 * with the cause normalized via `normalizeCause`. The slot is only
 * touched when serialization succeeded — a serialization failure leaves
 * any prior contents intact.
 *
 * The optional `opts` populate the snapshot envelope's `meta`: a numeric
 * `savedAt` is always stamped (override via `opts.savedAt`) and `opts.meta`
 * keys are merged in. Three-argument callers are unaffected. The envelope is
 * `{ savedAt, ...snapshot.meta, ...opts.meta }` so a caller key overrides a
 * plugin-provided one, while `savedAt` is the default floor.
 */
export declare function save(world: World, storage: Storage, slot: string, opts?: SaveOptions): Result<void, DomecsError>;
/**
 * Reads `slot`, parses it as a `WorldSnapshot`, migrates to
 * `targetVersion` (default {@link SNAPSHOT_VERSION}), then calls
 * `world.restore`. The slot bytes are read-only here — even when
 * migration fails, the original snapshot remains intact for inspection
 * or userland recovery flows.
 *
 * Errors:
 * - `persist_io`: missing slot, malformed JSON, non-snapshot payload, or
 *   a `world.restore` throw. Empty slots use `retryable: false` (first-run
 *   is deterministic until something is saved). Prefer
 *   {@link loadIfPresent} for boot paths where "no save yet" is normal.
 * - `migration_failed`: any step in the chain to `targetVersion` fails.
 */
export declare function load(world: World, storage: Storage, slot: string, opts?: LoadOptions): Result<void, DomecsError>;
/**
 * Boot-friendly load (O-28): missing slot is success with `false`, not an
 * error. Real I/O / parse / migration / restore failures remain `err(...)`.
 *
 * - `ok(true)` — snapshot was loaded and restored
 * - `ok(false)` — slot was empty (first run); world is untouched
 * - `err(...)` — storage/read/parse/migrate/restore failure
 */
export declare function loadIfPresent(world: World, storage: Storage, slot: string, opts?: LoadOptions): Result<boolean, DomecsError>;
/**
 * Plugin that strips entities with an empty serializable component bag from
 * every `world.snapshot()` envelope via `onSnapshot`. Because `save()` calls
 * the no-arg `world.snapshot()`, this is the declarative way to get the core
 * `snapshot({ pruneEmptyEntities: true })` behavior on the persisted path:
 * transient-only entities (their components are excluded at snapshot time) and
 * bare `spawn()` entities never reach disk. Install once per world. Entities
 * that still carry any persistent component are untouched.
 *
 * The hook runs on every `world.snapshot()`, not just `save()`: a
 * `createSnapshotHistory` undo restores a snapshot without the pruned
 * entities, so they are despawned. An entity that others refer to by id —
 * an `@domecs/scene` `Parent` group, say — needs a persistent component of
 * its own, or its references dangle (O-61).
 */
export declare function pruneTransientOnlyEntities(): Plugin;

// file: schema.d.ts
import type { ComponentDescriptor, ComponentType, FieldKind } from '@domecs/core';
/**
 * A single defect found while turning persisted `ComponentTypeData` back
 * into live `ComponentType`s. Never thrown — always collected and returned
 * alongside whatever *did* register successfully (M0: user-authored
 * component types must degrade gracefully, not abort a whole document load).
 */
export interface SchemaProblem {
    path: string;
    message: string;
}
/** One field of a serialized component type — the persisted form of `FieldSchema` plus its default. */
export interface ComponentFieldData {
    name: string;
    kind: FieldKind;
    default?: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: (string | number)[];
    label?: string;
    readonly?: boolean;
}
/** The persisted, document-embeddable form of a `ComponentType` + its `ComponentDescriptor`. */
export interface ComponentTypeData {
    name: string;
    transient?: boolean;
    fields: ComponentFieldData[];
}
/**
 * Pure projection of a `ComponentType`'s reflection data (as obtained from
 * `world.describeComponent(type)`) into the persisted `ComponentTypeData`
 * shape. No `World` import here — the caller owns fetching the descriptor,
 * this function only reshapes it.
 *
 * Output is kept minimal: `transient` is included only when `true`, and
 * each field only carries the optional keys its `FieldSchema` / default
 * actually declared.
 */
export declare function serializeComponentType(type: ComponentType<unknown>, descriptor: ComponentDescriptor): ComponentTypeData;
/**
 * Rebuilds live `ComponentType`s from persisted `ComponentTypeData`, e.g.
 * user-authored component types loaded from a document. Never throws:
 * every defect (a name colliding with a `reserved` built-in, a duplicate
 * name within `data`, or a field with an unrecognized `kind`) is reported
 * as a {@link SchemaProblem} and the offending entry/field is skipped
 * rather than dropping data silently or aborting the whole batch.
 *
 * - A `data[i].name` in `reserved` skips the whole entry (no shadowing a
 *   built-in component type).
 * - A `data[i].name` repeated earlier in `data` skips the second (and any
 *   later) occurrence.
 * - A field whose `kind` isn't a known `FieldKind` skips just that field;
 *   the type is still registered with its remaining valid fields.
 * - Malformed input — `data` not an array, an entry without a string
 *   `name` or a `fields` array, a field without a string `name` — skips
 *   that entry or field (O-63).
 * - A field named `__proto__`, or repeating an earlier field's name, is
 *   skipped; a `default` that does not fit the field's kind (or enum
 *   `options`) is dropped, keeping the field.
 */
export declare function registerComponentTypes(data: ComponentTypeData[], reserved: ReadonlySet<string>): {
    types: ComponentType<unknown>[];
    problems: SchemaProblem[];
};

// file: storage.d.ts
import type { DomecsError, Result } from '@domecs/core';
/**
 * Slot-keyed text storage. Every operation returns a `Result`; concrete
 * adapters (filesystem, IndexedDB, localStorage, network) catch thrown
 * I/O errors at the boundary and convert them to `persist_io` via
 * `normalizeCause`. A missing slot is `ok(null)` — not an error.
 */
export interface Storage {
    read(slot: string): Result<string | null, DomecsError>;
    write(slot: string, data: string): Result<void, DomecsError>;
    remove(slot: string): Result<void, DomecsError>;
    list(): Result<readonly string[], DomecsError>;
}
/**
 * Browser `localStorage` adapter. Slots are namespaced as `prefix + slot`
 * (default prefix `'domecs:'`). The backing store is resolved lazily from
 * `globalThis` on each operation, so importing this module is safe in
 * headless/Node hosts; every operation catches at the I/O boundary (missing
 * `localStorage`, privacy mode, quota exceeded) and returns `persist_io`.
 */
export declare function createLocalStorageStorage(prefix?: string): Storage;
/** In-memory adapter for tests and ephemeral sessions. */
export declare function createMemoryStorage(initial?: Readonly<Record<string, string>>): Storage;
