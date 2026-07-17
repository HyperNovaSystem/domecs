/**
 * Plantroom browser shell — multi-view DOM + agent controls + trend canvas.
 */
import { createAgentBridge, isOk } from '@domecs/core'
import { defineView, mountDOM } from '@domecs/dom'
import {
  createPlantWorld,
  Tag,
  Alarm,
  Pump,
  Vessel,
} from './model-browser.js'

const plant = createPlantWorld({ seed: [42, 7, 13, 99] })
const { world, ids, components, events } = plant
const bridge = createAgentBridge(world)
bridge.captureBaseline()
const fixedStep = world.time.fixedStep

const history = { level: [], temp: [], max: 120 }

// --- multi-view projection (tags / alarms / plant) ---------------------------

const tagView = defineView({
  slot: 'tags',
  query: [Tag],
  create: () => {
    const el = document.createElement('div')
    el.className = 'tag-row'
    el.innerHTML = `<span class="name"></span><span class="value"></span>`
    return el
  },
  update: (el, e) => {
    el.querySelector('.name').textContent = `${e.Tag.name}`
    el.querySelector('.value').textContent =
      `${e.Tag.value.toFixed(1)} ${e.Tag.unit}`
  },
})

const alarmView = defineView({
  slot: 'alarms',
  query: [Alarm],
  create: () => {
    const el = document.createElement('div')
    el.className = 'alarm-row'
    el.innerHTML = `<span class="code"></span><span class="msg"></span>`
    return el
  },
  update: (el, e) => {
    const a = e.Alarm
    el.classList.toggle('active', a.active)
    el.classList.toggle('warn', a.severity === 'alarm' || a.severity === 'warn')
    el.querySelector('.code').textContent = a.code
    el.querySelector('.msg').textContent = a.active ? a.message : '— clear —'
  },
})

const plantView = defineView({
  slot: 'plant',
  query: [Vessel, Pump],
  create: () => {
    const el = document.createElement('div')
    el.className = 'plant-card'
    el.innerHTML = `
      <div class="kv"><span>Level</span><span class="level"></span></div>
      <div class="kv"><span>Temp</span><span class="temp"></span></div>
      <div class="kv"><span>Pump</span><span class="pump"></span></div>
    `
    return el
  },
  update: (el, e) => {
    el.querySelector('.level').textContent = `${e.Vessel.level.toFixed(1)} %`
    el.querySelector('.temp').textContent = `${e.Vessel.temp.toFixed(1)} °C`
    const pump = el.querySelector('.pump')
    if (e.Pump.trip) {
      pump.textContent = 'TRIP'
      pump.className = 'pump bad'
    } else if (e.Pump.running) {
      pump.textContent = 'RUNNING'
      pump.className = 'pump ok'
    } else {
      pump.textContent = 'STOPPED'
      pump.className = 'pump'
    }
  },
})

const mounted = mountDOM(world, {
  slots: {
    tags: document.getElementById('slot-tags'),
    alarms: document.getElementById('slot-alarms'),
    plant: document.getElementById('slot-plant'),
  },
  views: [tagView, alarmView, plantView],
})
if (!isOk(mounted)) {
  document.getElementById('status').textContent = `mount failed: ${mounted.error.kind}`
  throw new Error(JSON.stringify(mounted.error))
}

// --- trend canvas ------------------------------------------------------------

const canvas = document.getElementById('trend')
const ctx = canvas.getContext('2d')

function sampleTrend() {
  const v = world.getComponent(ids.vessel, Vessel)
  if (!v) return
  history.level.push(v.level)
  history.temp.push(v.temp)
  if (history.level.length > history.max) {
    history.level.shift()
    history.temp.shift()
  }
}

function drawTrend() {
  const w = canvas.width
  const h = canvas.height
  ctx.fillStyle = '#0a0e13'
  ctx.fillRect(0, 0, w, h)
  const draw = (series, color) => {
    if (series.length < 2) return
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.beginPath()
    series.forEach((y, i) => {
      const x = (i / (history.max - 1)) * (w - 8) + 4
      const py = h - 4 - (y / 120) * (h - 8)
      if (i === 0) ctx.moveTo(x, py)
      else ctx.lineTo(x, py)
    })
    ctx.stroke()
  }
  draw(history.level, '#3d9cf0')
  draw(history.temp, '#e6b84d')
  ctx.fillStyle = '#8b9bb0'
  ctx.font = '11px system-ui'
  ctx.fillText('level', 8, 14)
  ctx.fillStyle = '#e6b84d'
  ctx.fillText('temp', 48, 14)
}

// --- loop + controls ---------------------------------------------------------

let running = true
const statusEl = document.getElementById('status')
const branchEl = document.getElementById('branch')

function readOutcome() {
  const vessel = world.getComponent(ids.vessel, Vessel)
  const pump = world.getComponent(ids.pump, Pump)
  const trip = world.getComponent(ids.alarmTrip, Alarm)
  const hi = world.getComponent(ids.alarmHi, Alarm)
  return {
    level: vessel?.level ?? 0,
    temp: vessel?.temp ?? 0,
    pumpRunning: !!(pump?.running && !pump?.trip),
    pumpTrip: !!pump?.trip,
    alarmTrip: !!trip?.active,
    alarmHiLevel: !!hi?.active,
  }
}

function refreshStatus(extra = '') {
  const o = readOutcome()
  const obs = bridge.observe()
  statusEl.textContent = [
    `tick=${obs.tick} scale=${obs.scale}`,
    `level=${o.level.toFixed(1)} temp=${o.temp.toFixed(1)}`,
    `pump=${o.pumpTrip ? 'TRIP' : o.pumpRunning ? 'run' : 'stop'}`,
    `alarms: trip=${o.alarmTrip} hi=${o.alarmHiLevel}`,
    extra,
  ]
    .filter(Boolean)
    .join(' · ')
}

function fastForward(steps) {
  for (let i = 0; i < steps; i++) {
    world.step(fixedStep)
    sampleTrend()
  }
  drawTrend()
  refreshStatus()
}

world.signals.tickEnd.subscribe(() => {
  sampleTrend()
  drawTrend()
  refreshStatus()
})

document.getElementById('toolbar').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-act]')
  if (!btn) return
  const act = btn.dataset.act
  if (act === 'run') {
    running = true
    world.resume()
    world.startLoop({ pauseOnHidden: true })
    refreshStatus('running')
  } else if (act === 'pause') {
    running = false
    world.pause()
    refreshStatus('paused')
  } else if (act === 'fault') {
    bridge.act(events.InjectFault, { kind: 'pump_trip' })
    refreshStatus('fault injected')
  } else if (act === 'naive') {
    bridge.act(events.SetPump, { running: true })
    refreshStatus('agent: restart only')
  } else if (act === 'smart') {
    bridge.act(events.AcknowledgeAlarm, { code: 'PUMP-TRIP', reset: true })
    bridge.act(events.SetPump, { running: true })
    refreshStatus('agent: reset + start')
  } else if (act === 'branch') {
    const base = bridge.snapshot()
    // Branch A — naive
    world.restore(base)
    bridge.act(events.SetPump, { running: true })
    for (let i = 0; i < 40; i++) world.step(fixedStep)
    const outcomeA = readOutcome()
    // Branch B — smart
    world.restore(base)
    bridge.act(events.AcknowledgeAlarm, { code: 'PUMP-TRIP', reset: true })
    bridge.act(events.SetPump, { running: true })
    for (let i = 0; i < 40; i++) world.step(fixedStep)
    const outcomeB = readOutcome()
    // Stay on B (competent path)
    branchEl.textContent = [
      'Branch compare (40 fixed steps after shared fault state):',
      '',
      `A naive restart →  trip=${outcomeA.pumpTrip} temp=${outcomeA.temp.toFixed(1)} level=${outcomeA.level.toFixed(1)}`,
      `B reset+start  →  trip=${outcomeB.pumpTrip} temp=${outcomeB.temp.toFixed(1)} level=${outcomeB.level.toFixed(1)}`,
      '',
      outcomeB.temp < outcomeA.temp
        ? '✓ B cooler — competent agent strategy preferred; world left on branch B.'
        : '? Unexpected: B not cooler; inspect plant state.',
    ].join('\n')
    history.level = []
    history.temp = []
    sampleTrend()
    drawTrend()
    refreshStatus('after branch compare (on B)')
  } else if (act === 'reset') {
    bridge.reset()
    history.level = []
    history.temp = []
    sampleTrend()
    drawTrend()
    branchEl.textContent = 'Episode reset to baseline.'
    refreshStatus('reset')
  }
})

// Initial paint via one heartbeat + a few fixed steps, then start loop.
world.step(0)
fastForward(5)
world.startLoop({ pauseOnHidden: true })
refreshStatus('ready')
