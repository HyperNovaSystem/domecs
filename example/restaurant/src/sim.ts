import {
  createWorld,
  defineEvent,
  entry,
  Has,
  type World,
} from 'domecs'
import {
  Customer,
  Restaurant,
  Stats,
  Table,
  Waiter,
} from './components.js'

export interface RestaurantRefs {
  world: World
  restaurantId: number
  tableIds: readonly number[]
  waiterIds: readonly number[]
}

export interface RestaurantOptions {
  seed?: number
  tableCount?: number
  waiterCount?: number
  arrivalRatePerSec?: number
  customerPatienceSec?: number
  seatTime?: number
  orderTime?: number
  cookTime?: number
  serveTime?: number
  eatTime?: number
  clearTime?: number
  billPerSeat?: number
}

export const ResetEvent = defineEvent<Record<string, never>>('Reset')
export const SetArrivalRateEvent = defineEvent<{ rate: number }>('SetArrivalRate')
export const HireWaiterEvent = defineEvent<Record<string, never>>('HireWaiter')
export const FireWaiterEvent = defineEvent<Record<string, never>>('FireWaiter')

export function createRestaurant(options: RestaurantOptions = {}): RestaurantRefs {
  const tableCount = options.tableCount ?? 8
  const initialWaiters = options.waiterCount ?? 2

  const world = createWorld({ seed: options.seed ?? 0xfeed })

  const restaurantId = world.spawn([
    entry(
      Restaurant,
      Restaurant.create({
        tableCount,
        ...(options.arrivalRatePerSec !== undefined && {
          arrivalRatePerSec: options.arrivalRatePerSec,
        }),
        ...(options.customerPatienceSec !== undefined && {
          customerPatienceSec: options.customerPatienceSec,
        }),
        ...(options.seatTime !== undefined && { seatTime: options.seatTime }),
        ...(options.orderTime !== undefined && { orderTime: options.orderTime }),
        ...(options.cookTime !== undefined && { cookTime: options.cookTime }),
        ...(options.serveTime !== undefined && { serveTime: options.serveTime }),
        ...(options.eatTime !== undefined && { eatTime: options.eatTime }),
        ...(options.clearTime !== undefined && { clearTime: options.clearTime }),
        ...(options.billPerSeat !== undefined && { billPerSeat: options.billPerSeat }),
      }),
    ),
    entry(Stats, Stats.create()),
  ])

  const tableIds: number[] = []
  for (let i = 0; i < tableCount; i++) {
    tableIds.push(world.spawn([entry(Table, Table.create({ index: i }))]))
  }

  const waiterIds: number[] = []
  function hire(): number {
    const id = world.spawn([entry(Waiter, Waiter.create({ index: waiterIds.length }))])
    waiterIds.push(id)
    return id
  }
  for (let i = 0; i < initialWaiters; i++) hire()

  // ─── Queries (long-lived; engine reuses them across ticks) ──────────
  const customers = world.query(Has(Customer))

  // ─── Arrival (Poisson roll per tick) ────────────────────────────────
  world.system(
    'arrival',
    { schedule: 'tick' },
    () => {
      const r = world.getComponent(restaurantId, Restaurant)
      if (!r) return
      const dt = world.time.scaledDelta
      if (dt <= 0) return
      const p = r.arrivalRatePerSec * dt
      if (world.rand.next() < p) {
        world.spawn([
          entry(
            Customer,
            Customer.create({
              state: 'queued',
              patience: r.customerPatienceSec,
              tableId: null,
              arrivalTick: world.time.tick,
            }),
          ),
        ])
        const stats = world.getComponent(restaurantId, Stats)
        if (stats) {
          stats.totalArrivals += 1
          world.markChanged(restaurantId, Stats)
        }
      }
    },
  )

  // ─── Patience countdown (queued customers walk if ignored) ──────────
  world.system(
    'patience',
    { schedule: 'tick' },
    () => {
      const dt = world.time.scaledDelta
      if (dt <= 0) return
      const stats = world.getComponent(restaurantId, Stats)
      const toWalk: number[] = []
      for (const e of customers.entities) {
        const c = world.getComponent(e.id, Customer)
        if (!c || c.state !== 'queued') continue
        // Bound to a table → seating in progress; patience no longer applies.
        if (c.tableId !== null) continue
        c.patience -= dt
        if (c.patience <= 0) toWalk.push(e.id)
        else world.markChanged(e.id, Customer)
      }
      for (const id of toWalk) {
        world.despawn(id)
        if (stats) stats.walked += 1
      }
      if (toWalk.length > 0 && stats) world.markChanged(restaurantId, Stats)
    },
  )

  // ─── Dispatcher: assign idle waiters to highest-priority task ───────
  world.system(
    'dispatcher',
    { schedule: 'tick' },
    () => {
      const r = world.getComponent(restaurantId, Restaurant)
      if (!r) return
      for (const wid of waiterIds) {
        const w = world.getComponent(wid, Waiter)
        if (!w || w.state !== 'idle') continue

        // Priority 1: clear a 'done' table (frees capacity, posts revenue).
        const doneTable = findTableByState(world, tableIds, 'done')
        if (doneTable !== null) {
          assign(world, wid, w, doneTable, 'clearing', r.clearTime)
          continue
        }
        // Priority 2: serve a 'ready' table (food sitting in window).
        const readyTable = findTableByState(world, tableIds, 'ready')
        if (readyTable !== null) {
          assign(world, wid, w, readyTable, 'serving', r.serveTime)
          continue
        }
        // Priority 3: take an order from a 'seated' table.
        const seatedTable = findTableByState(world, tableIds, 'seated')
        if (seatedTable !== null) {
          assign(world, wid, w, seatedTable, 'taking', r.orderTime)
          continue
        }
        // Priority 4: seat a queued customer at a free table.
        const freeTable = findTableByState(world, tableIds, 'free')
        if (freeTable === null) continue
        const queuedId = findFirstQueuedCustomer(world, customers)
        if (queuedId === null) continue

        // Bind customer ↔ table at seating start so lifecycle stays joined.
        const t = world.getComponent(freeTable, Table)
        const c = world.getComponent(queuedId, Customer)
        if (!t || !c) continue
        t.customerId = queuedId
        c.tableId = freeTable
        assign(world, wid, w, freeTable, 'seating', r.seatTime)
        world.markChanged(queuedId, Customer)
      }
    },
  )

  // ─── Waiter task progress (timer countdown + completion) ────────────
  world.system(
    'waiter-task',
    { schedule: 'tick' },
    () => {
      const r = world.getComponent(restaurantId, Restaurant)
      if (!r) return
      const dt = world.time.scaledDelta
      if (dt <= 0) return
      for (const wid of waiterIds) {
        const w = world.getComponent(wid, Waiter)
        if (!w || w.state === 'idle') continue
        w.timer -= dt
        world.markChanged(wid, Waiter)
        if (w.timer > 0) continue
        completeTask(world, restaurantId, wid, w, r)
      }
    },
  )

  // ─── Kitchen: cooking timer ─────────────────────────────────────────
  world.system(
    'kitchen',
    { schedule: 'tick' },
    () => {
      const dt = world.time.scaledDelta
      if (dt <= 0) return
      for (const tid of tableIds) {
        const t = world.getComponent(tid, Table)
        if (!t || t.state !== 'cooking') continue
        t.timer -= dt
        if (t.timer <= 0) {
          t.state = 'ready'
          t.timer = 0
        }
        world.markChanged(tid, Table)
      }
    },
  )

  // ─── Eat-timer: customer dines, then needs check ────────────────────
  world.system(
    'eat-timer',
    { schedule: 'tick' },
    () => {
      const dt = world.time.scaledDelta
      if (dt <= 0) return
      for (const tid of tableIds) {
        const t = world.getComponent(tid, Table)
        if (!t || t.state !== 'eating') continue
        t.timer -= dt
        if (t.timer <= 0) {
          t.state = 'done'
          t.timer = 0
        }
        world.markChanged(tid, Table)
      }
    },
  )

  // ─── Stats: refresh derived queueSize each tick ─────────────────────
  world.system(
    'stats-refresh',
    { schedule: 'tick' },
    () => {
      const stats = world.getComponent(restaurantId, Stats)
      if (!stats) return
      let q = 0
      for (const e of customers.entities) {
        const c = world.getComponent(e.id, Customer)
        if (c && c.state === 'queued') q++
      }
      if (stats.queueSize !== q) {
        stats.queueSize = q
        world.markChanged(restaurantId, Stats)
      }
    },
  )

  // ─── Reset (event) ──────────────────────────────────────────────────
  world.system(
    'reset',
    { schedule: 'event', triggers: [ResetEvent] },
    (ctx) => {
      if (ctx.events.of(ResetEvent).length === 0) return
      // Wipe customers.
      const ids: number[] = []
      for (const e of customers.entities) ids.push(e.id)
      for (const id of ids) world.despawn(id)
      // Reset tables.
      for (const tid of tableIds) {
        const t = world.getComponent(tid, Table)
        if (!t) continue
        t.state = 'free'
        t.customerId = null
        t.waiterId = null
        t.timer = 0
        world.markChanged(tid, Table)
      }
      // Reset waiters.
      for (const wid of waiterIds) {
        const w = world.getComponent(wid, Waiter)
        if (!w) continue
        w.state = 'idle'
        w.tableId = null
        w.timer = 0
        world.markChanged(wid, Waiter)
      }
      // Reset stats.
      const stats = world.getComponent(restaurantId, Stats)
      if (stats) {
        stats.served = 0
        stats.walked = 0
        stats.revenue = 0
        stats.totalArrivals = 0
        stats.queueSize = 0
        world.markChanged(restaurantId, Stats)
      }
    },
  )

  // ─── Live config events ─────────────────────────────────────────────
  world.system(
    'set-arrival-rate',
    { schedule: 'event', triggers: [SetArrivalRateEvent] },
    (ctx) => {
      const last = ctx.events.of(SetArrivalRateEvent).at(-1)
      if (!last) return
      const r = world.getComponent(restaurantId, Restaurant)
      if (!r) return
      r.arrivalRatePerSec = Math.max(0, last.rate)
      world.markChanged(restaurantId, Restaurant)
    },
  )

  world.system(
    'hire-waiter',
    { schedule: 'event', triggers: [HireWaiterEvent] },
    (ctx) => {
      for (const _ of ctx.events.of(HireWaiterEvent)) hire()
    },
  )

  world.system(
    'fire-waiter',
    { schedule: 'event', triggers: [FireWaiterEvent] },
    (ctx) => {
      for (const _ of ctx.events.of(FireWaiterEvent)) {
        if (waiterIds.length <= 1) return
        // Prefer firing an idle waiter; else fire the last one regardless.
        let victim = -1
        for (let i = waiterIds.length - 1; i >= 0; i--) {
          const id = waiterIds[i]!
          const w = world.getComponent(id, Waiter)
          if (w && w.state === 'idle') { victim = i; break }
        }
        if (victim < 0) victim = waiterIds.length - 1
        const id = waiterIds[victim]!
        world.despawn(id)
        waiterIds.splice(victim, 1)
      }
    },
  )

  return { world, restaurantId, tableIds, waiterIds }
}

// ─── helpers ─────────────────────────────────────────────────────────

function findTableByState(
  world: World,
  tableIds: readonly number[],
  state: import('./components.js').TableState,
): number | null {
  for (const id of tableIds) {
    const t = world.getComponent(id, Table)
    if (t && t.state === state && t.waiterId === null) return id
  }
  return null
}

function findFirstQueuedCustomer(
  world: World,
  customers: import('domecs').QueryResult,
): number | null {
  let best = -1
  let bestTick = Number.POSITIVE_INFINITY
  for (const e of customers.entities) {
    const c = world.getComponent(e.id, Customer)
    if (!c || c.state !== 'queued') continue
    if (c.arrivalTick < bestTick) {
      bestTick = c.arrivalTick
      best = e.id
    }
  }
  return best === -1 ? null : best
}

function assign(
  world: World,
  waiterId: number,
  w: ReturnType<typeof Waiter.create>,
  tableId: number,
  task: import('./components.js').WaiterState,
  duration: number,
): void {
  w.state = task
  w.tableId = tableId
  w.timer = duration
  world.markChanged(waiterId, Waiter)
  const t = world.getComponent(tableId, Table)
  if (!t) return
  t.waiterId = waiterId
  // Move table into the corresponding "in-progress" state so other waiters
  // don't double-book.
  switch (task) {
    case 'seating': t.state = 'free'; break // stays free; waiter is escorting from queue
    case 'taking': t.state = 'ordering'; break
    case 'serving': t.state = 'serving'; break
    case 'clearing': t.state = 'clearing'; break
  }
  t.timer = duration
  world.markChanged(tableId, Table)
}

function completeTask(
  world: World,
  restaurantId: number,
  waiterId: number,
  w: ReturnType<typeof Waiter.create>,
  r: ReturnType<typeof Restaurant.create>,
): void {
  const tableId = w.tableId
  const t = tableId !== null ? world.getComponent(tableId, Table) : null
  switch (w.state) {
    case 'seating': {
      if (t && tableId !== null) {
        const c =
          t.customerId !== null ? world.getComponent(t.customerId, Customer) : null
        if (c) {
          t.state = 'seated'
          t.timer = 0
          t.waiterId = null
          c.state = 'seated'
          world.markChanged(tableId, Table)
          world.markChanged(t.customerId!, Customer)
        } else {
          // Customer vanished mid-seating (shouldn't happen w/ patience guard).
          // Abort safely: free the table.
          t.state = 'free'
          t.timer = 0
          t.waiterId = null
          t.customerId = null
          world.markChanged(tableId, Table)
        }
      }
      break
    }
    case 'taking': {
      if (t && tableId !== null) {
        t.state = 'cooking'
        t.timer = r.cookTime
        t.waiterId = null
        world.markChanged(tableId, Table)
      }
      break
    }
    case 'serving': {
      if (t && tableId !== null) {
        t.state = 'eating'
        t.timer = r.eatTime
        t.waiterId = null
        world.markChanged(tableId, Table)
      }
      break
    }
    case 'clearing': {
      if (t && tableId !== null) {
        const stats = world.getComponent(restaurantId, Stats)
        if (stats) {
          stats.served += 1
          stats.revenue += r.billPerSeat
          world.markChanged(restaurantId, Stats)
        }
        if (t.customerId !== null) world.despawn(t.customerId)
        t.state = 'free'
        t.customerId = null
        t.waiterId = null
        t.timer = 0
        world.markChanged(tableId, Table)
      }
      break
    }
    default: break
  }
  w.state = 'idle'
  w.tableId = null
  w.timer = 0
  world.markChanged(waiterId, Waiter)
}
