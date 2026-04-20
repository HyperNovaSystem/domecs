import { describe, expect, it } from 'vitest'
import {
  Customer,
  createRestaurant,
  HireWaiterEvent,
  Restaurant,
  ResetEvent,
  SetArrivalRateEvent,
  Stats,
  Table,
  Waiter,
} from '../src/index.js'

const DT = 1 / 30 // 33ms; coarse enough to run long sims fast.

function runSeconds(step: (dt: number) => void, seconds: number): void {
  const steps = Math.max(1, Math.round(seconds / DT))
  for (let i = 0; i < steps; i++) step(DT)
}

function countCustomersByState(
  world: ReturnType<typeof createRestaurant>['world'],
  state: 'queued' | 'seated' | 'leaving',
): number {
  let n = 0
  for (const t of world.componentTypes()) {
    if (t.name !== 'Customer') continue
    // fall through to query path
  }
  // Simple iteration via archetype query
  let count = 0
  // Walk every entity: cheap enough for tests.
  // (No public iterator; use the engine query instead.)
  const q = world.query({ kind: 'has', type: Customer })
  for (const e of q.entities) {
    const c = world.getComponent(e.id, Customer)
    if (c && c.state === state) count++
  }
  return count + n
}

describe('arrival', () => {
  it('produces customers at roughly the configured Poisson rate', () => {
    const { world } = createRestaurant({
      seed: 1,
      arrivalRatePerSec: 1.0,
      tableCount: 0,
      waiterCount: 1,
      customerPatienceSec: 600, // long; we're only testing arrivals
    })
    runSeconds((d) => world.step(d), 60)
    // Expected ≈ 60 arrivals; permissive bounds for a single seed.
    const stats = world.getComponent(1, Stats) // restaurant is entity 0; stats lives on it
    // Restaurant is spawned first, so id is 0.
    const r = world.getComponent(0, Stats)
    expect(r).toBeDefined()
    expect(r!.totalArrivals).toBeGreaterThan(30)
    expect(r!.totalArrivals).toBeLessThan(100)
  })

  it('is deterministic with the same seed', () => {
    const a = createRestaurant({ seed: 42, arrivalRatePerSec: 0.5, tableCount: 0 })
    const b = createRestaurant({ seed: 42, arrivalRatePerSec: 0.5, tableCount: 0 })
    runSeconds((d) => a.world.step(d), 30)
    runSeconds((d) => b.world.step(d), 30)
    const sa = a.world.getComponent(a.restaurantId, Stats)!
    const sb = b.world.getComponent(b.restaurantId, Stats)!
    expect(sa.totalArrivals).toBe(sb.totalArrivals)
  })
})

describe('patience', () => {
  it('walked customers despawn after patience expires when no table available', () => {
    const { world, restaurantId } = createRestaurant({
      seed: 7,
      arrivalRatePerSec: 0,
      tableCount: 0,
      customerPatienceSec: 2,
    })
    // Manually spawn one queued customer (rate=0 to avoid randomness).
    const cid = world.spawn()
    world.addComponent(cid, Customer, Customer.create({ patience: 2 }))
    runSeconds((d) => world.step(d), 3)
    const stats = world.getComponent(restaurantId, Stats)!
    expect(stats.walked).toBe(1)
    expect(world.has(cid, Customer)).toBe(false)
  })
})

describe('lifecycle', () => {
  it('seats, orders, cooks, serves, eats, bills, frees a table', () => {
    const { world, restaurantId, tableIds, waiterIds } = createRestaurant({
      seed: 99,
      arrivalRatePerSec: 0,
      tableCount: 1,
      waiterCount: 1,
      seatTime: 0.5,
      orderTime: 0.5,
      cookTime: 1.0,
      serveTime: 0.5,
      eatTime: 1.0,
      clearTime: 0.5,
      billPerSeat: 25,
    })
    // Manually inject one customer.
    const cid = world.spawn()
    world.addComponent(
      cid,
      Customer,
      Customer.create({ patience: 1000, arrivalTick: world.time.tick }),
    )

    runSeconds((d) => world.step(d), 10)

    const stats = world.getComponent(restaurantId, Stats)!
    expect(stats.served).toBe(1)
    expect(stats.revenue).toBe(25)
    expect(world.has(cid, Customer)).toBe(false)
    const t = world.getComponent(tableIds[0]!, Table)!
    expect(t.state).toBe('free')
    expect(t.customerId).toBeNull()
    expect(t.waiterId).toBeNull()
    const w = world.getComponent(waiterIds[0]!, Waiter)!
    expect(w.state).toBe('idle')
  })
})

describe('pause', () => {
  it('halts arrivals and timers while paused', () => {
    const { world, restaurantId } = createRestaurant({
      seed: 3,
      arrivalRatePerSec: 2.0,
      tableCount: 0,
      customerPatienceSec: 100,
    })
    runSeconds((d) => world.step(d), 5)
    const before = world.getComponent(restaurantId, Stats)!.totalArrivals
    world.pause()
    runSeconds((d) => world.step(d), 5)
    const afterPause = world.getComponent(restaurantId, Stats)!.totalArrivals
    expect(afterPause).toBe(before)
    world.resume()
    runSeconds((d) => world.step(d), 5)
    const afterResume = world.getComponent(restaurantId, Stats)!.totalArrivals
    expect(afterResume).toBeGreaterThan(before)
  })
})

describe('config events', () => {
  it('SetArrivalRateEvent updates Restaurant.arrivalRatePerSec', () => {
    const { world, restaurantId } = createRestaurant({
      seed: 5,
      arrivalRatePerSec: 0,
      tableCount: 0,
    })
    world.emit(SetArrivalRateEvent, { rate: 1.5 })
    world.step(DT)
    const r = world.getComponent(restaurantId, Restaurant)!
    expect(r.arrivalRatePerSec).toBe(1.5)
  })

  it('HireWaiterEvent appends a new idle waiter', () => {
    const { world, waiterIds } = createRestaurant({
      seed: 0,
      arrivalRatePerSec: 0,
      tableCount: 0,
      waiterCount: 1,
    })
    expect(waiterIds.length).toBe(1)
    world.emit(HireWaiterEvent, {})
    world.step(DT)
    expect(waiterIds.length).toBe(2)
    const w = world.getComponent(waiterIds[1]!, Waiter)!
    expect(w.state).toBe('idle')
  })
})

describe('phantom-customer regression', () => {
  it('walk during seating does not double-count customer (no phantom served)', () => {
    const { world, restaurantId, tableIds, waiterIds } = createRestaurant({
      seed: 1,
      arrivalRatePerSec: 0,
      tableCount: 1,
      waiterCount: 1,
      customerPatienceSec: 0.1, // expires almost immediately
      seatTime: 5,               // long enough for patience to elapse mid-seat
      orderTime: 0.1,
      cookTime: 0.1,
      serveTime: 0.1,
      eatTime: 0.1,
      clearTime: 0.1,
      billPerSeat: 25,
    })
    // Inject one customer with very short patience.
    const cid = world.spawn()
    world.addComponent(
      cid,
      Customer,
      Customer.create({ patience: 0.1, arrivalTick: world.time.tick }),
    )
    // Tick once so dispatcher binds the customer→table+waiter.
    world.step(1 / 60)
    // Run long enough for seating to "complete" plus full lifecycle.
    runSeconds((d) => world.step(d), 20)

    const stats = world.getComponent(restaurantId, Stats)!
    // Either the customer walked (patience expired) OR was served — never both.
    expect(stats.served + stats.walked).toBeLessThanOrEqual(1)
    // Conservation: arrivals must equal served + walked + queueSize + seated-in-flight.
    // With 1 arrival and lifecycle finished, anything still in flight is wrong.
    const t = world.getComponent(tableIds[0]!, Table)!
    const w = world.getComponent(waiterIds[0]!, Waiter)!
    // System must come to rest, not loop on a phantom.
    expect(t.state).toBe('free')
    expect(t.customerId).toBeNull()
    expect(w.state).toBe('idle')
  })
})

describe('reset', () => {
  it('clears customers, frees tables, zeros stats', () => {
    const { world, restaurantId, tableIds } = createRestaurant({
      seed: 11,
      arrivalRatePerSec: 0.8,
      tableCount: 2,
      waiterCount: 2,
      customerPatienceSec: 100,
      seatTime: 0.5,
      orderTime: 0.5,
      cookTime: 1.0,
      serveTime: 0.5,
      eatTime: 1.0,
      clearTime: 0.5,
    })
    runSeconds((d) => world.step(d), 8)
    world.emit(ResetEvent, {})
    world.step(DT)
    const stats = world.getComponent(restaurantId, Stats)!
    expect(stats.served).toBe(0)
    expect(stats.walked).toBe(0)
    expect(stats.revenue).toBe(0)
    expect(stats.totalArrivals).toBe(0)
    expect(countCustomersByState(world, 'queued')).toBe(0)
    expect(countCustomersByState(world, 'seated')).toBe(0)
    for (const tid of tableIds) {
      const t = world.getComponent(tid, Table)!
      expect(t.state).toBe('free')
      expect(t.customerId).toBeNull()
    }
  })
})
