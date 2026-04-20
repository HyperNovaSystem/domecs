import {
  Changed,
  createWorld,
  defineEvent,
  entry,
  type World,
} from 'domecs'
import {
  Control,
  Cylinder,
  Lift,
  PID,
  Plant,
  Safety,
  type CylinderCommand,
} from './components.js'

export interface LiftRefs {
  world: World
  liftId: number
  cylinderIds: readonly [number, number, number, number]
}

export interface LiftOptions {
  seed?: number
  fixedStep?: number
}

/** Fired by the input/UI layer. Physics+controller honour it on next tick. */
export const SetCommandEvent = defineEvent<{
  index: 0 | 1 | 2 | 3
  command: CylinderCommand
}>('SetCommand')

export const EStopEvent = defineEvent<{ engaged: boolean }>('EStop')
export const ResetEvent = defineEvent<Record<string, never>>('Reset')
export const SetTargetHeightEvent = defineEvent<{ targetHeightM: number | null }>(
  'SetTargetHeight',
)

export function createLift(options: LiftOptions = {}): LiftRefs {
  const world = createWorld({
    seed: options.seed ?? 0xa11caf,
    fixedStep: options.fixedStep ?? 1 / 60,
  })

  const liftId = world.spawn([
    entry(Lift, { heightM: 0, targetHeightM: null }),
    entry(Plant, Plant.create()),
    entry(Safety, { eStop: false }),
    entry(Control, { mode: 'manual' as const }),
    entry(PID, PID.create()),
  ])

  const cylinderIds: [number, number, number, number] = [0, 0, 0, 0] as [
    number, number, number, number,
  ]
  for (let i = 0; i < 4; i++) {
    cylinderIds[i as 0 | 1 | 2 | 3] = world.spawn([
      entry(Cylinder, {
        index: i as 0 | 1 | 2 | 3,
        extension: 0,
        command: 0 as const,
        pressureKpa: 0,
        atLimit: false,
      }),
    ])
  }

  // ─── Event handlers ─────────────────────────────────────────────────
  world.system(
    'set-command',
    { schedule: 'event', triggers: [SetCommandEvent] },
    (ctx) => {
      const safety = world.getComponent(liftId, Safety)
      for (const m of ctx.events.of(SetCommandEvent)) {
        const id = cylinderIds[m.index]
        const cyl = world.getComponent(id, Cylinder)
        if (!cyl) continue
        // Safety override: E-stop pins all commands to 0.
        const next: CylinderCommand = safety?.eStop ? 0 : m.command
        if (cyl.command !== next) {
          cyl.command = next
          world.markChanged(id, Cylinder)
        }
      }
    },
  )

  world.system(
    'estop',
    { schedule: 'event', triggers: [EStopEvent] },
    (ctx) => {
      const safety = world.getComponent(liftId, Safety)
      if (!safety) return
      const last = ctx.events.of(EStopEvent).at(-1)
      if (!last) return
      if (safety.eStop !== last.engaged) {
        safety.eStop = last.engaged
        world.markChanged(liftId, Safety)
      }
      if (last.engaged) {
        for (const id of cylinderIds) {
          const c = world.getComponent(id, Cylinder)
          if (c && c.command !== 0) {
            c.command = 0
            world.markChanged(id, Cylinder)
          }
        }
      }
    },
  )

  world.system(
    'reset',
    { schedule: 'event', triggers: [ResetEvent] },
    (ctx) => {
      if (ctx.events.of(ResetEvent).length === 0) return
      const safety = world.getComponent(liftId, Safety)
      if (safety) {
        safety.eStop = false
        world.markChanged(liftId, Safety)
      }
      const ctrl = world.getComponent(liftId, Control)
      if (ctrl) {
        ctrl.mode = 'manual'
        world.markChanged(liftId, Control)
      }
      const lift = world.getComponent(liftId, Lift)
      if (lift) {
        lift.targetHeightM = null
        world.markChanged(liftId, Lift)
      }
      const pid = world.getComponent(liftId, PID)
      if (pid) {
        pid.integral = 0
        pid.lastError = 0
      }
      for (const id of cylinderIds) {
        const c = world.getComponent(id, Cylinder)
        if (!c) continue
        c.extension = 0
        c.command = 0
        c.pressureKpa = 0
        c.atLimit = false
        world.markChanged(id, Cylinder)
      }
    },
  )

  world.system(
    'set-target-height',
    { schedule: 'event', triggers: [SetTargetHeightEvent] },
    (ctx) => {
      const last = ctx.events.of(SetTargetHeightEvent).at(-1)
      if (!last) return
      const lift = world.getComponent(liftId, Lift)
      const ctrl = world.getComponent(liftId, Control)
      if (!lift || !ctrl) return
      lift.targetHeightM = last.targetHeightM
      world.markChanged(liftId, Lift)
      const nextMode = last.targetHeightM === null ? 'manual' : 'pid'
      if (ctrl.mode !== nextMode) {
        ctrl.mode = nextMode
        world.markChanged(liftId, Control)
      }
    },
  )

  // ─── PID controller (tick; only effective when mode === 'pid') ─────
  world.system(
    'pid-controller',
    { schedule: 'tick' },
    () => {
      const ctrl = world.getComponent(liftId, Control)
      const lift = world.getComponent(liftId, Lift)
      const pid = world.getComponent(liftId, PID)
      const safety = world.getComponent(liftId, Safety)
      if (!ctrl || !lift || !pid) return
      if (ctrl.mode !== 'pid' || lift.targetHeightM === null) return
      if (safety?.eStop) return
      const dt = world.time.scaledDelta || 1 / 60
      const error = lift.targetHeightM - lift.heightM
      pid.integral += error * dt
      const derivative = (error - pid.lastError) / dt
      pid.lastError = error
      const output = pid.kp * error + pid.ki * pid.integral + pid.kd * derivative
      const cmd: CylinderCommand = output > 0.05 ? 1 : output < -0.05 ? -1 : 0
      for (const id of cylinderIds) {
        const c = world.getComponent(id, Cylinder)
        if (!c || c.command === cmd) continue
        c.command = cmd
        world.markChanged(id, Cylinder)
      }
      // Snap to target if close; prevents integral windup / chatter.
      if (Math.abs(error) < 0.005) {
        pid.integral *= 0.5
      }
    },
  )

  // ─── Hydraulic physics (fixed step) ────────────────────────────────
  world.system(
    'hydraulic-physics',
    { schedule: 'fixed' },
    () => {
      const plant = world.getComponent(liftId, Plant)
      if (!plant) return
      const dt = world.time.fixedStep
      const perCylLoadKpa = (plant.massKg * plant.loadKpa) / 4

      for (const id of cylinderIds) {
        const c = world.getComponent(id, Cylinder)
        if (!c) continue

        const desiredV = c.command * plant.rateMps
        let nextExt = c.extension + desiredV * dt
        let hitLimit = false
        if (nextExt <= 0) { nextExt = 0; hitLimit = c.command < 0 }
        else if (nextExt >= 1) { nextExt = 1; hitLimit = c.command > 0 }

        // Pressure model: baseline + load share + flow resistance when moving,
        // with a sharp spike when hammered against an end-stop.
        const flowingKpa = Math.abs(c.command) > 0 && !hitLimit ? plant.flowKpa : 0
        const limitKpa = hitLimit ? plant.flowKpa * 2 : 0
        let nextPressure = plant.tareKpa + perCylLoadKpa + flowingKpa + limitKpa
        if (nextPressure > plant.maxKpa) nextPressure = plant.maxKpa

        const changed =
          c.extension !== nextExt || c.pressureKpa !== nextPressure || c.atLimit !== hitLimit
        c.extension = nextExt
        c.pressureKpa = nextPressure
        c.atLimit = hitLimit
        if (changed) world.markChanged(id, Cylinder)
      }
    },
  )

  // ─── Lift-height aggregator (reactive on any cylinder change) ──────
  world.system(
    'lift-aggregate',
    { schedule: 'reactive', reactsTo: Changed(Cylinder) },
    () => {
      const plant = world.getComponent(liftId, Plant)
      const lift = world.getComponent(liftId, Lift)
      if (!plant || !lift) return
      let total = 0
      for (const id of cylinderIds) {
        total += world.getComponent(id, Cylinder)?.extension ?? 0
      }
      const next = (total / 4) * plant.strokeM
      if (Math.abs(next - lift.heightM) > 1e-9) {
        lift.heightM = next
        world.markChanged(liftId, Lift)
      }
    },
  )

  return { world, liftId, cylinderIds }
}
