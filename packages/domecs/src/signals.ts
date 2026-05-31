export interface Signal<T> {
  /** Register `fn` to be invoked with each emitted payload. Returns an
   * unsubscribe function that detaches `fn`. The unsubscribe is **idempotent**:
   * calling it more than once is a safe no-op (subsequent calls do nothing). */
  subscribe(fn: (e: T) => void): () => void
}

export interface EmittableSignal<T> extends Signal<T> {
  emit(payload: T): void
  readonly size: number
}

export function createSignal<T>(): EmittableSignal<T> {
  const subs = new Set<(e: T) => void>()
  return {
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    emit(payload) {
      if (subs.size === 0) return
      for (const fn of subs) fn(payload)
    },
    get size() {
      return subs.size
    },
  }
}
