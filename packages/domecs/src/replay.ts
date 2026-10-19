// §7.1 (G4; O-80): act logs. A recorder writes down what entered a world
// from outside — external emits, the dt and scale of each step, the input
// systems saw — so a fresh world restored from the same base replays to the
// same strict hashes.
import { actTapOf, type ActTapListener } from './act-tap.js'
import { canonicalJson, hashSnapshot } from './canonical.js'
import type { GamepadSnapshot, InputSnapshot, PointerSnapshot } from './input.js'
import { validateEventPayload, type EventType } from './events.js'
import { err, ok, type JsonValue, type Result } from './result.js'
import { cloneSerializable, type WorldSnapshot } from './snapshot.js'
import type { Entity } from './types.js'
import type { World } from './world.js'
import { plainDataCopy } from './world-state.js'

/**
 * A JSON form of {@link InputSnapshot} (whose key sets are `Set`s). Key
 * arrays are sorted; `pressed`/`released` are omitted when empty, and
 * `mods`, `pointer`, `gamepads` and `focus` when they equal the empty input
 * (no modifier, pointer at rest at 0,0, no gamepad, no focus).
 */
export interface JsonInput {
  /** Held keys, sorted. */
  readonly keys: readonly string[]
  /** Keys pressed this render tick, sorted; omitted when empty. */
  readonly pressed?: readonly string[]
  /** Keys released this render tick, sorted; omitted when empty. */
  readonly released?: readonly string[]
  readonly mods?: { readonly ctrl: boolean; readonly alt: boolean; readonly shift: boolean; readonly meta: boolean }
  readonly pointer?: {
    readonly x: number
    readonly y: number
    readonly buttons: number
    readonly delta: { readonly x: number; readonly y: number }
    readonly wheel: number
    readonly entered: readonly Entity[]
  }
  readonly gamepads?: readonly GamepadSnapshot[]
  readonly focus?: { readonly activeTag: string; readonly consumesKeys: boolean }
}

const sorted = (set: ReadonlySet<string>): string[] => Array.from(set).sort()

/** `-0` is not the empty input's `0`: a lossless encoding keeps it. */
const isZero = (n: number): boolean => Object.is(n, 0)

function pointerAtRest(p: PointerSnapshot): boolean {
  return (
    isZero(p.x) &&
    isZero(p.y) &&
    isZero(p.buttons) &&
    isZero(p.delta.x) &&
    isZero(p.delta.y) &&
    isZero(p.wheel) &&
    p.entered.length === 0
  )
}

function copyGamepad(g: GamepadSnapshot): GamepadSnapshot {
  return {
    index: g.index,
    axes: Array.from(g.axes),
    buttons: g.buttons.map((b) => ({ pressed: b.pressed, value: b.value })),
  }
}

/**
 * Encode an input snapshot as plain JSON data (§7.1). The result shares no
 * object with `input`; {@link decodeInput} rebuilds an equal snapshot.
 */
export function encodeInput(input: InputSnapshot): JsonInput {
  const out: {
    keys: string[]
    pressed?: string[]
    released?: string[]
    mods?: NonNullable<JsonInput['mods']>
    pointer?: NonNullable<JsonInput['pointer']>
    gamepads?: GamepadSnapshot[]
    focus?: NonNullable<JsonInput['focus']>
  } = { keys: sorted(input.keys) }
  if (input.keyDelta.pressed.size > 0) out.pressed = sorted(input.keyDelta.pressed)
  if (input.keyDelta.released.size > 0) out.released = sorted(input.keyDelta.released)
  const m = input.mods
  if (m.ctrl || m.alt || m.shift || m.meta) {
    out.mods = { ctrl: m.ctrl, alt: m.alt, shift: m.shift, meta: m.meta }
  }
  const p = input.pointer
  if (!pointerAtRest(p)) {
    out.pointer = {
      x: p.x,
      y: p.y,
      buttons: p.buttons,
      delta: { x: p.delta.x, y: p.delta.y },
      wheel: p.wheel,
      entered: Array.from(p.entered),
    }
  }
  if (input.gamepads.length > 0) out.gamepads = input.gamepads.map(copyGamepad)
  const f = input.focus
  if (f.activeTag !== '' || f.consumesKeys) out.focus = { activeTag: f.activeTag, consumesKeys: f.consumesKeys }
  return out
}

/**
 * Rebuild an {@link InputSnapshot} from {@link encodeInput}'s form: `Set`s
 * for the key arrays, the empty input's value for every omitted part. The
 * result shares no object with `json`.
 */
export function decodeInput(json: JsonInput): InputSnapshot {
  const m = json.mods
  const p = json.pointer
  const f = json.focus
  return {
    keys: new Set(json.keys),
    keyDelta: { pressed: new Set(json.pressed ?? []), released: new Set(json.released ?? []) },
    mods: m
      ? { ctrl: m.ctrl, alt: m.alt, shift: m.shift, meta: m.meta }
      : { ctrl: false, alt: false, shift: false, meta: false },
    pointer: p
      ? {
          x: p.x,
          y: p.y,
          buttons: p.buttons,
          delta: { x: p.delta.x, y: p.delta.y },
          wheel: p.wheel,
          entered: Array.from(p.entered),
        }
      : { x: 0, y: 0, buttons: 0, delta: { x: 0, y: 0 }, wheel: 0, entered: [] },
    gamepads: (json.gamepads ?? []).map(copyGamepad),
    focus: f ? { activeTag: f.activeTag, consumesKeys: f.consumesKeys } : { activeTag: '', consumesKeys: false },
  }
}

// ---------------------------------------------------------------------------
// Act log and recorder
// ---------------------------------------------------------------------------

/** One external emit, by event name (§7.1). */
export interface ActRecord {
  /** The event's name; replay resolves it with `world.lookupEvent`. */
  readonly event: string
  /** A plain-data copy of the payload taken at emit time; absent for an `undefined` payload. */
  readonly payload?: JsonValue
  /** How the act entered the world. Only `'action'` acts are schema-validated on replay. */
  readonly via: 'emit' | 'action'
}

/** One full step (a `stepOnce()` or a `step(dt)` with `dt > 0`). Heartbeats are not frames. */
export interface ActLogFrame {
  /** `world.time.tick` before this step. */
  readonly tick: number
  /** The dt passed to `step(dt)`; `null` = `stepOnce()`. */
  readonly dt: number | null
  /**
   * `time.scale` on entry to this step, when it differs from the scale the
   * previous frame ended with (for the first frame: the log's `startScale`).
   * This step's dt is scaled by it.
   */
  readonly scale?: number
  /**
   * `time.scale` after this step's tick-start hooks (plugin `onTickStart`,
   * `signals.tickStart`), when a hook changed it — a `tickStart` pause
   * control. It governs whether this step's `fixed` and `tick` systems run;
   * replay applies it at the same point.
   */
  readonly hookScale?: number
  /** Events emitted from outside since the previous step, in emit order. */
  readonly acts?: readonly ActRecord[]
  /** `world.input` as systems saw it this step, when it differs from the previous frame's (always on the first frame). */
  readonly input?: JsonInput
}

/** Why a log stops describing the world at a tick (replay past it is unverified). */
export type ActLogGapReason = 'out_of_tick_mutation' | 'unserializable_payload' | 'restore'

/** A recorded session (§7.1): a new artifact with its own `format` and `version`. */
export interface ActLog {
  readonly format: 'domecs-actlog'
  readonly version: 1
  /** `world.time.tick` when recording started. */
  readonly startTick: number
  /** `world.time.fixedStep` of the recording world. */
  readonly fixedStep: number
  /** `time.scale` when recording started. */
  readonly startScale: number
  /** `hashSnapshot(world.snapshot({ pendingEvents: true }), { includeChanges: true })` when recording started. */
  readonly baseHash: string
  readonly frames: readonly ActLogFrame[]
  /** Strict hashes at tick ends (`hashEvery`). */
  readonly checkpoints?: ReadonlyArray<{ readonly tick: number; readonly hash: string }>
  /** Points where the log stops describing the world (replay past them is unverified). */
  readonly gaps?: ReadonlyArray<{ readonly tick: number; readonly reason: ActLogGapReason }>
}

/** Options for {@link createRecorder}. */
export interface RecorderOptions {
  /** Append a strict-hash checkpoint at each tick end where `tick % hashEvery === 0` (a positive integer). */
  readonly hashEvery?: number
}

/** A running act-log recording (§7.1). */
export interface Recorder {
  /** `false` once {@link stop} was called. */
  readonly active: boolean
  /** The log so far (a copy). */
  peek(): ActLog
  /** Stop recording and return the log. Later calls return the same log (a copy). */
  stop(): ActLog
}

/**
 * The strict state hash act logs use: `hashSnapshot(snapshot({ pendingEvents:
 * true }), { includeChanges: true })`. When a pending event's payload is not
 * plain data (the snapshot throws `TypeError`), pending events are left out.
 */
export function actLogHash(world: World): string {
  let snap
  try {
    snap = world.snapshot({ pendingEvents: true })
  } catch (cause) {
    if (!(cause instanceof TypeError)) throw cause
    snap = world.snapshot()
  }
  return hashSnapshot(snap, { includeChanges: true })
}

interface FrameDraft {
  tick: number
  dt: number | null
  scale?: number
  hookScale?: number
  acts?: ActRecord[]
  input?: JsonInput
}

/**
 * Start recording `world` (§7.1). The recorder listens on a world-internal
 * tap and writes down what a replay cannot reproduce by itself:
 *
 * - every emit **not made by a system or an `on` handler** (`world.emit`,
 *   `turn`, `action`, plugin hooks and signal subscribers, heartbeats
 *   included), with `via`, into the next frame's `acts`;
 * - per full step: the tick, the caller's dt (`null` for `stepOnce`), the
 *   scale on entry, a scale a tick-start hook set, and `world.input` after
 *   plugin `onTickStart`, delta-encoded;
 * - gaps: spawn/despawn/add/remove/`markChanged`/`setResource`/
 *   `markResourceChanged` outside a full tick (`out_of_tick_mutation`), a
 *   payload that is not plain data (`unserializable_payload`; the act is
 *   dropped), and `restore()` (`restore`).
 *
 * Throws `TypeError` for a world not made by `createWorld` or an invalid
 * `hashEvery`, and `Error` when called during a tick.
 */
export function createRecorder(world: World, options: RecorderOptions = {}): Recorder {
  const tap = actTapOf(world)
  if (tap === undefined) throw new TypeError('domecs: createRecorder needs a world made by createWorld')
  if (tap.inTick) throw new Error('domecs: createRecorder must be called outside a tick (not from a system, hook or handler)')
  const hashEvery = options.hashEvery
  if (hashEvery !== undefined && !(Number.isInteger(hashEvery) && hashEvery > 0)) {
    throw new TypeError(`domecs: createRecorder hashEvery must be a positive integer; got ${String(hashEvery)}`)
  }

  const startTick = world.time.tick
  const fixedStep = world.time.fixedStep
  const startScale = world.time.scale
  const baseHash = actLogHash(world)
  const frames: FrameDraft[] = []
  const checkpoints: Array<{ tick: number; hash: string }> = []
  const gaps: Array<{ tick: number; reason: ActLogGapReason }> = []
  let pending: ActRecord[] = []
  // Entered but before plugin onTickStart finished: acts still join it.
  let opening: FrameDraft | null = null
  // The frame whose tick is running (for hookScale).
  let running: FrameDraft | null = null
  let entryScale = startScale
  // The scale the previous frame ended with: a replay world has it too.
  let lastScale = startScale
  let lastInput: string | null = null
  let restoreMark = 0
  let restoreTick = 0
  let active = true
  let finalLog: ActLog | null = null

  function gap(reason: ActLogGapReason, at?: number): void {
    const tick = at ?? (opening !== null ? opening.tick : world.time.tick)
    const last = gaps[gaps.length - 1]
    if (last !== undefined && last.tick === tick && last.reason === reason) return
    gaps.push({ tick, reason })
  }

  const listener: ActTapListener = {
    emitted(type, payload, via) {
      if (payload === undefined) {
        pending.push({ event: type.name, via })
        return
      }
      let copy: JsonValue
      try {
        copy = plainDataCopy(payload, 'payload')
      } catch {
        gap('unserializable_payload')
        return
      }
      pending.push({ event: type.name, payload: copy, via })
    },
    frameEntered(tick, dt, scale) {
      opening = { tick, dt }
      entryScale = scale
      if (scale !== lastScale) opening.scale = scale
    },
    frameStarted() {
      const f = opening
      if (f === null) return
      if (pending.length > 0) {
        f.acts = pending
        pending = []
      }
      try {
        const enc = encodeInput(world.input)
        const key = canonicalJson(enc)
        if (key !== lastInput) {
          f.input = enc
          lastInput = key
        }
      } catch {
        gap('unserializable_payload')
      }
      opening = null
      running = f
      frames.push(f)
    },
    hooksDone() {
      if (running !== null && world.time.scale !== entryScale) running.hookScale = world.time.scale
    },
    frameEnded() {
      running = null
      lastScale = world.time.scale
      const tick = world.time.tick
      if (hashEvery !== undefined && tick % hashEvery === 0) {
        try {
          checkpoints.push({ tick, hash: actLogHash(world) })
        } catch {
          // A snapshot that cannot be taken has no hash; the log simply has
          // no checkpoint here.
        }
      }
    },
    mutated() {
      gap('out_of_tick_mutation')
    },
    restoreBegan() {
      restoreMark = pending.length
      restoreTick = world.time.tick
    },
    restoreEnded(ok) {
      if (ok) {
        // Acts queued before the restore were abandoned with the timeline;
        // what onRestore hooks emitted stays.
        pending.splice(0, restoreMark)
        // At the tick the world left, where the log stops describing it.
        gap('restore', restoreTick)
      } else {
        // A failed restore drops what its hooks emitted.
        pending.length = restoreMark
      }
    },
  }
  const detach = tap.attach(listener)

  function build(): ActLog {
    const log: {
      format: 'domecs-actlog'
      version: 1
      startTick: number
      fixedStep: number
      startScale: number
      baseHash: string
      frames: ActLogFrame[]
      checkpoints?: Array<{ tick: number; hash: string }>
      gaps?: Array<{ tick: number; reason: ActLogGapReason }>
    } = {
      format: 'domecs-actlog',
      version: 1,
      startTick,
      fixedStep,
      startScale,
      baseHash,
      frames: cloneSerializable(frames) as ActLogFrame[],
    }
    if (checkpoints.length > 0) log.checkpoints = checkpoints.map((c) => ({ tick: c.tick, hash: c.hash }))
    if (gaps.length > 0) log.gaps = gaps.map((g) => ({ tick: g.tick, reason: g.reason }))
    return log
  }

  return {
    get active() {
      return active
    },
    peek() {
      return finalLog !== null ? cloneSerializable(finalLog) : build()
    },
    stop() {
      if (finalLog === null) {
        detach()
        active = false
        finalLog = build()
      }
      return cloneSerializable(finalLog)
    },
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/** Why {@link replay} stopped. Errors are data: a bad log never throws. */
export type ReplayError =
  | { readonly kind: 'invalid_log'; readonly reason: string }
  | { readonly kind: 'base_mismatch'; readonly expected: string; readonly actual: string }
  | { readonly kind: 'unknown_event'; readonly event: string; readonly tick: number }
  | { readonly kind: 'rejected_payload'; readonly event: string; readonly tick: number; readonly reason: string }
  | { readonly kind: 'diverged'; readonly tick: number; readonly expected: string; readonly actual: string }

/** Options for {@link replay}. */
export interface ReplayOptions {
  /** Restore this first (else the world must already be at the log's base). Take it with `{ pendingEvents: true }`. */
  readonly base?: WorldSnapshot
  /** Stop after the frame that ends at this tick. */
  readonly toTick?: number
  /** Compare checkpoints (default true). */
  readonly verify?: boolean
  /** Called after each replayed frame with `world.time.tick`. */
  readonly onFrame?: (tick: number, world: World) => void
}

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v)
const isFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isScale = (v: unknown): boolean => isFinite(v) && v >= 0
const isTick = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0
const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string')
const isNumbers = (v: unknown): boolean => Array.isArray(v) && v.every(isFinite)

function checkInput(v: unknown): string | null {
  if (!isRec(v)) return 'is not an object'
  if (!isStrings(v.keys)) return 'keys is not an array of strings'
  if (v.pressed !== undefined && !isStrings(v.pressed)) return 'pressed is not an array of strings'
  if (v.released !== undefined && !isStrings(v.released)) return 'released is not an array of strings'
  const m = v.mods
  if (m !== undefined) {
    if (!isRec(m) || !['ctrl', 'alt', 'shift', 'meta'].every((k) => typeof m[k] === 'boolean')) {
      return 'mods is not { ctrl, alt, shift, meta } booleans'
    }
  }
  const p = v.pointer
  if (p !== undefined) {
    if (
      !isRec(p) ||
      !isFinite(p.x) ||
      !isFinite(p.y) ||
      !isFinite(p.buttons) ||
      !isFinite(p.wheel) ||
      !isRec(p.delta) ||
      !isFinite(p.delta.x) ||
      !isFinite(p.delta.y) ||
      !isNumbers(p.entered)
    ) {
      return 'pointer is not { x, y, buttons, delta: { x, y }, wheel, entered } numbers'
    }
  }
  const g = v.gamepads
  if (g !== undefined) {
    const okPad = (pad: unknown): boolean =>
      isRec(pad) &&
      isFinite(pad.index) &&
      isNumbers(pad.axes) &&
      Array.isArray(pad.buttons) &&
      pad.buttons.every((b) => isRec(b) && typeof b.pressed === 'boolean' && isFinite(b.value))
    if (!Array.isArray(g) || !g.every(okPad)) return 'gamepads is not an array of { index, axes, buttons }'
  }
  const f = v.focus
  if (f !== undefined) {
    if (!isRec(f) || typeof f.activeTag !== 'string' || typeof f.consumesKeys !== 'boolean') {
      return 'focus is not { activeTag: string, consumesKeys: boolean }'
    }
  }
  return null
}

function checkFrame(f: unknown): string | null {
  if (!isRec(f)) return 'is not an object'
  if (!isTick(f.tick)) return 'tick is not a non-negative integer'
  if (f.dt !== null && !(isFinite(f.dt) && f.dt > 0)) return 'dt is not null or a positive finite number'
  if (f.scale !== undefined && !isScale(f.scale)) return 'scale is not a non-negative finite number'
  if (f.hookScale !== undefined && !isScale(f.hookScale)) return 'hookScale is not a non-negative finite number'
  if (f.acts !== undefined) {
    if (!Array.isArray(f.acts)) return 'acts is not an array'
    for (let i = 0; i < f.acts.length; i++) {
      const a: unknown = f.acts[i]
      if (!isRec(a) || typeof a.event !== 'string') return `acts[${i}].event is not a string`
      if (a.via !== 'emit' && a.via !== 'action') return `acts[${i}].via is not 'emit' or 'action'`
    }
  }
  if (f.input !== undefined) {
    const bad = checkInput(f.input)
    if (bad !== null) return `input ${bad}`
  }
  return null
}

/** A reason the log is malformed, or `null`. Reads defensively; never throws. */
function checkLog(log: unknown): string | null {
  try {
    if (!isRec(log)) return 'the log is not an object'
    if (log.format !== 'domecs-actlog') return `format is ${JSON.stringify(log.format) ?? 'undefined'}, expected "domecs-actlog"`
    if (log.version !== 1) return `version is ${JSON.stringify(log.version) ?? 'undefined'}, expected 1`
    if (!isTick(log.startTick)) return 'startTick is not a non-negative integer'
    if (!(isFinite(log.fixedStep) && log.fixedStep > 0)) return 'fixedStep is not a positive finite number'
    if (!isScale(log.startScale)) return 'startScale is not a non-negative finite number'
    if (typeof log.baseHash !== 'string') return 'baseHash is not a string'
    if (!Array.isArray(log.frames)) return 'frames is not an array'
    for (let i = 0; i < log.frames.length; i++) {
      const bad = checkFrame(log.frames[i])
      if (bad !== null) return `frames[${i}] ${bad}`
    }
    if (log.checkpoints !== undefined) {
      if (!Array.isArray(log.checkpoints)) return 'checkpoints is not an array'
      for (let i = 0; i < log.checkpoints.length; i++) {
        const c: unknown = log.checkpoints[i]
        if (!isRec(c) || !isTick(c.tick) || typeof c.hash !== 'string') return `checkpoints[${i}] is not { tick, hash }`
      }
    }
    if (log.gaps !== undefined) {
      if (!Array.isArray(log.gaps)) return 'gaps is not an array'
      for (let i = 0; i < log.gaps.length; i++) {
        const g: unknown = log.gaps[i]
        if (!isRec(g) || !isTick(g.tick) || typeof g.reason !== 'string') return `gaps[${i}] is not { tick, reason }`
      }
    }
    return null
  } catch (cause) {
    return `the log could not be read: ${cause instanceof Error ? cause.message : String(cause)}`
  }
}

/**
 * Apply one log frame to `world` (§7.1 replay step 3): resolve every act
 * (`unknown_event` / `rejected_payload` before any emit), set the scale and
 * input, emit the acts in order, then `stepOnce()` or `step(dt)` — with the
 * frame's `hookScale` set from a one-step `signals.tickStart` subscription.
 * Returns `null` when the frame was applied. The frame must be valid
 * (checked by {@link replay}); shared with `runBranch` (§7.2).
 */
export function applyActFrame(world: World, frame: ActLogFrame): ReplayError | null {
  const resolved: Array<{ type: EventType<unknown>; payload: unknown }> = []
  for (const act of frame.acts ?? []) {
    const type = world.lookupEvent(act.event)
    if (type === undefined) return { kind: 'unknown_event', event: act.event, tick: frame.tick }
    const payload = act.payload === undefined ? undefined : cloneSerializable(act.payload)
    if (act.via === 'action') {
      const reason = validateEventPayload(type, payload)
      if (reason !== null) return { kind: 'rejected_payload', event: act.event, tick: frame.tick, reason }
    }
    resolved.push({ type, payload })
  }
  if (frame.scale !== undefined) world.setScale(frame.scale)
  if (frame.input !== undefined) world.setInput(decodeInput(frame.input))
  for (const { type, payload } of resolved) world.emit(type, payload)
  const hookScale = frame.hookScale
  const unsubscribe =
    hookScale === undefined ? undefined : world.signals.tickStart.subscribe(() => world.setScale(hookScale))
  try {
    if (frame.dt === null) world.stepOnce()
    else world.step(frame.dt)
  } finally {
    unsubscribe?.()
  }
  return null
}

/**
 * Replay `log` on `world` (§7.1): optionally `restore(options.base)`, then
 * `setScale(log.startScale)`, check the strict base hash, and apply every
 * frame (acts by name through `lookupEvent`, schema-validated only when
 * recorded `via: 'action'`; scale; input; `stepOnce()`/`step(dt)`),
 * comparing checkpoints unless `verify: false`.
 *
 * Preconditions (SPEC §7.5): the same setup (systems, plugins, order) as the
 * recording world, minus every stimulus source — no input plugin, no plugin
 * or hook that emits events or sets `time.scale` at tick start (their
 * effects are in the log) — and no enabled `once` system the source had
 * already run.
 *
 * A malformed log, a log for another `fixedStep`, a world not at the base,
 * an unknown act or a checkpoint mismatch is an error value, never a throw.
 * `restore(base)` throws for a malformed snapshot, by its own contract.
 */
export function replay(
  world: World,
  log: ActLog,
  options: ReplayOptions = {},
): Result<{ readonly ticks: number; readonly hash: string }, ReplayError> {
  const bad = checkLog(log)
  if (bad !== null) return err({ kind: 'invalid_log', reason: bad })
  if (log.fixedStep !== world.time.fixedStep) {
    return err({
      kind: 'invalid_log',
      reason: `the log was recorded at fixedStep ${log.fixedStep}, the world steps at ${world.time.fixedStep}`,
    })
  }
  if (options.base !== undefined) world.restore(options.base)
  world.setScale(log.startScale)
  const actual = actLogHash(world)
  if (actual !== log.baseHash) return err({ kind: 'base_mismatch', expected: log.baseHash, actual })

  const verify = options.verify !== false
  const checkpoints = log.checkpoints ?? []
  let next = 0
  let ticks = 0
  for (const frame of log.frames) {
    if (options.toTick !== undefined && frame.tick >= options.toTick) break
    const failed = applyActFrame(world, frame)
    if (failed !== null) return err(failed)
    ticks++
    // Checkpoints were taken at frame ends, in frame order.
    const cp = checkpoints[next]
    if (cp !== undefined && cp.tick === frame.tick + 1) {
      next++
      if (verify) {
        const hash = actLogHash(world)
        if (hash !== cp.hash) return err({ kind: 'diverged', tick: cp.tick, expected: cp.hash, actual: hash })
      }
    }
    options.onFrame?.(world.time.tick, world)
  }
  return ok({ ticks, hash: actLogHash(world) })
}
