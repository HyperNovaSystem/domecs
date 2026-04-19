import { describe, expect, it } from 'vitest'
import {
  Control,
  createLift,
  Lift,
  SetTargetHeightEvent,
} from '../src/index.js'

const DT = 1 / 60

describe('PID target-height controller', () => {
  it('drives lift height toward target and enters PID mode', () => {
    const { world, liftId } = createLift()
    world.emit(SetTargetHeightEvent, { targetHeightM: 0.5 })
    // Step one tick so the event is consumed and mode flips.
    world.step(DT)
    expect(world.getComponent(liftId, Control)!.mode).toBe('pid')

    // Let physics + controller settle — 20 seconds is ample for a 1 m/s plant.
    for (let i = 0; i < 20 * 60; i++) world.step(DT)

    const lift = world.getComponent(liftId, Lift)!
    expect(Math.abs(lift.heightM - 0.5)).toBeLessThan(0.05)
  })

  it('clearing target returns to manual mode', () => {
    const { world, liftId } = createLift()
    world.emit(SetTargetHeightEvent, { targetHeightM: 0.3 })
    world.step(DT)
    expect(world.getComponent(liftId, Control)!.mode).toBe('pid')
    world.emit(SetTargetHeightEvent, { targetHeightM: null })
    world.step(DT)
    expect(world.getComponent(liftId, Control)!.mode).toBe('manual')
    expect(world.getComponent(liftId, Lift)!.targetHeightM).toBeNull()
  })
})
