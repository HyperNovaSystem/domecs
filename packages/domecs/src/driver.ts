/**
 * F-5: thin rAF driver. Every browser exemplar was hand-rolling dt-clamp /
 * first-frame priming / visibility-pause logic; owning it here gives one
 * place to fix that mis-tune.
 *
 * The driver owns all rAF bookkeeping (handle, wall-clock reference,
 * visibility handler, wake flag). World behaviour is injected through
 * {@link DriverHooks} so this module never reaches back into world state.
 */

/** Structural twin of `StartOptions` (declared in world.ts, the public surface). */
export interface DriverStartOptions {
  dtClampMs?: number
  pauseOnHidden?: boolean
}

export interface DriverHooks {
  /** Advance the world by dt seconds (wall-clock gap, already clamped). */
  step(dt: number): void
  pause(): void
  resume(): void
  /** Whether the world is currently paused (`time.scale === 0`). */
  isPaused(): boolean
  /** Idle policy: keep scheduling frames while this returns true. */
  shouldKeepAwake(): boolean
  /** Mutations made by systems mid-tick must not re-arm the driver. */
  isInTick(): boolean
}

export interface RafDriver {
  startLoop(options?: DriverStartOptions): () => void
  stop(): void
  wake(): void
  /**
   * Wake a sleeping idle loop for one heartbeat frame — `step(0)`: plugin
   * hooks and render, no tick (O-48). Upgraded to a normal wake step if
   * {@link wake} is called before the frame runs.
   */
  repaint(): void
}

export function createRafDriver(
  opts: { idle: boolean; headless: boolean },
  hooks: DriverHooks,
): RafDriver {
  const { idle, headless } = opts
  // F-5: rAF driver state. `rafHandle === null` means "not running".
  let rafStarted = false
  let rafHandle: number | null = null
  let rafLastWallMs: number | null = null
  let rafVisHandler: (() => void) | null = null
  let rafWakeStep = false
  /** The pending frame was requested by repaint() and should not tick. */
  let rafRepaintOnly = false
  let rafDtClampMs = 100
  /** True only when *this* driver initiated a pause via visibility hide (O-32). */
  let visibilityOwnedPause = false

  function scheduleDriverFrame(): void {
    if (!rafStarted || rafHandle !== null) return
    const g = globalThis as unknown as {
      requestAnimationFrame?: (cb: (t: number) => void) => number
    }
    if (typeof g.requestAnimationFrame !== 'function') return
    rafHandle = g.requestAnimationFrame(frame)
  }

  function wake(): void {
    if (!rafStarted || !idle || hooks.isInTick()) return
    if (rafHandle !== null) {
      // A repaint frame is pending: state changed since, so make it a step.
      if (rafRepaintOnly) {
        rafRepaintOnly = false
        if (rafLastWallMs !== null) rafWakeStep = true
      }
      return
    }
    if (rafLastWallMs !== null) rafWakeStep = true
    scheduleDriverFrame()
  }

  function repaint(): void {
    if (!rafStarted || !idle || hooks.isInTick()) return
    // A frame is already coming (a step, or the priming frame).
    if (rafHandle !== null) return
    rafRepaintOnly = true
    scheduleDriverFrame()
  }

  function frame(t: number): void {
    if (!rafStarted) return
    rafHandle = null
    if (rafLastWallMs === null) {
      // First frame primes the reference — skip the step to avoid a
      // spurious dt = t (time-origin) on the very first tick.
      rafLastWallMs = t
      scheduleDriverFrame()
      return
    }
    if (rafRepaintOnly) {
      rafRepaintOnly = false
      rafLastWallMs = t
      try {
        hooks.step(0)
      } finally {
        if (rafStarted && hooks.shouldKeepAwake()) scheduleDriverFrame()
      }
      return
    }
    const gap = t - rafLastWallMs
    rafLastWallMs = t
    const dtMs = rafWakeStep ? 1 : (gap > rafDtClampMs ? rafDtClampMs : gap)
    rafWakeStep = false
    // O-45: schedule the next frame even when a system throws. The throw
    // still propagates (the host reports it as an uncaught error from the
    // rAF callback), but the loop no longer dies with it.
    try {
      hooks.step(dtMs / 1000)
    } finally {
      if (rafStarted && hooks.shouldKeepAwake()) scheduleDriverFrame()
    }
  }

  function startLoop(options?: DriverStartOptions): () => void {
    if (headless) {
      throw new Error(
        'domecs: World.startLoop() is disabled for worlds created with headless=true; use step(dt) instead',
      )
    }
    const g = globalThis as unknown as {
      requestAnimationFrame?: (cb: (t: number) => void) => number
      cancelAnimationFrame?: (h: number) => void
      document?: { hidden?: boolean; addEventListener: Function; removeEventListener: Function }
    }
    if (typeof g.requestAnimationFrame !== 'function' || typeof g.cancelAnimationFrame !== 'function') {
      throw new Error(
        'domecs: World.startLoop() requires requestAnimationFrame; use step(dt) in headless environments',
      )
    }
    if (rafStarted) {
      wake()
      return () => stop()
    }
    rafStarted = true
    rafDtClampMs = options?.dtClampMs ?? 100
    // Default true; explicit `false` disables. Anything else (undefined,
    // nullish, truthy) enables — the switch is strict boolean-false.
    const pauseOnHidden = options?.pauseOnHidden !== false
    rafLastWallMs = null
    rafWakeStep = false
    scheduleDriverFrame()
    if (pauseOnHidden && g.document && typeof g.document.addEventListener === 'function') {
      const doc = g.document
      visibilityOwnedPause = false
      rafVisHandler = (): void => {
        // Defensive: browsers may deliver a queued visibilitychange event
        // after stop()+removeEventListener fires on the same microtask.
        // Ignore it; the next startLoop() installs a fresh handler.
        if (!rafStarted) return
        if (doc.hidden) {
          // O-32: only claim ownership when the world was running. An
          // app-managed pause (Pause button → world.pause()) must not be
          // auto-resumed when the tab becomes visible again.
          if (!hooks.isPaused()) {
            hooks.pause()
            visibilityOwnedPause = true
          }
        } else if (visibilityOwnedPause) {
          hooks.resume()
          visibilityOwnedPause = false
          // Discard the accumulated wall-clock gap so the first post-
          // resume frame primes cleanly instead of delivering a spike.
          rafLastWallMs = null
          scheduleDriverFrame()
        }
      }
      doc.addEventListener('visibilitychange', rafVisHandler)
    }
    return () => stop()
  }

  function stop(): void {
    if (!rafStarted) return
    const g = globalThis as unknown as {
      cancelAnimationFrame?: (h: number) => void
      document?: { removeEventListener: Function }
    }
    if (rafHandle !== null) g.cancelAnimationFrame?.(rafHandle)
    rafStarted = false
    rafHandle = null
    rafLastWallMs = null
    rafWakeStep = false
    rafRepaintOnly = false
    // O-32 residual: a pause this driver took on tab-hide must not outlive
    // the driver. Relinquish it on stop() so a stop()+startLoop() cycle
    // while hidden cannot orphan the world at scale 0 with no owner (the
    // fresh handler generation would read scale 0 as app-managed and never
    // auto-resume).
    if (visibilityOwnedPause) hooks.resume()
    visibilityOwnedPause = false
    if (rafVisHandler && g.document && typeof g.document.removeEventListener === 'function') {
      g.document.removeEventListener('visibilitychange', rafVisHandler)
      rafVisHandler = null
    }
  }

  return { startLoop, stop, wake, repaint }
}
