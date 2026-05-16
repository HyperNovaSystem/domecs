/**
 * @domecs/persist — Result-typed save / load / migrate over WorldSnapshot.
 * See doc/BETTER_ERRORS.md Phase 2 for the discipline this enforces.
 */
export { load, save, type LoadOptions } from './persist.js'
export {
  migrate,
  type Migration,
  type MigrationFailedError,
  type MigrationMap,
} from './migrate.js'
export { createMemoryStorage, type Storage } from './storage.js'
