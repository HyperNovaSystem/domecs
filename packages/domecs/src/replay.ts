// §7.1 (G4; O-80): act logs. A recorder writes down what entered a world
// from outside — external emits, the dt and scale of each step, the input
// systems saw — so a fresh world restored from the same base replays to the
// same strict hashes.
import { actTapOf, type ActTapListener } from './act-tap.js'
import { canonicalJson, hashSnapshot } from './canonical.js'
import type { GamepadSnapshot, InputSnapshot, PointerSnapshot } from './input.js'
import type { JsonValue } from './result.js'
import { cloneSerializable } from './snapshot.js'
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
