// §7.1 (G4; O-80): the world-internal tap an act-log recorder listens on.
// A symbol-keyed hook on the world object (like the component `internal()`
// pattern), not a public signal: only `createRecorder` uses it.
import type { EventType } from './events.js'

/** How an external emit entered the world (§7.1 `ActRecord.via`). */
export type ActVia = 'emit' | 'action'

/** What the world reports to an attached recorder. Listeners must not throw. */
export interface ActTapListener {
  /**
   * An emit not made by a system or an `on` handler: `world.emit`, `turn`,
   * `action`, `world.events.emit` outside a tick, or a plugin hook / signal
   * subscriber during a tick or heartbeat.
   */
  emitted(type: EventType<unknown>, payload: unknown, via: ActVia): void
  /**
   * A full (non-heartbeat) `runTick` was entered: `tick` is `time.tick`
   * before the step, `dt` the caller's dt (`null` for `stepOnce`), `scale`
   * `time.scale` on entry — the scale this step's dt is scaled by.
   */
  frameEntered(tick: number, dt: number | null, scale: number): void
  /** Plugin `onTickStart` hooks ran (the step's input is in place). */
  frameStarted(): void
  /** The `tickStart` signal ran: `time.scale` is now what systems run under. */
  hooksDone(): void
  /** The full tick completed. */
  frameEnded(): void
  /** Spawn/despawn/add/remove/`markChanged`/`setResource`/`markResourceChanged` outside a full tick. */
  mutated(): void
  /** `restore()` began (before plugin `onRestore` hooks). */
  restoreBegan(): void
  /** `restore()` finished: `ok` false when it threw and left the world as it was. */
  restoreEnded(ok: boolean): void
}

export interface ActTap {
  /** Attach `listener`; returns a detach function. */
  attach(listener: ActTapListener): () => void
  /** Whether a full tick or a heartbeat is running. */
  readonly inTick: boolean
}

export const ACT_TAP: unique symbol = Symbol('domecs.actTap')

/** The tap of a world made by `createWorld`; `undefined` for anything else. */
export function actTapOf(world: object): ActTap | undefined {
  return (world as { [ACT_TAP]?: ActTap })[ACT_TAP]
}
