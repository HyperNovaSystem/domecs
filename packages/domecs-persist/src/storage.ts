import type { DomecsError, Result } from '@domecs/core'
import { ok } from '@domecs/core'

/**
 * Slot-keyed text storage. Every operation returns a `Result`; concrete
 * adapters (filesystem, IndexedDB, localStorage, network) catch thrown
 * I/O errors at the boundary and convert them to `persist_io` via
 * `normalizeCause`. A missing slot is `ok(null)` — not an error.
 */
export interface Storage {
  read(slot: string): Result<string | null, DomecsError>
  write(slot: string, data: string): Result<void, DomecsError>
  remove(slot: string): Result<void, DomecsError>
  list(): Result<readonly string[], DomecsError>
}

/** In-memory adapter for tests and ephemeral sessions. */
export function createMemoryStorage(initial?: Readonly<Record<string, string>>): Storage {
  const map = new Map<string, string>(initial ? Object.entries(initial) : [])
  return {
    read(slot) {
      return ok(map.has(slot) ? map.get(slot)! : null)
    },
    write(slot, data) {
      map.set(slot, data)
      return ok(undefined)
    },
    remove(slot) {
      map.delete(slot)
      return ok(undefined)
    },
    list() {
      return ok(Array.from(map.keys()).sort())
    },
  }
}
