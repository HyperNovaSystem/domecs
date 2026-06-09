import type { DomecsError, Result } from '@domecs/core'
import { err, normalizeCause, ok } from '@domecs/core'

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

/** Structural subset of the Web Storage API this adapter needs; declared
 *  locally so the package stays free of DOM lib types. */
interface WebStorageLike {
  readonly length: number
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  key(index: number): string | null
}

/**
 * Browser `localStorage` adapter. Slots are namespaced as `prefix + slot`
 * (default prefix `'domecs:'`). The backing store is resolved lazily from
 * `globalThis` on each operation, so importing this module is safe in
 * headless/Node hosts; every operation catches at the I/O boundary (missing
 * `localStorage`, privacy mode, quota exceeded) and returns `persist_io`.
 */
export function createLocalStorageStorage(prefix = 'domecs:'): Storage {
  const store = (): WebStorageLike => {
    const ls = (globalThis as { localStorage?: WebStorageLike }).localStorage
    if (!ls) throw new Error('localStorage is not available in this host')
    return ls
  }
  const k = (slot: string): string => prefix + slot
  const ioErr = (op: 'save' | 'load', cause: unknown): Result<never, DomecsError> =>
    err({ kind: 'persist_io', op, cause: normalizeCause(cause), retryable: true })
  return {
    read(slot) {
      try {
        return ok(store().getItem(k(slot)))
      } catch (cause) {
        return ioErr('load', cause)
      }
    },
    write(slot, data) {
      try {
        store().setItem(k(slot), data)
        return ok(undefined)
      } catch (cause) {
        return ioErr('save', cause)
      }
    },
    remove(slot) {
      try {
        store().removeItem(k(slot))
        return ok(undefined)
      } catch (cause) {
        return ioErr('save', cause)
      }
    },
    list() {
      try {
        const ls = store()
        const out: string[] = []
        for (let i = 0; i < ls.length; i++) {
          const key = ls.key(i)
          if (key !== null && key.startsWith(prefix)) out.push(key.slice(prefix.length))
        }
        return ok(out.sort())
      } catch (cause) {
        return ioErr('load', cause)
      }
    },
  }
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
