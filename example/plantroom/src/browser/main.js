/**
 * Plantroom browser shell — multi-view DOM, operator approval, historian scrub.
 */
import { createAgentBridge, isOk } from '@domecs/core'
import { defineView, mountDOM } from '@domecs/dom'
import {
  createPlantWorld,
  Tag,
  Alarm,
  Pump,
  Vessel,
  Historian,
  SetPump,
  InjectFault,
  AcknowledgeAlarm,
  proposalRestartOnly,
  proposalResetAndStart,
} from './model-browser.js'

const SENSOR_COUNT = 200
const plant = createPlantWorld({
  seed: [42, 7, 13, 99],
  headless: false,
  sensorCount: SENSOR_COUNT,
})
const { world, ids, events } = plant
const bridge = createAgentBridge(world)
bridge.captureBaseline()
const fixedStep = world.time.fixedStep

const eventMap = { SetPump, InjectFault, AcknowledgeAlarm }

/** @type {import('../buildPlant.js').Proposal | null} */
let pending = null
/** @type {Array<{ tick: number, snapshot: object }>} */
const checkpoints = []
const checkpointEvery = 20
const checkpointCapacity = 40

let mode = 'live' // 'live' | 'scrub'
let scrubIndex = 0
let running = true

// --- multi-view (critical tags / alarms / plant only — sensors stay headless-heavy) --

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
    el.querySelector('.name').textContent = e.Tag.name
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

// --- DOM refs ----------------------------------------------------------------

const statusEl = document.getElementById('status')
const branchEl = document.getElementById('branch')
const proposalEl = document.getElementById('proposal')
const btnApprove = document.getElementById('btn-approve')
const btnReject = document.getElementById('btn-reject')
const scrubEl = document.getElementById('scrub')
const scrubLabel = document.getElementById('scrub-label')
const sensorMeta = document.getElementById('sensor-meta')
const canvas = document.getElementById('trend')
const ctx = canvas.getContext('2d')

// --- historian / checkpoints -------------------------------------------------

function getSamples() {
  return world.getResource(Historian)?.samples ?? []
}

function maybeCheckpoint() {
  const tick = world.time.tick
  if (tick <= 0 || tick % checkpointEvery !== 0) return
  if (checkpoints.some((c) => c.tick === tick)) return
  checkpoints.push({ tick, snapshot: world.snapshot() })
  while (checkpoints.length > checkpointCapacity) checkpoints.shift()
}

function syncScrubRange() {
  const samples = getSamples()
  const max = Math.max(0, samples.length - 1)
  scrubEl.max = String(max)
  if (mode === 'live') {
    scrubEl.value = String(max)
    scrubIndex = max
    scrubLabel.textContent = samples.length ? `live · tick ${samples[max]?.tick ?? '—'}` : 'live'
  }
}

function drawTrend() {
  const samples = getSamples()
  const w = canvas.width
  const h = canvas.height
  ctx.fillStyle = '#0a0e13'
  ctx.fillRect(0, 0, w, h)

  if (samples.length < 2) {
    ctx.fillStyle = '#8b9bb0'
    ctx.font = '12px system-ui'
    ctx.fillText('Historian empty — run the plant', 12, 24)
    return
  }

  const draw = (key, color) => {
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.beginPath()
    samples.forEach((s, i) => {
      const x = (i / (samples.length - 1)) * (w - 8) + 4
      const y = h - 4 - (s[key] / 120) * (h - 8)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  }
  draw('level', '#3d9cf0')
  draw('temp', '#e6b84d')

  // Scrub marker
  if (samples.length > 0) {
    const i = Math.min(scrubIndex, samples.length - 1)
    const x = (i / (samples.length - 1)) * (w - 8) + 4
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
    const s = samples[i]
    ctx.fillStyle = '#e7eef7'
    ctx.font = '11px system-ui'
    ctx.fillText(
      `t=${s.tick} L=${s.level.toFixed(1)} T=${s.temp.toFixed(1)}${s.pumpTrip ? ' TRIP' : ''}`,
      8,
      h - 8,
    )
  }

  ctx.fillStyle = '#8b9bb0'
  ctx.font = '11px system-ui'
  ctx.fillText('level', 8, 14)
  ctx.fillStyle = '#e6b84d'
  ctx.fillText('temp', 48, 14)
  ctx.fillStyle = '#8b9bb0'
  ctx.fillText(`${samples.length} samples · ${checkpoints.length} checkpoints`, 100, 14)
}

// --- proposal UI -------------------------------------------------------------

function renderProposal() {
  if (!pending) {
    proposalEl.className = 'proposal empty'
    proposalEl.textContent =
      'No pending agent proposal. Inject a fault, then ask the agent to propose.'
    btnApprove.disabled = true
    btnReject.disabled = true
    return
  }
  proposalEl.className = 'proposal'
  proposalEl.innerHTML = `
    <h3>${escapeHtml(pending.title)}</h3>
    <p class="rationale">${escapeHtml(pending.rationale)}</p>
    <ol>${pending.steps
      .map(
        (s) =>
          `<li><code>${escapeHtml(s.event)}</code> ${escapeHtml(JSON.stringify(s.payload))}</li>`,
      )
      .join('')}</ol>
  `
  btnApprove.disabled = false
  btnReject.disabled = false
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function approvePending() {
  if (!pending) return
  for (const step of pending.steps) {
    const et = eventMap[step.event]
    if (!et) throw new Error(`unknown event ${step.event}`)
    bridge.act(et, step.payload)
    maybeCheckpoint()
  }
  pending = null
  renderProposal()
  refreshStatus('proposal approved & applied')
}

function rejectPending() {
  pending = null
  renderProposal()
  refreshStatus('proposal rejected')
}

// --- status / outcomes -------------------------------------------------------

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
  sensorMeta.textContent = `entities=${obs.entityCount} · sensors≈${SENSOR_COUNT} · mode=${mode}`
  statusEl.textContent = [
    `tick=${obs.tick} scale=${obs.scale}`,
    `level=${o.level.toFixed(1)} temp=${o.temp.toFixed(1)}`,
    `pump=${o.pumpTrip ? 'TRIP' : o.pumpRunning ? 'run' : 'stop'}`,
    `alarms: trip=${o.alarmTrip} hi=${o.alarmHiLevel}`,
    pending ? `pending=${pending.id}` : 'pending=none',
    extra,
  ]
    .filter(Boolean)
    .join(' · ')
}

function onFrame() {
  if (mode === 'live') {
    maybeCheckpoint()
    syncScrubRange()
  }
  drawTrend()
  refreshStatus()
}

world.signals.tickEnd.subscribe(onFrame)

// --- controls ----------------------------------------------------------------

document.getElementById('toolbar').addEventListener('click', onAction)
document.getElementById('approval-panel').addEventListener('click', onAction)
document.querySelector('.historian-controls').addEventListener('click', onAction)

scrubEl.addEventListener('input', () => {
  mode = 'scrub'
  world.pause()
  running = false
  scrubIndex = Number(scrubEl.value)
  const samples = getSamples()
  const s = samples[scrubIndex]
  scrubLabel.textContent = s
    ? `scrub · tick ${s.tick} · L=${s.level.toFixed(1)} T=${s.temp.toFixed(1)}`
    : 'scrub'
  drawTrend()
  refreshStatus('scrubbing (sim paused)')
})

function onAction(ev) {
  const btn = ev.target.closest('button[data-act]')
  if (!btn) return
  const act = btn.dataset.act

  if (act === 'run') {
    mode = 'live'
    running = true
    world.resume()
    world.startLoop({ pauseOnHidden: true })
    refreshStatus('running')
  } else if (act === 'pause') {
    running = false
    world.pause()
    refreshStatus('paused')
  } else if (act === 'fault') {
    if (mode === 'scrub') returnToLive(false)
    bridge.act(events.InjectFault, { kind: 'pump_trip' })
    maybeCheckpoint()
    // Auto-queue competent proposal for approval UX demo moment
    pending = proposalResetAndStart()
    renderProposal()
    refreshStatus('fault injected · agent proposal pending')
  } else if (act === 'propose-naive') {
    pending = proposalRestartOnly()
    renderProposal()
    refreshStatus('naive proposal pending')
  } else if (act === 'propose-smart') {
    pending = proposalResetAndStart()
    renderProposal()
    refreshStatus('smart proposal pending')
  } else if (act === 'approve') {
    if (mode === 'scrub') returnToLive(false)
    approvePending()
  } else if (act === 'reject') {
    rejectPending()
  } else if (act === 'branch') {
    if (mode === 'scrub') returnToLive(false)
    const base = bridge.snapshot()
    world.restore(base)
    bridge.act(events.SetPump, { running: true })
    for (let i = 0; i < 40; i++) {
      world.step(fixedStep)
      maybeCheckpoint()
    }
    const outcomeA = readOutcome()

    world.restore(base)
    bridge.act(events.AcknowledgeAlarm, { code: 'PUMP-TRIP', reset: true })
    bridge.act(events.SetPump, { running: true })
    for (let i = 0; i < 40; i++) {
      world.step(fixedStep)
      maybeCheckpoint()
    }
    const outcomeB = readOutcome()

    branchEl.textContent = [
      'Branch compare (40 fixed steps after shared fault state):',
      '',
      `A naive restart →  trip=${outcomeA.pumpTrip} temp=${outcomeA.temp.toFixed(1)} level=${outcomeA.level.toFixed(1)}`,
      `B reset+start  →  trip=${outcomeB.pumpTrip} temp=${outcomeB.temp.toFixed(1)} level=${outcomeB.level.toFixed(1)}`,
      '',
      outcomeB.temp < outcomeA.temp
        ? '✓ B cooler — competent strategy preferred; world left on branch B.'
        : '? Unexpected: B not cooler; inspect plant state.',
      '',
      'Tip: use historian scrub to review samples recorded during the compare.',
    ].join('\n')
    syncScrubRange()
    drawTrend()
    refreshStatus('after branch compare (on B)')
  } else if (act === 'reset') {
    pending = null
    checkpoints.length = 0
    bridge.reset()
    mode = 'live'
    renderProposal()
    branchEl.textContent = 'Episode reset to baseline.'
    syncScrubRange()
    drawTrend()
    refreshStatus('reset')
  } else if (act === 'live') {
    returnToLive(true)
  } else if (act === 'restore-cp') {
    const samples = getSamples()
    const s = samples[scrubIndex]
    if (!s) return
    let best = null
    for (const cp of checkpoints) {
      if (cp.tick <= s.tick) best = cp
    }
    if (!best) {
      refreshStatus('no checkpoint ≤ scrub tick')
      return
    }
    world.restore(best.snapshot)
    mode = 'live'
    running = false
    world.pause()
    syncScrubRange()
    drawTrend()
    refreshStatus(`restored checkpoint tick ${best.tick}`)
  }
}

function returnToLive(resume) {
  mode = 'live'
  if (resume) {
    running = true
    world.resume()
    world.startLoop({ pauseOnHidden: true })
  }
  syncScrubRange()
  drawTrend()
  refreshStatus(resume ? 'live' : 'live (paused)')
}

// Boot
world.step(0)
for (let i = 0; i < 5; i++) {
  world.step(fixedStep)
  maybeCheckpoint()
}
renderProposal()
syncScrubRange()
drawTrend()
world.startLoop({ pauseOnHidden: true })
refreshStatus('ready')
