import { defineComponent } from 'domecs'

export type ControlMode = 'manual' | 'pid'
export type CylinderCommand = -1 | 0 | 1

/**
 * One of the four hydraulic cylinders. `extension` is the normalized piston
 * extension (0 = fully retracted, 1 = fully extended). `command` is the user-
 * or PID-issued intent that the physics system integrates each fixed step.
 */
export const Cylinder = defineComponent<{
  index: 0 | 1 | 2 | 3
  extension: number
  command: CylinderCommand
  pressureKpa: number
  atLimit: boolean
}>('Cylinder', {
  defaults: { index: 0, extension: 0, command: 0, pressureKpa: 0, atLimit: false },
  validate: (value) => {
    if (![0, 1, 2, 3].includes(value.index)) return 'cylinder index must be 0, 1, 2, or 3'
    if (!Number.isFinite(value.extension) || value.extension < 0 || value.extension > 1) return 'extension must be a finite number in [0, 1]'
    if (![-1, 0, 1].includes(value.command)) return 'command must be -1, 0, or 1'
    if (!Number.isFinite(value.pressureKpa) || value.pressureKpa < 0) return 'pressureKpa must be a non-negative finite number'
    return true
  },
})

/**
 * The lift platform itself. `height` is an aggregate derived from cylinder
 * extensions — systems don't write it directly except via the aggregator.
 */
export const Lift = defineComponent<{
  heightM: number
  targetHeightM: number | null
}>('Lift', {
  defaults: { heightM: 0, targetHeightM: null },
  validate: (value) => {
    if (!Number.isFinite(value.heightM) || value.heightM < 0) return 'heightM must be a non-negative finite number'
    if (value.targetHeightM !== null && (!Number.isFinite(value.targetHeightM) || value.targetHeightM < 0)) {
      return 'targetHeightM must be null or a non-negative finite number'
    }
    return true
  },
})

/**
 * Fixed plant parameters for the lift. Stored on the same entity as `Lift`.
 */
export const Plant = defineComponent<{
  strokeM: number           // max physical stroke per cylinder (metres)
  rateMps: number           // extend/retract speed at command=1
  massKg: number            // lift platform + payload
  tareKpa: number           // baseline cylinder pressure at rest
  loadKpa: number           // additional pressure per kg of load, distributed
  flowKpa: number           // pressure rise while flowing (velocity-proportional)
  maxKpa: number            // hard pressure ceiling (safety trip)
}>('Plant', {
  defaults: {
    strokeM: 1.0,
    rateMps: 0.25,
    massKg: 1200,
    tareKpa: 400,
    loadKpa: 0.8,
    flowKpa: 300,
    maxKpa: 3500,
  },
  validate: (value) => {
    if (!Number.isFinite(value.strokeM) || value.strokeM <= 0) return 'strokeM must be a positive finite number'
    if (!Number.isFinite(value.rateMps) || value.rateMps <= 0) return 'rateMps must be a positive finite number'
    if (!Number.isFinite(value.massKg) || value.massKg <= 0) return 'massKg must be a positive finite number'
    if (!Number.isFinite(value.tareKpa) || value.tareKpa < 0) return 'tareKpa must be a non-negative finite number'
    if (!Number.isFinite(value.loadKpa) || value.loadKpa < 0) return 'loadKpa must be a non-negative finite number'
    if (!Number.isFinite(value.flowKpa) || value.flowKpa < 0) return 'flowKpa must be a non-negative finite number'
    if (!Number.isFinite(value.maxKpa) || value.maxKpa <= 0) return 'maxKpa must be a positive finite number'
    return true
  },
})

/**
 * Operator controls attached to the lift entity.
 */
export const Safety = defineComponent<{ eStop: boolean }>('Safety', {
  defaults: { eStop: false },
  validate: (value) => typeof value.eStop === 'boolean' || 'eStop must be a boolean',
})

export const Control = defineComponent<{ mode: ControlMode }>('Control', {
  defaults: { mode: 'manual' },
  validate: (value) => (value.mode === 'manual' || value.mode === 'pid') || 'mode must be "manual" or "pid"',
})

export const PID = defineComponent<{
  kp: number
  ki: number
  kd: number
  integral: number
  lastError: number
}>('PID', {
  defaults: { kp: 4.0, ki: 0.6, kd: 0.8, integral: 0, lastError: 0 },
  validate: (value) => {
    if (!Number.isFinite(value.kp)) return 'kp must be a finite number'
    if (!Number.isFinite(value.ki)) return 'ki must be a finite number'
    if (!Number.isFinite(value.kd)) return 'kd must be a finite number'
    if (!Number.isFinite(value.integral)) return 'integral must be a finite number'
    if (!Number.isFinite(value.lastError)) return 'lastError must be a finite number'
    return true
  },
})
