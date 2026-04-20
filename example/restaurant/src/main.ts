import { Has, type EntityView } from 'domecs'
import { defineView, mountDOM } from 'domecs-dom'
import { createInputPlugin } from 'domecs-input'
import {
  Customer,
  FireWaiterEvent,
  HireWaiterEvent,
  Restaurant,
  ResetEvent,
  SetArrivalRateEvent,
  Stats,
  Table,
  Waiter,
  createRestaurant,
} from './index.js'

const floor = document.getElementById('floor') as HTMLElement
const queueEl = document.getElementById('queue') as HTMLElement
const staffEl = document.getElementById('staff') as HTMLElement
const statsEl = document.getElementById('stats') as HTMLElement
const chrome = document.getElementById('chrome') as HTMLElement

const { world, restaurantId } = createRestaurant({
  tableCount: 8,
  waiterCount: 3,
})

// ─── View: tables grid ──────────────────────────────────────────────
const tableView = defineView({
  slot: 'floor',
  query: Has(Table),
  changedOn: [Table],
  create(e) {
    const t = world.getComponent(e.id, Table)
    const el = document.createElement('div')
    el.className = 'table-card'
    el.innerHTML = `
      <div class="idx">T${(t?.index ?? 0) + 1}</div>
      <div class="state">free</div>
      <div class="bar"><div></div></div>
      <div class="timer"></div>
    `
    paintTable(el, e)
    return el
  },
  update(el, e) { paintTable(el, e) },
})

function paintTable(el: HTMLElement, e: EntityView): void {
  const t = world.getComponent(e.id, Table)
  if (!t) return
  el.className = `table-card state-${t.state}`
  const stateEl = el.querySelector<HTMLElement>('.state')
  if (stateEl) stateEl.textContent = t.state
  const timerEl = el.querySelector<HTMLElement>('.timer')
  if (timerEl) timerEl.textContent = t.timer > 0 ? `${t.timer.toFixed(1)}s` : ''
  const bar = el.querySelector<HTMLElement>('.bar > div')
  if (bar) {
    const r = world.getComponent(restaurantId, Restaurant)
    const total = stateDuration(t.state, r)
    const pct = total > 0 ? Math.max(0, Math.min(1, 1 - t.timer / total)) * 100 : 0
    bar.style.width = `${pct}%`
  }
}

function stateDuration(
  state: import('./components.js').TableState,
  r: ReturnType<typeof Restaurant.create> | undefined,
): number {
  if (!r) return 0
  switch (state) {
    case 'cooking': return r.cookTime
    case 'eating': return r.eatTime
    case 'ordering': return r.orderTime
    case 'serving': return r.serveTime
    case 'clearing': return r.clearTime
    default: return 0
  }
}

mountDOM(world, {
  slots: { floor },
  views: [tableView],
})

// ─── HUD: queue dots, waiter pills, stats — manual repaint ──────────
function paintHUD(): void {
  const r = world.getComponent(restaurantId, Restaurant)
  const stats = world.getComponent(restaurantId, Stats)
  if (!r || !stats) return

  // Queue dots: query customers, render queued ones (fade as patience runs out).
  const queued: Array<{ id: number; patience: number }> = []
  const customerQ = world.query(Has(Customer))
  for (const e of customerQ.entities) {
    const c = world.getComponent(e.id, Customer)
    if (c && c.state === 'queued') queued.push({ id: e.id, patience: c.patience })
  }
  queueEl.innerHTML = queued
    .map((q) => {
      const ratio = r.customerPatienceSec > 0 ? q.patience / r.customerPatienceSec : 1
      const fading = ratio < 0.4 ? 'fading' : ''
      return `<div class="queued-dot ${fading}" title="patience ${q.patience.toFixed(1)}s"></div>`
    })
    .join('')

  // Waiter pills.
  const waiters = world.query(Has(Waiter))
  const pills: string[] = []
  const idx: number[] = []
  for (const e of waiters.entities) {
    const w = world.getComponent(e.id, Waiter)
    if (!w) continue
    idx.push(w.index)
    pills.push(`<span class="waiter-pill ${w.state}">W${w.index + 1} · ${w.state}</span>`)
  }
  // Sort by index for stable order.
  const ordered = pills
    .map((p, i) => ({ p, i: idx[i] ?? 0 }))
    .sort((a, b) => a.i - b.i)
    .map((x) => x.p)
  staffEl.innerHTML = ordered.join('')

  const paused = world.time.scale === 0
  statsEl.innerHTML = `
    <div class="row"><span class="k">queue</span><span class="v queue">${stats.queueSize}</span></div>
    <div class="row"><span class="k">arrivals</span><span class="v">${stats.totalArrivals}</span></div>
    <div class="row"><span class="k">served</span><span class="v">${stats.served}</span></div>
    <div class="row"><span class="k">walked</span><span class="v walked">${stats.walked}</span></div>
    <div class="row"><span class="k">revenue</span><span class="v revenue">$${stats.revenue.toFixed(0)}</span></div>
    <div class="row"><span class="k">arrival/s</span><span class="v">${r.arrivalRatePerSec.toFixed(2)}</span></div>
    ${paused ? '<div class="paused">⏸ PAUSED</div>' : ''}
  `
}

function paintChrome(): void {
  const stats = world.getComponent(restaurantId, Stats)
  const r = world.getComponent(restaurantId, Restaurant)
  if (!stats || !r) return
  const paused = world.time.scale === 0 ? '  [paused]' : ''
  chrome.textContent =
    `tick ${world.time.tick.toString().padStart(5)}  ` +
    `t ${world.time.elapsed.toFixed(1).padStart(6)}s  ` +
    `arrivals ${stats.totalArrivals.toString().padStart(3)}  ` +
    `seated ${(stats.totalArrivals - stats.walked - stats.served - stats.queueSize).toString().padStart(2)}  ` +
    `served ${stats.served.toString().padStart(3)}  ` +
    `walked ${stats.walked.toString().padStart(3)}  ` +
    `revenue $${stats.revenue.toFixed(0).padStart(4)}  ` +
    `rate ${r.arrivalRatePerSec.toFixed(2)}/s${paused}`
}

// ─── Input plugin + edge-triggered hotkeys ──────────────────────────
world.use(createInputPlugin({ preventDefaultKeys: true }))

world.system(
  'input-dispatch',
  { schedule: 'tick' },
  () => {
    const input = world.input
    if (input.keyDelta.pressed.has('KeyP')) {
      if (world.time.scale === 0) world.resume()
      else world.pause()
    }
    if (input.keyDelta.pressed.has('KeyR')) {
      world.emit(ResetEvent, {})
    }
    const r = world.getComponent(restaurantId, Restaurant)
    if (input.keyDelta.pressed.has('ArrowUp') && r) {
      world.emit(SetArrivalRateEvent, { rate: r.arrivalRatePerSec + 0.1 })
    }
    if (input.keyDelta.pressed.has('ArrowDown') && r) {
      world.emit(SetArrivalRateEvent, { rate: Math.max(0, r.arrivalRatePerSec - 0.1) })
    }
    if (input.keyDelta.pressed.has('Equal') || input.keyDelta.pressed.has('NumpadAdd')) {
      world.emit(HireWaiterEvent, {})
    }
    if (input.keyDelta.pressed.has('Minus') || input.keyDelta.pressed.has('NumpadSubtract')) {
      world.emit(FireWaiterEvent, {})
    }
  },
)

// HUD redraw every tick-end (cheap; ~20 small DOM ops).
world.signals.tickEnd.subscribe(() => {
  paintHUD()
  paintChrome()
})

// Prime + start.
world.step(0)
paintHUD()
paintChrome()
world.start({ dtClampMs: 100 })
