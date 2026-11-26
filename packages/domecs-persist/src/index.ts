/**
 * @domecs/persist — Result-typed save / load / migrate over WorldSnapshot.
 * See doc/BETTER_ERRORS.md Phase 2 for the discipline this enforces.
 */
export {
  decodeSave,
  encodeSave,
  load,
  loadIfPresent,
  peek,
  prepareSave,
  pruneTransientOnlyEntities,
  save,
  type DecodeOptions,
  type LoadOptions,
  type SaveHeader,
  type SaveOptions,
  type SaveReport,
} from './persist.js'
export { columnarCodec, jsonCodec, type SnapshotCodec } from './codecs.js'
export {
  migrate,
  BUILTIN_MIGRATIONS,
  withBuiltinMigrations,
  type Migration,
  type MigrationFailedError,
  type MigrationMap,
} from './migrate.js'
export { createLocalStorageStorage, createMemoryStorage, type Storage } from './storage.js'
export {
  createSnapshotHistory,
  diffSnapshots,
  firstDivergence,
  type SnapshotHistory,
  type SnapshotHistoryOptions,
  type SnapshotDiff,
  type SnapshotDiffOptions,
  type FieldChange,
  type ResourceChange,
  type Divergence,
} from './history.js'
export {
  registerComponentTypes,
  serializeComponentType,
  type ComponentFieldData,
  type ComponentTypeData,
  type SchemaProblem,
} from './schema.js'
export { BUILD_ID } from './build-id.js'
