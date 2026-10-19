// §7.2 (G3; O-81): branches. Systems are closures, so a world cannot be
// cloned; a branch is a fresh headless world built by the source's setup and
// restored from one of its snapshots, then stepped without touching the live
// world (or its views).
import type { SystemicFault } from './errors.js'
import { actLogHash, applyActFrame, checkLog, type ActLog, type ActLogFrame, type ReplayError } from './replay.js'
import { err, normalizeCause, ok, type JsonValue, type Result, type SerializedError } from './result.js'
import type { RngState } from './rng.js'
import type { WorldSnapshot } from './snapshot.js'
import { createWorld, type World } from './world.js'
import { plainDataCopy } from './world-state.js'

/**
 * Registers types, systems and plugins on a world in a fixed order; spawns
 * nothing. May return setup output (handles, metadata) for the caller.
 * A branch's setup must register the same systems, in the same order, as the
 * world the snapshot came from (SPEC §7.1); nothing can verify this.
 */
export type WorldSetup<T = void> = (world: World) => T

/** Options for {@link createBranch}. */
export interface BranchOptions {
  /**
   * Default `from.fixedStep ?? 1/60`. A snapshot carries `fixedStep` only
   * with a fixed backlog, so pass the source's `time.fixedStep` whenever it
   * is not 1/60.
   */
  readonly fixedStep?: number
  /** The `createWorld` seed; only matters for a v2 `from` (no `rngRoot`). */
  readonly seed?: number | RngState
  /**
   * `time.scale` of the source; default 1. Scale is not snapshotted. For a
   * paused source, pass the scale it resumes to and `pause()` the branch:
   * `scale: 0` resumes to 1.
   */
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
 * different state than the source had. Pass the source's `fixedStep` and
 * `scale`: neither is in a snapshot (`fixedStep` only with a backlog).
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

/** Options for {@link runBranch}. */
export interface RunBranchOptions {
  /** How many steps to take at most (a non-negative integer). */
  readonly steps: number
  /** Per-step dt; `null` = `stepOnce()`. Default `world.time.fixedStep`. Frames from `log` override. */
  readonly dt?: number | null
  /**
   * Acts, input, scale and dt to apply at matching ticks: before a step, the
   * log's frame whose `tick` is `world.time.tick` is applied with §7.1's
   * frame code (the first such frame, when ticks repeat after a `restore`
   * gap). Steps with no frame use `dt`. `baseHash` and checkpoints are not
   * compared (that is `replay`'s job).
   */
  readonly log?: ActLog
  /** Read-only probes sampled into `samples` (values are copied as plain data). */
  readonly probes?: Readonly<Record<string, (world: World) => JsonValue>>
  /** Sample after every `sampleEvery`-th step of this call (default 1 when probes are given). */
  readonly sampleEvery?: number
  /** Take a `snapshot({ pendingEvents: true })` after every `keyframeEvery`-th step of this call; default none. */
  readonly keyframeEvery?: number
  /** Take a strict hash after every `hashEvery`-th step of this call; default none. */
  readonly hashEvery?: number
  /** Checked after each step; `true` stops the run (`stoppedBy: 'until'`). */
  readonly until?: (world: World) => boolean
  /** Polled before each step for cooperative cancellation (`stoppedBy: 'cancelled'`). */
  readonly shouldStop?: () => boolean
}

/** What {@link runBranch} observed. */
export interface BranchRun {
  /** Steps taken by this call. */
  readonly ticks: number
  readonly stoppedBy: 'steps' | 'until' | 'cancelled'
  readonly samples: ReadonlyArray<{ readonly tick: number; readonly values: Readonly<Record<string, JsonValue>> }>
  readonly keyframes: ReadonlyArray<{ readonly tick: number; readonly snapshot: WorldSnapshot }>
  readonly hashes: ReadonlyArray<{ readonly tick: number; readonly hash: string }>
  /** Systemic faults raised (`signals.faultRaised`) during this call. */
  readonly faults: readonly SystemicFault[]
  /** Strict hash (`includeChanges: true`, pending events included) when the call returned. */
  readonly finalHash: string
}

function checkCount(name: string, v: unknown, min: 0 | 1): void {
  if (!(Number.isInteger(v) && (v as number) >= min)) {
    throw new TypeError(`domecs: runBranch ${name} must be a ${min === 0 ? 'non-negative' : 'positive'} integer; got ${String(v)}`)
  }
}

/**
 * Step `world` — usually a {@link createBranch} world — and observe it (§7.2).
 * Synchronous; a host runs it in a worker and cancels through `shouldStop`.
 * Call it again to extend the branch from where it stopped.
 *
 * Each step applies the `log` frame for the current tick when there is one
 * (§7.1 frame code), else `stepOnce()` / `step(dt)`. Probes are sampled after
 * every `sampleEvery`-th step **counted from this call's start**, and always
 * after the final step whatever stopped the run (with no step taken, the
 * current state is sampled once); `keyframeEvery` and `hashEvery` count the
 * same way. All hashes are strict. Equal `(setup, from, options)` give equal
 * `finalHash`, `hashes` and `samples`.
 *
 * Probes must be read-only: at the first sample of each call, the world's
 * strict hash is compared before and after every probe, and a probe that
 * changed it throws an `Error` naming it. A probe value that is not plain
 * data throws `TypeError`.
 *
 * A malformed log, a log for another `fixedStep`, or an act that does not
 * resolve or validate is a {@link ReplayError} value (the steps already taken
 * stay taken). Malformed options throw `TypeError` before any step.
 */
export function runBranch(world: World, options: RunBranchOptions): Result<BranchRun, ReplayError> {
  checkCount('steps', options.steps, 0)
  const dt = options.dt === undefined ? world.time.fixedStep : options.dt
  if (dt !== null && !(typeof dt === 'number' && Number.isFinite(dt) && dt > 0)) {
    throw new TypeError(`domecs: runBranch dt must be null or a positive finite number; got ${String(dt)}`)
  }
  const probes = options.probes !== undefined ? Object.entries(options.probes) : []
  const hasProbes = options.probes !== undefined
  const sampleEvery = options.sampleEvery ?? 1
  if (options.sampleEvery !== undefined) checkCount('sampleEvery', options.sampleEvery, 1)
  if (options.keyframeEvery !== undefined) checkCount('keyframeEvery', options.keyframeEvery, 1)
  if (options.hashEvery !== undefined) checkCount('hashEvery', options.hashEvery, 1)

  // Frames keyed by tick; the first one wins when ticks repeat.
  const frames = new Map<number, ActLogFrame>()
  if (options.log !== undefined) {
    const log = options.log
    const bad = checkLog(log)
    if (bad !== null) return err({ kind: 'invalid_log', reason: bad })
    if (log.fixedStep !== world.time.fixedStep) {
      return err({
        kind: 'invalid_log',
        reason: `the log was recorded at fixedStep ${log.fixedStep}, the world steps at ${world.time.fixedStep}`,
      })
    }
    for (const f of log.frames) if (!frames.has(f.tick)) frames.set(f.tick, f)
  }

  const samples: Array<{ tick: number; values: Record<string, JsonValue> }> = []
  const keyframes: Array<{ tick: number; snapshot: WorldSnapshot }> = []
  const hashes: Array<{ tick: number; hash: string }> = []
  const faults: SystemicFault[] = []
  let checked = false

  const sample = (): void => {
    const values: Record<string, JsonValue> = {}
    let before = checked ? '' : actLogHash(world)
    for (const [name, probe] of probes) {
      values[name] = plainDataCopy(probe(world), `probe "${name}"`) as JsonValue
      if (!checked) {
        const after = actLogHash(world)
        if (after !== before) {
          throw new Error(
            `domecs: runBranch probe "${name}" changed the world (its strict hash differs before and after the probe); probes must be read-only`,
          )
        }
        before = after
      }
    }
    checked = true
    samples.push({ tick: world.time.tick, values })
  }

  const unsubscribe = world.signals.faultRaised.subscribe((f) => faults.push(f))
  try {
    let n = 0
    let sampledAt = -1
    let stoppedBy: BranchRun['stoppedBy'] = 'steps'
    while (n < options.steps) {
      if (options.shouldStop?.() === true) {
        stoppedBy = 'cancelled'
        break
      }
      const frame = frames.get(world.time.tick)
      if (frame !== undefined) {
        const failed = applyActFrame(world, frame)
        if (failed !== null) return err(failed)
      } else if (dt === null) {
        world.stepOnce()
      } else {
        world.step(dt)
      }
      n++
      const tick = world.time.tick
      if (options.hashEvery !== undefined && n % options.hashEvery === 0) hashes.push({ tick, hash: actLogHash(world) })
      if (options.keyframeEvery !== undefined && n % options.keyframeEvery === 0) {
        keyframes.push({ tick, snapshot: world.snapshot({ pendingEvents: true }) })
      }
      if (hasProbes && n % sampleEvery === 0) {
        sample()
        sampledAt = n
      }
      if (options.until?.(world) === true) {
        stoppedBy = 'until'
        break
      }
    }
    // The horizon value is always sampled.
    if (hasProbes && sampledAt !== n) sample()
    return ok({ ticks: n, stoppedBy, samples, keyframes, hashes, faults, finalHash: actLogHash(world) })
  } finally {
    unsubscribe()
  }
}
