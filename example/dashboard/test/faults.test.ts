import { describe, expect, it } from 'vitest'
import { Faulted, Has } from '@domecs/core'
import {
  Cylinder,
  Plant,
  SetCommandEvent,
  createLift,
} from '../src/index.js'

const DT = 1 / 60

function runSeconds(step: (dt: number) => void, seconds: number): void {
  const steps = Math.round(seconds / DT)
  for (let i = 0; i < steps; i++) step(DT)
}

describe('BETTER_ERRORS — dashboard safety-monitor', () => {
  it('attaches Faulted to a cylinder commanded against its end-stop', () => {
    const { world, cylinderIds, liftId } = createLift()
    world.emit(SetCommandEvent, { index: 0, command: 1 })
    // Drive cylinder 0 hard into end-stop — atLimit + nonzero command = overdrive.
    runSeconds((d) => world.step(d), 8)
    const plant = world.getComponent(liftId, Plant)!
    const c = world.getComponent(cylinderIds[0], Cylinder)!
    expect(c.atLimit).toBe(true)
    // Hammering against end-stop produces the limit-spike pressure addition;
    // the safety-monitor fires before the absolute maxKpa ceiling is reached.
    expect(c.pressureKpa).toBeGreaterThan(plant.tareKpa + plant.flowKpa)

    const faulted = world.getComponent(cylinderIds[0], Faulted)
    expect(faulted).toBeDefined()
    const overp = faulted!.faults.find((f) => f.kind === 'lift/overpressure')
    expect(overp).toBeDefined()
    expect(overp!.recoverable).toBe(true)
    expect(overp!.component).toBe('Cylinder')
  })

  it('clears Faulted once cylinder retreats from end-stop and pressure drops', () => {
    const { world, cylinderIds } = createLift()
    world.emit(SetCommandEvent, { index: 0, command: 1 })
    runSeconds((d) => world.step(d), 8)
    expect(world.has(cylinderIds[0], Faulted)).toBe(true)
    // Retract — pressure drops below threshold; safety-monitor clears Faulted.
    world.emit(SetCommandEvent, { index: 0, command: -1 })
    runSeconds((d) => world.step(d), 2)
    expect(world.has(cylinderIds[0], Faulted)).toBe(false)
  })

  it('healthy cylinders never accumulate Faulted', () => {
    const { world } = createLift()
    world.emit(SetCommandEvent, { index: 0, command: 1 })
    runSeconds((d) => world.step(d), 1)
    expect(world.query(Has(Faulted)).size).toBe(0)
  })
})
