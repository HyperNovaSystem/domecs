import { describe, expect, it } from 'vitest'
import { Faulted } from '@domecs/core'
import { Customer, createRestaurant } from '../src/index.js'

const DT = 1 / 30

function runSeconds(step: (dt: number) => void, seconds: number): void {
  const steps = Math.max(1, Math.round(seconds / DT))
  for (let i = 0; i < steps; i++) step(DT)
}

describe('BETTER_ERRORS — restaurant fault stream', () => {
  it('attaches Faulted to the restaurant when a queued customer walks', () => {
    const { world, restaurantId } = createRestaurant({
      seed: 7,
      arrivalRatePerSec: 0,
      tableCount: 0,
      customerPatienceSec: 1,
    })
    const cid = world.spawn()
    world.addComponent(cid, Customer, Customer.create({ patience: 1 }))
    runSeconds((d) => world.step(d), 2)

    const faulted = world.getComponent(restaurantId, Faulted)
    expect(faulted).toBeDefined()
    const walked = faulted!.faults.find((f) => f.kind === 'restaurant/customer_walked')
    expect(walked).toBeDefined()
    expect(walked!.recoverable).toBe(true)
  })

  it('consolidator collapses repeated walked faults to a single entry per (source, kind)', () => {
    const { world, restaurantId } = createRestaurant({
      seed: 3,
      arrivalRatePerSec: 0,
      tableCount: 0,
      customerPatienceSec: 1,
    })
    for (let i = 0; i < 4; i++) {
      const cid = world.spawn()
      world.addComponent(cid, Customer, Customer.create({ patience: 1 }))
    }
    runSeconds((d) => world.step(d), 2)

    const faulted = world.getComponent(restaurantId, Faulted)
    expect(faulted).toBeDefined()
    const walks = faulted!.faults.filter((f) => f.kind === 'restaurant/customer_walked')
    expect(walks.length).toBe(1)
  })
})
