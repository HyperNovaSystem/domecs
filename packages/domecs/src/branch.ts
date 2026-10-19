// §7.2 (G3; O-81): branches. Systems are closures, so a world cannot be
// cloned; a branch is a fresh headless world built by the source's setup and
// restored from one of its snapshots, then stepped without touching the live
// world (or its views).
import { err, normalizeCause, ok, type Result, type SerializedError } from './result.js'
import type { RngState } from './rng.js'
import type { WorldSnapshot } from './snapshot.js'
import { createWorld, type World } from './world.js'

/**
 * Registers types, systems and plugins on a world in a fixed order; spawns
 * nothing. May return setup output (handles, metadata) for the caller.
 * A branch's setup must register the same systems, in the same order, as the
 * world the snapshot came from (SPEC §7.1); nothing can verify this.
 */
export type WorldSetup<T = void> = (world: World) => T

/** Options for {@link createBranch}. */
export interface BranchOptions {
  /** Default `from.fixedStep ?? 1/60`. */
  readonly fixedStep?: number
  /** The `createWorld` seed; only matters for a v2 `from` (no `rngRoot`). */
  readonly seed?: number | RngState
  /** `time.scale` of the source; default 1. Scale is not snapshotted. */
  readonly scale?: number
}

/** Why {@link createBranch} could not build a branch. */
export type BranchError =
  | { readonly kind: 'restore_failed'; readonly cause: SerializedError }
  | { readonly kind: 'once_systems'; readonly names: readonly string[] }

/**
 * Build a branch of a world (§7.2): `createWorld({ headless: true, fixedStep,
 * seed })`, `setup(world)`, `world.restore(from)`, `setScale(options.scale ??
 * 1)`.
 *
 * - A throw from `setup` is a bug and propagates.
 * - A throw from `restore` (a snapshot that fails validation, an unknown
 *   pending event) is `restore_failed` with the serialized cause.
 * - An enabled `once` system registered by `setup` when `from.tick > 0` is
 *   `once_systems`: the branch would run it on its first step while the
 *   source, past tick 0, already had (`once` run state is not snapshotted).
 *
 * Take `from` with `snapshot({ pendingEvents: true })` and without
 * snapshot-rewriting plugins (redaction), or the branch starts from a
 * different state than the source had.
 */
export function createBranch<T = void>(
  setup: WorldSetup<T>,
  from: WorldSnapshot,
  options: BranchOptions = {},
): Result<{ readonly world: World; readonly setup: T }, BranchError> {
  const fixedStep = options.fixedStep ?? snapshotFixedStep(from) ?? 1 / 60
  const world = createWorld({
    headless: true,
    fixedStep,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  })
  const out = setup(world)
  if (snapshotTick(from) > 0) {
    const names = world
      .describe()
      .systems.filter((s) => s.schedule === 'once' && s.enabled)
      .map((s) => s.name)
    if (names.length > 0) return err({ kind: 'once_systems', names })
  }
  try {
    world.restore(from)
  } catch (cause) {
    return err({ kind: 'restore_failed', cause: normalizeCause(cause) })
  }
  world.setScale(options.scale ?? 1)
  return ok({ world, setup: out })
}

// `from` is caller data that may be malformed (restore reports that); read
// the two fields createBranch needs before the restore defensively.
function snapshotFixedStep(from: WorldSnapshot): number | undefined {
  const v: unknown = (from as { fixedStep?: unknown } | null)?.fixedStep
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}

function snapshotTick(from: WorldSnapshot): number {
  const v: unknown = (from as { tick?: unknown } | null)?.tick
  return typeof v === 'number' ? v : 0
}
