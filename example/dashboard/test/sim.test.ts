import { describe, expect, it } from 'vitest'
import {
  createLift,
  Cylinder,
  EStopEvent,
  Lift,
  ResetEvent,
  Safety,
  SetCommandEvent,
} from '../src/index.js'

const DT = 1 / 60

function runSeconds(step: (dt: number) => void, seconds: number): void {
  const steps = Math.round(seconds / DT)
  for (let i = 0; i < steps; i++) step(DT)
}

describe('hydraulic physics', () => {
  it('extends a cylinder under command=1 at rateMps over time', () => {
    const { world, cylinderIds } = createLift()
    world.emit(SetCommandEvent, { index: 0, command: 1 })
    // 1 s at rateMps=0.25 → extension should be ~0.25 of 1.0 stroke.
    runSeconds((d) => world.step(d), 1)
    const c = world.getComponent(cylinderIds[0], Cylinder)!
    expect(c.extension).toBeGreaterThan(0.2)
    expect(c.extension).toBeLessThan(0.3)
    expect(c.command).toBe(1)
    expect(c.pressureKpa).toBeGreaterThan(0)
  })

  it('aggregates lift height from mean cylinder extension', () => {
    const { world, liftId, cylinderIds } = createLift()
    for (const idx of [0, 1, 2, 3] as const) {
      world.emit(SetCommandEvent, { index: idx, command: 1 })
    }
    runSeconds((d) => world.step(d), 2)
    const lift = world.getComponent(liftId, Lift)!
    // After 2 s at 0.25 m/s all four should be around 0.5 m → lift height ~0.5.
    expect(lift.heightM).toBeGreaterThan(0.4)
    expect(lift.heightM).toBeLessThan(0.6)
    const mean =
      cylinderIds
        .map((id) => world.getComponent(id, Cylinder)!.extension)
        .reduce((a, b) => a + b, 0) / 4
    expect(Math.abs(lift.heightM - mean)).toBeLessThan(1e-6)
  })

  it('clamps extension to [0,1] and flags atLimit', () => {
    const { world, cylinderIds } = createLift()
    world.emit(SetCommandEvent, { index: 0, command: 1 })
    runSeconds((d) => world.step(d), 10)
    const c = world.getComponent(cylinderIds[0], Cylinder)!
    expect(c.extension).toBe(1)
    expect(c.atLimit).toBe(true)
  })

  it('pressure rises while flowing and spikes at the end-stop', () => {
    const { world, cylinderIds } = createLift()
    world.emit(SetCommandEvent, { index: 0, command: 1 })
    runSeconds((d) => world.step(d), 0.5)
    const flowing = world.getComponent(cylinderIds[0], Cylinder)!.pressureKpa
    runSeconds((d) => world.step(d), 10)
    const atStop = world.getComponent(cylinderIds[0], Cylinder)!.pressureKpa
    expect(atStop).toBeGreaterThan(flowing)
  })
})

describe('safety interlocks', () => {
  it('E-stop zeros all commands and ignores new ones until released', () => {
    const { world, liftId, cylinderIds } = createLift()
    world.emit(SetCommandEvent, { index: 0, command: 1 })
    world.emit(SetCommandEvent, { index: 1, command: -1 })
    runSeconds((d) => world.step(d), 0.2)

    world.emit(EStopEvent, { engaged: true })
    world.step(DT)
    expect(world.getComponent(liftId, Safety)!.eStop).toBe(true)
    for (const id of cylinderIds) {
      expect(world.getComponent(id, Cylinder)!.command).toBe(0)
    }
    // New commands during E-stop are pinned to 0.
    world.emit(SetCommandEvent, { index: 0, command: 1 })
    world.step(DT)
    expect(world.getComponent(cylinderIds[0], Cylinder)!.command).toBe(0)

    // Release and command again; should take effect.
    world.emit(EStopEvent, { engaged: false })
    world.step(DT)
    world.emit(SetCommandEvent, { index: 0, command: 1 })
    world.step(DT)
    expect(world.getComponent(cylinderIds[0], Cylinder)!.command).toBe(1)
  })

  it('reset returns all state to zero', () => {
    const { world, liftId, cylinderIds } = createLift()
    world.emit(SetCommandEvent, { index: 0, command: 1 })
    runSeconds((d) => world.step(d), 1)
    world.emit(ResetEvent, {})
    world.step(DT)
    const c = world.getComponent(cylinderIds[0], Cylinder)!
    expect(c.extension).toBe(0)
    expect(c.command).toBe(0)
    expect(world.getComponent(liftId, Lift)!.heightM).toBeCloseTo(0, 6)
    expect(world.getComponent(liftId, Safety)!.eStop).toBe(false)
  })
})
