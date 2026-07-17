/**
 * Restore-aware checkpoint ring + pure branch compare, shared by the headless
 * session (session.mjs) and the browser shell (browser/main.js).
 *
 * Checkpoints hold full world snapshots and deliberately live OUTSIDE the
 * world so snapshots never nest inside the snapshot envelope.
 *
 * Timeline safety: `world.restore()` rewinds `world.time.tick`, so tick
 * numbers repeat across timelines. Every restore must go through this ring
 * (or call `afterRestore()`), which drops checkpoints from the abandoned
 * future; a re-visited tick replaces the stale entry instead of keeping it.
 *
 * Cadence is keyed to the historian sample counter (one sample per fixed
 * step), not to render ticks — checkpoint density is therefore a function of
 * sim time, independent of display refresh rate, and stays aligned with the
 * historian scrub window across restores (the counter lives in a resource,
 * so it rewinds with the world).
 */

/**
 * @param {object} world
 * @param {{
 *   getSampleCount: () => number,
 *   everySamples?: number,
 *   capacity?: number,
 * }} opts
 */
export function createCheckpointRing(world, opts) {
  const everySamples = opts.everySamples ?? 10
  const capacity = opts.capacity ?? 40
  const getSampleCount = opts.getSampleCount
  /** @type {Array<{ tick: number, count: number, snapshot: object }>} */
  const checkpoints = []
  let suspended = 0

  function maybeCheckpoint() {
    if (suspended > 0) return
    const count = getSampleCount()
    if (count <= 0) return
    const last = checkpoints[checkpoints.length - 1]
    if (last && count - last.count < everySamples) return
    const tick = world.time.tick
    const cp = { tick, count, snapshot: world.snapshot() }
    const existing = checkpoints.findIndex((c) => c.tick === tick)
    if (existing >= 0) checkpoints[existing] = cp
    else {
      checkpoints.push(cp)
      while (checkpoints.length > capacity) checkpoints.shift()
    }
  }

  /**
   * Drop checkpoints from an abandoned future. Call after ANY
   * `world.restore()` that did not go through this ring.
   */
  function afterRestore() {
    const tick = world.time.tick
    const count = getSampleCount()
    for (let i = checkpoints.length - 1; i >= 0; i--) {
      if (checkpoints[i].tick > tick || checkpoints[i].count > count) {
        checkpoints.splice(i, 1)
      }
    }
  }

  /**
   * Restore the nearest checkpoint at or before `tick`.
   * @returns {boolean} false when no checkpoint ≤ `tick` exists (never
   * falls forward to a later checkpoint).
   */
  function restoreAtOrBefore(tick) {
    let best = null
    for (const cp of checkpoints) {
      if (cp.tick <= tick) best = cp
    }
    if (!best) return false
    world.restore(best.snapshot)
    afterRestore()
    return true
  }

  /** Run `fn` with checkpointing suspended (speculative rollouts). */
  function suspendDuring(fn) {
    suspended += 1
    try {
      return fn()
    } finally {
      suspended -= 1
    }
  }

  return {
    maybeCheckpoint,
    afterRestore,
    restoreAtOrBefore,
    suspendDuring,
    list: () => checkpoints.slice(),
    clear: () => {
      checkpoints.length = 0
    },
  }
}

/**
 * Pure branch compare: evaluate each strategy from the same base snapshot
 * and put the world BACK on base before returning. Nothing speculative is
 * checkpointed, applying a winner stays an explicit follow-up act (through
 * the approval flow), and a paused world is resumed for the rollouts and
 * re-paused after (fixed systems do not fire at scale 0).
 *
 * @param {object} args
 * @param {object} args.world
 * @param {{ snapshot: () => object }} args.bridge
 * @param {{ suspendDuring: (fn: () => void) => void, afterRestore: () => void }} args.ring
 * @param {number} args.steps   fixed steps to roll each branch forward
 * @param {number} args.fixedStep
 * @param {Array<() => void>} args.strategies
 * @param {() => object} args.readOutcome
 * @returns {{ outcomes: object[], base: object }}
 */
export function compareBranches({ world, bridge, ring, steps, fixedStep, strategies, readOutcome }) {
  const wasPaused = world.time.scale === 0
  if (wasPaused) world.resume()
  const base = bridge.snapshot()
  const outcomes = []
  ring.suspendDuring(() => {
    for (const strategy of strategies) {
      world.restore(base)
      strategy()
      for (let i = 0; i < steps; i++) world.step(fixedStep)
      outcomes.push(readOutcome())
    }
    world.restore(base)
  })
  ring.afterRestore()
  if (wasPaused) world.pause()
  return { outcomes, base }
}
