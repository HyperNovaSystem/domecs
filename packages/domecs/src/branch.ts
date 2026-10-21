// §7.2 (G3; O-81): branches. Systems are closures, so a world cannot be
// cloned; a branch is a fresh headless world built by the source's setup and
// restored from one of its snapshots, then stepped without touching the live
// world (or its views).
import { actTapOf } from './act-tap.js'
import type { SystemicFault } from './errors.js'
import { actLogHash, applyActFrame, checkLog, decodeInput, type ActLog, type ActLogFrame, type JsonInput, type ReplayError } from './replay.js'
import { err, normalizeCause, ok, type JsonValue, type Result, type SerializedError } from './result.js'
import type { RngState } from './rng.js'
import { setOwn, type WorldSnapshot } from './snapshot.js'
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
 * - A `once` system registered by `setup` that would run on the branch's
 *   first step, when `from.tick > 0`, is `once_systems`: the source, past
 *   tick 0, already had (`once` run state is not snapshotted). It is checked
 *   after the restore, so an `enabled` gate reads the source's state: boot
 *   work gated on snapshotted state is accepted. A gate that throws counts
 *   as one that would run.
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
  try {
    world.restore(from)
  } catch (cause) {
    return err({ kind: 'restore_failed', cause: normalizeCause(cause) })
  }
  world.setScale(options.scale ?? 1)
  // After the restore and the scale, so `enabled` gates see the source's
  // state.
  if (world.time.tick > 0) {
    const names = actTapOf(world)!.onceDue()
    if (names.length > 0) return err({ kind: 'once_systems', names })
  }
  return ok({ world, setup: out })
}

// `from` is caller data that may be malformed (restore reports that); read
// the field createBranch needs before the restore defensively.
function snapshotFixedStep(from: WorldSnapshot): number | undefined {
  const v: unknown = (from as { fixedStep?: unknown } | null)?.fixedStep
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}


/** Where each world's last runBranch call ended, to tell a continuation from a new start. */
const runEnds = new WeakMap<World, { readonly tick: number; readonly input: unknown; readonly log: ActLog | undefined }>()

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
   * compared (that is `replay`'s job). Before the first step, the input of
   * the latest frame earlier than `world.time.tick` is set (input is
   * delta-encoded and not snapshotted), so a branch from a mid-log snapshot
   * or keyframe starts with the source's input; a call that continues the
   * previous call on this world (same log object, same tick, input unchanged
   * since) keeps the input the branch's systems left. The scale is not carried:
   * pass the source's scale at that tick to {@link createBranch}.
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
    // Input is delta-encoded and not in a snapshot: a branch that starts
    // after the log's first frame (from a keyframe or a mid-log snapshot)
    // takes the input the latest earlier frame left, as the source had it: a
    // tickStart subscriber's replacement (hookInput) when there was one. A
    // call that continues the previous one on this world (same log, same
    // tick, same input object) keeps the input its systems left.
    const previous = runEnds.get(world)
    const continuing =
      previous !== undefined && previous.log === log && previous.tick === world.time.tick && previous.input === world.input
    let carried: JsonInput | undefined
    let carriedTick = -1
    for (const f of frames.values()) {
      if (f.tick >= world.time.tick || f.tick <= carriedTick) continue
      const last = f.hookInput ?? f.input
      if (last === undefined) continue
      carried = last
      carriedTick = f.tick
    }
    if (carried !== undefined && !continuing) world.setInput(decodeInput(carried))
  }

  const samples: Array<{ tick: number; values: Record<string, JsonValue> }> = []
  const keyframes: Array<{ tick: number; snapshot: WorldSnapshot }> = []
  const hashes: Array<{ tick: number; hash: string }> = []
  const faults: SystemicFault[] = []
  let checked = false

  // Input, scale and the resume target are not in a snapshot: a probe that
  // changes them is caught by comparing them, not the hash.
  const tap = actTapOf(world)
  const controls = (): readonly unknown[] => [world.input, world.time.scale, tap?.resumeScale]
  const sample = (): void => {
    const values: Record<string, JsonValue> = {}
    let before = checked ? '' : actLogHash(world)
    let beforeControls = checked ? [] : controls()
    for (const [name, probe] of probes) {
      // An own data property, so a probe named "__proto__" is a key, not the prototype.
      setOwn(values, name, plainDataCopy(probe(world), `probe "${name}"`))
      if (!checked) {
        const after = actLogHash(world)
        const afterControls = controls()
        if (after !== before || afterControls.some((v, i) => !Object.is(v, beforeControls[i]))) {
          throw new Error(
            `domecs: runBranch probe "${name}" changed the world (its strict hash, input, scale or resume target differs before and after the probe); probes must be read-only`,
          )
        }
        before = after
        beforeControls = afterControls
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
    runEnds.set(world, { tick: world.time.tick, input: world.input, log: options.log })
  }
}
