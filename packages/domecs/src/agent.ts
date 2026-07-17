/**
 * Thin agent operability facade (PLAN WS-3).
 *
 * Wraps existing world APIs — no new runtime semantics. Agents (and UIs)
 * share one loop: observe → act → step → snapshot, with reset for episodes.
 */
import type { EventType } from './events.js'
import type { WorldManifest } from './manifest.js'
import type { SnapshotOptions, WorldSnapshot } from './snapshot.js'
import type { ActionOptions, ActionResult, World } from './world.js'

/** Options for {@link createAgentBridge}. */
export interface AgentBridgeOptions {
  /**
   * Snapshot used by {@link AgentBridge.reset}. When omitted, a baseline is
   * captured from `world` at construction time (after any setup the caller
   * has already performed).
   */
  baseline?: WorldSnapshot
}

/**
 * Compact observation for agent control loops.
 * `manifest` is the shipped {@link World.describe} surface — nothing new.
 */
export interface AgentObservation {
  readonly tick: number
  readonly scale: number
  readonly entityCount: number
  readonly manifest: WorldManifest
}

/**
 * Minimal bridge: `reset / observe / act / step / snapshot`.
 * All methods are thin wrappers over {@link World}.
 */
export interface AgentBridge {
  /** The underlying world — escape hatch for setup systems and queries. */
  readonly world: World
  /**
   * Restore the baseline snapshot. Systems, plugins, and type definitions
   * remain; entity/resource state returns to the baseline.
   *
   * Not restored (the snapshot does not carry them): `time.scale` and
   * input state. An episode that ends paused/rescaled or with stale
   * `setInput` data carries that into the next episode — restore them
   * explicitly at episode boundaries if your episodes touch either.
   *
   * For comparable episodes, call `reset()` once BEFORE the first episode
   * too: entity-id assignment on a restored world derives from the highest
   * live id, so a first episode run directly on live setup state can
   * assign different ids than post-reset episodes when setup despawned the
   * max-id entity (see plan/FINDINGS.md O-38).
   */
  reset(): void
  /** Replace the baseline with a snapshot of the current world state. */
  captureBaseline(): void
  /** Observe tick/scale/entity counts plus {@link World.describe}. */
  observe(): AgentObservation
  /** Typed command boundary — delegates to {@link World.action}. */
  act<T>(type: EventType<T>, payload: T, opts?: ActionOptions): ActionResult
  /**
   * Advance simulation. Omit `dt` for turn-based {@link World.stepOnce};
   * pass a positive `dt` for {@link World.step} (required for `fixed`
   * systems).
   *
   * `step(0)` (or a negative dt) is NOT `step()`: an explicit non-positive
   * dt is the F-6 heartbeat — no systems run, no change-detection swap. A
   * computed dt that rounds to 0 therefore silently advances nothing;
   * guard the call site if that would be a bug.
   */
  step(dt?: number): void
  /** Capture a plain-data snapshot — delegates to {@link World.snapshot}. */
  snapshot(options?: SnapshotOptions): WorldSnapshot
}

/**
 * Create an agent bridge over an existing world.
 *
 * Typical episode loop (note the reset() BEFORE the first episode — it
 * makes entity-id assignment identical across all episodes, see
 * {@link AgentBridge.reset}):
 * ```ts
 * const bridge = createAgentBridge(world)
 * bridge.reset()
 * const obs = bridge.observe()
 * const result = bridge.act(Cmd, { ... })
 * bridge.step() // or bridge.step(1/60) for fixed schedules
 * const snap = bridge.snapshot()
 * ```
 */
export function createAgentBridge(
  world: World,
  opts: AgentBridgeOptions = {},
): AgentBridge {
  let baseline: WorldSnapshot = opts.baseline ?? world.snapshot()

  return {
    world,

    reset(): void {
      world.restore(baseline)
    },

    captureBaseline(): void {
      baseline = world.snapshot()
    },

    observe(): AgentObservation {
      const manifest = world.describe()
      return {
        tick: world.time.tick,
        scale: world.time.scale,
        entityCount: manifest.entityCount,
        manifest,
      }
    },

    act<T>(type: EventType<T>, payload: T, actionOpts?: ActionOptions): ActionResult {
      return world.action(type, payload, actionOpts)
    },

    step(dt?: number): void {
      if (dt === undefined) world.stepOnce()
      else world.step(dt)
    },

    snapshot(options?: SnapshotOptions): WorldSnapshot {
      return world.snapshot(options)
    },
  }
}
