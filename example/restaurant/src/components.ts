import { defineComponent } from '@domecs/core'

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
  validate: (value) => {
    if (!Number.isInteger(value.tableCount) || value.tableCount < 0) return 'tableCount must be a non-negative integer'
    if (!Number.isFinite(value.arrivalRatePerSec) || value.arrivalRatePerSec < 0) return 'arrivalRatePerSec must be a non-negative finite number'
    if (!Number.isFinite(value.customerPatienceSec) || value.customerPatienceSec < 0) return 'customerPatienceSec must be a non-negative finite number'
    if (!Number.isFinite(value.seatTime) || value.seatTime < 0) return 'seatTime must be a non-negative finite number'
    if (!Number.isFinite(value.orderTime) || value.orderTime < 0) return 'orderTime must be a non-negative finite number'
    if (!Number.isFinite(value.cookTime) || value.cookTime < 0) return 'cookTime must be a non-negative finite number'
    if (!Number.isFinite(value.serveTime) || value.serveTime < 0) return 'serveTime must be a non-negative finite number'
    if (!Number.isFinite(value.eatTime) || value.eatTime < 0) return 'eatTime must be a non-negative finite number'
    if (!Number.isFinite(value.clearTime) || value.clearTime < 0) return 'clearTime must be a non-negative finite number'
    if (!Number.isFinite(value.billPerSeat) || value.billPerSeat < 0) return 'billPerSeat must be a non-negative finite number'
    return true
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
  validate: (value) => {
    if (!Number.isFinite(value.served) || value.served < 0) return 'served must be a non-negative finite number'
    if (!Number.isFinite(value.walked) || value.walked < 0) return 'walked must be a non-negative finite number'
    if (!Number.isFinite(value.revenue) || value.revenue < 0) return 'revenue must be a non-negative finite number'
    if (!Number.isFinite(value.totalArrivals) || value.totalArrivals < 0) return 'totalArrivals must be a non-negative finite number'
    if (!Number.isFinite(value.queueSize) || value.queueSize < 0) return 'queueSize must be a non-negative finite number'
    return true
  },
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
  validate: (value) => {
    if (!Number.isInteger(value.index) || value.index < 0) return 'table index must be a non-negative integer'
    if (!Number.isFinite(value.timer) || value.timer < 0) return 'table timer must be a non-negative finite number'
    if (value.customerId !== null && (!Number.isInteger(value.customerId) || value.customerId < 0)) return 'customerId must be null or a non-negative integer'
    if (value.waiterId !== null && (!Number.isInteger(value.waiterId) || value.waiterId < 0)) return 'waiterId must be null or a non-negative integer'
    return true
  },
})

export const Waiter = defineComponent<{
  index: number
  state: WaiterState
  tableId: number | null
  /** seconds remaining for current task (seating/taking/serving/clearing). */
  timer: number
}>('Waiter', {
  defaults: { index: 0, state: 'idle', tableId: null, timer: 0 },
  validate: (value) => {
    if (!Number.isInteger(value.index) || value.index < 0) return 'waiter index must be a non-negative integer'
    if (!Number.isFinite(value.timer) || value.timer < 0) return 'waiter timer must be a non-negative finite number'
    if (value.tableId !== null && (!Number.isInteger(value.tableId) || value.tableId < 0)) return 'tableId must be null or a non-negative integer'
    return true
  },
})

export const Customer = defineComponent<{
  state: CustomerState
  patience: number
  tableId: number | null
  arrivalTick: number
}>('Customer', {
  defaults: { state: 'queued', patience: 30, tableId: null, arrivalTick: 0 },
  validate: (value) => {
    if (!Number.isFinite(value.patience) || value.patience < 0) return 'patience must be a non-negative finite number'
    if (value.tableId !== null && (!Number.isInteger(value.tableId) || value.tableId < 0)) return 'tableId must be null or a non-negative integer'
    if (!Number.isInteger(value.arrivalTick) || value.arrivalTick < 0) return 'arrivalTick must be a non-negative integer'
    return true
  },
})
