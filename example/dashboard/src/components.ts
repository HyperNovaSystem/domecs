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
})

/**
 * The lift platform itself. `height` is an aggregate derived from cylinder
 * extensions — systems don't write it directly except via the aggregator.
 */
export const Lift = defineComponent<{
  heightM: number
  targetHeightM: number | null
}>('Lift', { defaults: { heightM: 0, targetHeightM: null } })

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
})

/**
 * Operator controls attached to the lift entity.
 */
export const Safety = defineComponent<{ eStop: boolean }>('Safety', {
  defaults: { eStop: false },
})

export const Control = defineComponent<{ mode: ControlMode }>('Control', {
  defaults: { mode: 'manual' },
})

export const PID = defineComponent<{
  kp: number
  ki: number
  kd: number
  integral: number
  lastError: number
}>('PID', {
  defaults: { kp: 4.0, ki: 0.6, kd: 0.8, integral: 0, lastError: 0 },
})
