/**
 * @domecs/persist — Result-typed save / load / migrate over WorldSnapshot.
 * See doc/BETTER_ERRORS.md Phase 2 for the discipline this enforces.
 */
export { load, pruneTransientOnlyEntities, save, type LoadOptions, type SaveOptions, } from './persist.js';
export { migrate, BUILTIN_MIGRATIONS, withBuiltinMigrations, type Migration, type MigrationFailedError, type MigrationMap, } from './migrate.js';
export { createLocalStorageStorage, createMemoryStorage, type Storage } from './storage.js';
export { createSnapshotHistory, diffSnapshots, type SnapshotHistory, type SnapshotHistoryOptions, type SnapshotDiff, } from './history.js';
