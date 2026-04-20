import { defineComponent } from 'domecs'

export type TableState =
  | 'free'
  | 'seated'      // customer sitting; needs order taken
  | 'ordering'    // waiter at table taking order
  | 'cooking'     // order in kitchen
  | 'ready'       // food cooked; needs delivery
  | 'serving'     // waiter delivering food
  | 'eating'      // customer eating
  | 'done'        // finished; check + bus needed
  | 'clearing'    // waiter at table billing/clearing

export type WaiterState =
  | 'idle'
  | 'seating'
  | 'taking'
  | 'serving'
  | 'clearing'

export type CustomerState = 'queued' | 'seated' | 'leaving'

/**
 * Single global config + counters live on the Restaurant entity.
 * `arrivalRatePerSec` is a Poisson rate; the arrival system rolls each tick.
 */
export const Restaurant = defineComponent<{
  tableCount: number
  arrivalRatePerSec: number
  customerPatienceSec: number
  seatTime: number
  orderTime: number
  cookTime: number
  serveTime: number
  eatTime: number
  clearTime: number
  billPerSeat: number
}>('Restaurant', {
  defaults: {
    tableCount: 8,
    arrivalRatePerSec: 0.35,
    customerPatienceSec: 30,
    seatTime: 1.2,
    orderTime: 2.4,
    cookTime: 6.0,
    serveTime: 1.0,
    eatTime: 10.0,
    clearTime: 1.5,
    billPerSeat: 24,
  },
})

export const Stats = defineComponent<{
  served: number
  walked: number
  revenue: number
  totalArrivals: number
  queueSize: number
}>('Stats', {
  defaults: { served: 0, walked: 0, revenue: 0, totalArrivals: 0, queueSize: 0 },
})

export const Table = defineComponent<{
  index: number
  state: TableState
  customerId: number | null
  waiterId: number | null
  /** seconds remaining for whatever process owns this table (cooking/eating/etc). */
  timer: number
}>('Table', {
  defaults: { index: 0, state: 'free', customerId: null, waiterId: null, timer: 0 },
})

export const Waiter = defineComponent<{
  index: number
  state: WaiterState
  tableId: number | null
  /** seconds remaining for current task (seating/taking/serving/clearing). */
  timer: number
}>('Waiter', {
  defaults: { index: 0, state: 'idle', tableId: null, timer: 0 },
})

export const Customer = defineComponent<{
  state: CustomerState
  patience: number
  tableId: number | null
  arrivalTick: number
}>('Customer', {
  defaults: { state: 'queued', patience: 30, tableId: null, arrivalTick: 0 },
})
