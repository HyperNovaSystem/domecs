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
   * Entity-id assignment is stable across `reset()`: the snapshot carries
   * the id cursor (O-38), so ids assigned after a restore match ids the
   * live world would have assigned. Pending events are discarded by
   * `restore()`, so an abandoned episode's events never fire into the next.
   */
  reset(): void
  /** Replace the baseline with a snapshot of the current world state. */
  captureBaseline(): void
  /** Observe tick/scale/entity counts plus {@link World.describe}. */
  observe(): AgentObservation
  /** Typed command boundary — delegates to {@link World.action}. */
  act<T>(type: EventType<T>, payload: T, opts?: ActionOptions): ActionResult
  /**
   * Name-based command boundary for JSON callers (MCP tools, HTTP, act
   * logs): resolves `name` through {@link World.lookupEvent}, then behaves
   * exactly like `act(type, …)`, schema validation included (O-39).
   *
   * An unknown name, or one shared by two distinct known event types, is
   * rejected with `{ accepted: false, consumedTurn: false, reason, events: [] }`
   * — no emit, no tick. An event becomes known when it is registered,
   * emitted, subscribed to or named as a trigger; `world.register` it (and
   * keep agent-facing command names unique) so it resolves before first use.
   */
  act(name: string, payload: unknown, opts?: ActionOptions): ActionResult
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
 * Typical episode loop (the reset() before the first episode is boundary
 * hygiene — every episode then starts from the identical restored state):
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

    act(
      typeOrName: EventType<unknown> | string,
      payload: unknown,
      actionOpts?: ActionOptions,
    ): ActionResult {
      if (typeof typeOrName !== 'string') return world.action(typeOrName, payload, actionOpts)
      const type = world.lookupEvent(typeOrName)
      if (type === undefined) {
        const known = world.eventTypes().some((t) => t.name === typeOrName)
        return {
          accepted: false,
          consumedTurn: false,
          reason: known
            ? `ambiguous event name "${typeOrName}": two distinct known event types share it`
            : `unknown event "${typeOrName}" (register it with world.register, or check the name against world.eventTypes())`,
          events: [],
        }
      }
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
