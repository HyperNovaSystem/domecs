declare const __eventTag: unique symbol

export interface EventType<T> {
  readonly name: string
  readonly [__eventTag]: symbol
  readonly __t?: T
}

export function defineEvent<T>(name: string): EventType<T> {
  return { name, __tag: Symbol(name) } as unknown as EventType<T>
}

export interface EventView {
  of<T>(type: EventType<T>): readonly T[]
  emit<T>(type: EventType<T>, payload: T): void
}

export interface EventBus {
  /** Enqueue for delivery at step 1 of next tick. */
  emit<T>(type: EventType<T>, payload: T): void
  /** Subscribe directly; fn fires at flush time for events of that type. */
  on<T>(type: EventType<T>, fn: (e: T) => void): () => void
  /** Swap pending -> current, returning the view for event systems this tick. */
  flush(): EventView
  /** Current view (for inspection). */
  view(): EventView
}

export function createEventBus(): EventBus {
  // by event name
  let pending = new Map<string, unknown[]>()
  let current = new Map<string, unknown[]>()
  const subs = new Map<string, Set<(e: unknown) => void>>()

  const makeView = (src: Map<string, unknown[]>): EventView => ({
    of<T>(type: EventType<T>): readonly T[] {
      const arr = src.get(type.name)
      return (arr ?? []) as readonly T[]
    },
    emit<T>(type: EventType<T>, payload: T): void {
      let a = pending.get(type.name)
      if (!a) {
        a = []
        pending.set(type.name, a)
      }
      a.push(payload)
    },
  })

  return {
    emit<T>(type: EventType<T>, payload: T): void {
      let a = pending.get(type.name)
      if (!a) {
        a = []
        pending.set(type.name, a)
      }
      a.push(payload)
    },
    on<T>(type: EventType<T>, fn: (e: T) => void): () => void {
      let s = subs.get(type.name)
      if (!s) {
        s = new Set()
        subs.set(type.name, s)
      }
      s.add(fn as (e: unknown) => void)
      return () => s!.delete(fn as (e: unknown) => void)
    },
    flush(): EventView {
      // promote pending -> current, reset pending
      current = pending
      pending = new Map()
      // deliver to direct subscribers synchronously at flush
      for (const [name, arr] of current) {
        const s = subs.get(name)
        if (!s || s.size === 0) continue
        for (const payload of arr) {
          for (const fn of s) fn(payload)
        }
      }
      return makeView(current)
    },
    view(): EventView {
      return makeView(current)
    },
  }
}
