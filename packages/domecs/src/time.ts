export interface TimeState {
  tick: number
  elapsed: number
  delta: number
  scaledDelta: number
  scale: number
  fixedStep: number
  fixedAccumulator: number
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
  }
}

// SPEC §2.7: scaledDelta is quantized to ms.
export function quantizeMs(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

/**
 * Fixed steps due after `totalScaledSeconds` of scaled time (SPEC §2.7 F-3).
 * Shared by the tick and by restore (O-40) so both derive the same count
 * from the same float expression.
 */
export function fixedStepsDue(totalScaledSeconds: number, fixedStep: number): number {
  return Math.floor(totalScaledSeconds / fixedStep + 1e-9)
}
