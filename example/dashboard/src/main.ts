import { Has, type EntityView } from 'domecs'
import { defineView, mountDOM } from 'domecs-dom'
import { createInputPlugin } from 'domecs-input'
import {
  Control,
  Cylinder,
  EStopEvent,
  Lift,
  PID,
  Plant,
  ResetEvent,
  Safety,
  SetCommandEvent,
  SetTargetHeightEvent,
  createLift,
} from './index.js'
import type { CylinderCommand } from './components.js'

const stage = document.getElementById('stage') as HTMLElement
const hud = document.getElementById('hud') as HTMLElement
const chrome = document.getElementById('chrome') as HTMLElement

const { world, liftId, cylinderIds } = createLift()

// ─── View: platform (one per Lift entity) ────────────────────────────────
const platformView = defineView({
  slot: 'stage',
  query: Has(Lift),
  changedOn: [Lift],
  create() {
    const el = document.createElement('div')
    el.className = 'platform'
    return el
  },
  update(el, e) {
    const lift = world.getComponent(e.id, Lift)
    const plant = world.getComponent(e.id, Plant)
    if (!lift || !plant) return
    // Stage is 420px tall, ground strip 40px. Extension 0..1 → bottom 40..(40+340).
    const bottomPx = 40 + (lift.heightM / plant.strokeM) * 340
    el.style.bottom = `${bottomPx}px`
  },
})

const GROUND_EL = (() => {
  const el = document.createElement('div')
  el.className = 'ground'
  return el
})()
stage.appendChild(GROUND_EL)

// ─── View: cylinder stage tower ─────────────────────────────────────────
const cylinderStageView = defineView({
  slot: 'stage',
  query: Has(Cylinder),
  changedOn: [Cylinder, Safety],
  create(e: EntityView) {
    const cyl = world.getComponent(e.id, Cylinder)
    const el = document.createElement('div')
    el.className = 'cylinder'
    el.dataset.index = String(cyl?.index ?? 0)
    el.style.left = `${18 + (cyl?.index ?? 0) * 22}%`
    el.innerHTML = `
      <div class="barrel"><div class="piston"></div></div>
      <div class="label">CYL ${(cyl?.index ?? 0) + 1}</div>
    `
    paintCylinderStage(el, e)
    return el
  },
  update(el, e) { paintCylinderStage(el, e) },
})

function paintCylinderStage(el: HTMLElement, e: EntityView): void {
  const cyl = world.getComponent(e.id, Cylinder)
  if (!cyl) return
  const piston = el.querySelector<HTMLElement>('.piston')
  if (piston) piston.style.height = `${cyl.extension * 100}%`
  el.classList.toggle('at-limit', cyl.atLimit)
  el.classList.toggle('commanding-up', cyl.command === 1)
  el.classList.toggle('commanding-down', cyl.command === -1)
  const safety = world.getComponent(liftId, Safety)
  el.classList.toggle('estop', !!safety?.eStop)
}

// ─── View: HUD pressure gauges (one per cylinder) ───────────────────────
const gaugeView = defineView({
  slot: 'hud',
  query: Has(Cylinder),
  changedOn: [Cylinder, Safety],
  create(e) {
    const cyl = world.getComponent(e.id, Cylinder)
    const el = document.createElement('div')
    el.className = 'gauge'
    el.innerHTML = `
      <div class="head"><span>CYL ${(cyl?.index ?? 0) + 1}</span><span class="val">0 kPa</span></div>
      <div class="bar"><div class="fill" style="width:0%"></div></div>
    `
    paintGauge(el, e)
    return el
  },
  update(el, e) { paintGauge(el, e) },
})

function paintGauge(el: HTMLElement, e: EntityView): void {
  const cyl = world.getComponent(e.id, Cylinder)
  const plant = world.getComponent(liftId, Plant)
  const safety = world.getComponent(liftId, Safety)
  if (!cyl || !plant) return
  const pct = Math.max(0, Math.min(1, cyl.pressureKpa / plant.maxKpa)) * 100
  const val = el.querySelector<HTMLElement>('.val')
  if (val) val.textContent = `${cyl.pressureKpa.toFixed(0)} kPa`
  const fill = el.querySelector<HTMLElement>('.fill')
  if (fill) fill.style.width = `${pct}%`
  el.classList.toggle('high', cyl.pressureKpa > plant.maxKpa * 0.85)
  el.classList.toggle('estop', !!safety?.eStop)
}

// ─── Height card (one-off HUD footer) ───────────────────────────────────
const heightCard = document.createElement('div')
heightCard.id = 'height-card'
hud.appendChild(heightCard)
function paintHeightCard(): void {
  const lift = world.getComponent(liftId, Lift)
  const ctrl = world.getComponent(liftId, Control)
  const plant = world.getComponent(liftId, Plant)
  const safety = world.getComponent(liftId, Safety)
  if (!lift || !ctrl || !plant) return
  const targetLine =
    lift.targetHeightM === null
      ? '<span class="target">—</span>'
      : `<span class="target">${lift.targetHeightM.toFixed(3)} m</span>`
  const modeCls = ctrl.mode === 'pid' ? 'mode-pid' : 'mode-manual'
  heightCard.innerHTML = `
    <div>height</div>
    <div class="big">${lift.heightM.toFixed(3)} m <span style="font-size:11px;color:var(--dim)">of ${plant.strokeM.toFixed(2)}</span></div>
    <div>target ${targetLine}</div>
    <div>mode <span class="${modeCls}">${ctrl.mode.toUpperCase()}</span></div>
    ${safety?.eStop ? '<div class="estop-banner">E-STOP</div>' : ''}
  `
}

// ─── Chrome: status line (manual render on signals) ─────────────────────
function paintChrome(): void {
  const lift = world.getComponent(liftId, Lift)
  const ctrl = world.getComponent(liftId, Control)
  const safety = world.getComponent(liftId, Safety)
  const pid = world.getComponent(liftId, PID)
  const cyls = cylinderIds.map((id) => world.getComponent(id, Cylinder))
  const hdr = `tick ${world.time.tick.toString().padStart(5)}  height ${(lift?.heightM ?? 0).toFixed(3)} m  ` +
    `mode ${(ctrl?.mode ?? '?').padEnd(6)}  ` +
    `target ${lift?.targetHeightM === null || lift?.targetHeightM === undefined ? '  —  ' : lift.targetHeightM.toFixed(3)}`
  const estopLine = safety?.eStop ? '  **E-STOP ENGAGED** (press X to reset)' : ''
  const pidLine = ctrl?.mode === 'pid'
    ? `  PID  err ${(pid?.lastError ?? 0).toFixed(3)}  int ${(pid?.integral ?? 0).toFixed(3)}`
    : ''
  const cylLine = cyls
    .map((c, i) =>
      c
        ? `c${i + 1}:ext ${c.extension.toFixed(2)} cmd ${c.command.toString().padStart(2)} ${c.pressureKpa.toFixed(0).padStart(5)}kPa${c.atLimit ? '*' : ' '}`
        : `c${i + 1}:—`,
    )
    .join('   ')
  chrome.textContent = `${hdr}${estopLine}${pidLine}\n${cylLine}`
}

// ─── Mount + input plugin ────────────────────────────────────────────────
mountDOM(world, {
  slots: { stage, hud },
  views: [platformView, cylinderStageView, gaugeView],
})

world.use(
  createInputPlugin({
    preventDefaultKeys: true,
  }),
)

// ─── Input → events ─────────────────────────────────────────────────────
const EXTEND_KEYS: Record<string, 0 | 1 | 2 | 3> = {
  KeyQ: 0, KeyW: 1, KeyE: 2, KeyR: 3,
}
const RETRACT_KEYS: Record<string, 0 | 1 | 2 | 3> = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3,
}

// System: translates held key state into per-cylinder commands every tick.
// Manual mode only — PID mode ignores keyboard cylinder commands.
world.system(
  'input-dispatch',
  { schedule: 'tick' },
  () => {
    const ctrl = world.getComponent(liftId, Control)
    const safety = world.getComponent(liftId, Safety)
    const input = world.input
    // Edge-triggered controls.
    if (input.keyDelta.pressed.has('Space')) {
      world.emit(EStopEvent, { engaged: !safety?.eStop })
    }
    if (input.keyDelta.pressed.has('KeyX')) {
      world.emit(ResetEvent, {})
    }
    if (input.keyDelta.pressed.has('KeyH')) {
      // Exit PID: drop target, back to manual.
      if (ctrl?.mode === 'pid') {
        world.emit(SetTargetHeightEvent, { targetHeightM: null })
      } else {
        queueMicrotask(() => {
          const raw = window.prompt('Target height (m, 0..1.00):', '0.60')
          if (raw === null) return
          const v = Number(raw)
          if (!Number.isFinite(v)) return
          const plant = world.getComponent(liftId, Plant)
          const clamped = Math.max(0, Math.min(plant?.strokeM ?? 1, v))
          world.emit(SetTargetHeightEvent, { targetHeightM: clamped })
        })
      }
    }
    // Hold → command (manual mode only).
    if (ctrl?.mode !== 'manual') return
    for (let i = 0 as 0 | 1 | 2 | 3; i < 4; i = (i + 1) as 0 | 1 | 2 | 3) {
      const extendKey = Object.entries(EXTEND_KEYS).find(([, v]) => v === i)?.[0]
      const retractKey = Object.entries(RETRACT_KEYS).find(([, v]) => v === i)?.[0]
      const extending = extendKey ? input.keys.has(extendKey) : false
      const retracting = retractKey ? input.keys.has(retractKey) : false
      const cmd: CylinderCommand = extending && !retracting ? 1 : retracting && !extending ? -1 : 0
      const cyl = world.getComponent(cylinderIds[i], Cylinder)
      if (cyl && cyl.command !== cmd) {
        world.emit(SetCommandEvent, { index: i, command: cmd })
      }
    }
  },
)

// ─── HUD repaint triggers (tick-end signal) ─────────────────────────────
world.signals.tickEnd.subscribe(() => {
  paintHeightCard()
  paintChrome()
})

// ─── Realtime loop (F-5 engine driver) ──────────────────────────────────
// Prime derived state (heartbeat: no system execution), then hand the
// frame pump to the engine so tab-return freezes do not detonate the
// fixed-step physics.
world.step(0)
paintHeightCard()
paintChrome()
world.start({ dtClampMs: 100 })
