export interface TimeState {
  /** Frames (ticks) run since the world started. */
  tick: number
  /**
   * Scaled seconds since the world started, ms-quantized (SPEC §2.7). Inside
   * a `fixed` system: the fixed clock, `fixedTick × fixedStep`, the scaled
   * time at the end of the step being run (H-3).
   */
  elapsed: number
  /**
   * Seconds this frame was asked to advance, before scaling. Inside a
   * `fixed` system: the system's step, `fixedStep` (× its divisor for a
   * `rateHz` system).
   */
  delta: number
  /**
   * Scaled seconds this frame advanced, ms-quantized. Inside a `fixed`
   * system: the system's step, as `delta` — integrate with it.
   */
  scaledDelta: number
  scale: number
  /** The world's fixed step in scaled seconds (`createWorld({ fixedStep })`). */
  fixedStep: number
  /**
   * Scaled seconds accumulated toward the next fixed step and not yet run.
   * Below one `fixedStep` after a completed tick, unless a `tickStart` hook
   * paused the world after time advanced (the owed steps run on resume).
   */
  fixedAccumulator: number
  /**
   * Fixed steps run since the world started (H-3). Inside a `fixed` system:
   * the 1-based index of the step being run. Use it for deadlines a
   * fixed-step simulation counts in steps.
   */
  fixedTick: number
  /**
   * How far the scaled clock is into the next fixed step, from 0 to 1:
   * `fixedAccumulator / fixedStep`, clamped. Views use it to draw fixed-step
   * state between steps (interpolation).
   */
  alpha: number
}

export function createTime(fixedStep: number): TimeState {
  return {
    tick: 0,
    elapsed: 0,
    delta: 0,
    scaledDelta: 0,
    scale: 1,
    fixedStep,
    fixedAccumulator: 0,
    fixedTick: 0,
    alpha: 0,
  }
}

// SPEC §2.7: scaledDelta is quantized to ms.
export function quantizeMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

/**
 * The share of a step the accumulator must hold for that step to run. Just
 * under 1, so a frame of n steps (`step(n × fixedStep)`) runs n although
 * `n × fixedStep − (n − 1) × fixedStep` may round to a hair under one step.
 */
const STEP_DUE = 1 - 1e-9

/** Whether `accumulator` scaled seconds hold a fixed step of `fixedStep` (H-16). */
export function fixedStepDue(accumulator: number, fixedStep: number): boolean {
  return accumulator >= fixedStep * STEP_DUE
}

/**
 * Whole fixed steps of `fixedStep` in `seconds`, with the tolerance of
 * {@link fixedStepDue}. The live clock never uses it: it counts steps off a
 * remainder below one step (H-16). Restore uses it to read a pre-H-16
 * snapshot, which carries only the cumulative total, and to re-count a
 * snapshot's steps in another `fixedStep`.
 */
export function fixedStepsDue(seconds: number, fixedStep: number): number {
  return Math.floor(seconds / fixedStep + 1e-9)
}

/** `fixedAccumulator / fixedStep`, clamped to [0, 1]: {@link TimeState.alpha}. */
export function fixedAlpha(accumulator: number, fixedStep: number): number {
  const a = accumulator / fixedStep
  return a <= 0 ? 0 : a >= 1 ? 1 : a
}
