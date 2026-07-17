/**
 * Plantroom agent session — bridge, branch compare, proposals, historian scrub.
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPlantWorld,
  proposalRestartOnly,
  proposalResetAndStart,
  SetPump,
  InjectFault,
  AcknowledgeAlarm,
  Historian,
} from './model.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const { createAgentBridge } = await import(
  pathToFileURL(join(root, 'packages/domecs/dist/index.js')).href
)

const eventMap = {
  SetPump,
  InjectFault,
  AcknowledgeAlarm,
}

/**
 * @param {{ seed?: number | number[], sensorCount?: number }} [opts]
 */
export function createPlantSession(opts = {}) {
  const plant = createPlantWorld({
    seed: opts.seed,
    sensorCount: opts.sensorCount ?? 200,
    headless: true,
  })
  const { world, ids, components, events } = plant
  const bridge = createAgentBridge(world)
  bridge.captureBaseline()

  const fixedStep = world.time.fixedStep
  /** @type {import('./buildPlant.js').Proposal | null} */
  let pending = null
  /** @type {Array<{ tick: number, snapshot: object }>} */
  const checkpoints = []
  const checkpointEvery = 20
  const checkpointCapacity = 40

  function maybeCheckpoint() {
    const tick = world.time.tick
    if (tick <= 0 || tick % checkpointEvery !== 0) return
    if (checkpoints.some((c) => c.tick === tick)) return
    checkpoints.push({ tick, snapshot: world.snapshot() })
    while (checkpoints.length > checkpointCapacity) checkpoints.shift()
  }

  const session = {
    world,
    bridge,
    ids,
    components,
    events,
    fixedStep,

    observe() {
      return bridge.observe()
    },

    injectPumpTrip() {
      return bridge.act(events.InjectFault, { kind: 'pump_trip' })
    },

    queueProposal(proposal) {
      pending = proposal
      return pending
    },

    getPendingProposal() {
      return pending
    },

    rejectProposal() {
      const was = pending
      pending = null
      return was
    },

    approveProposal() {
      if (!pending) return { applied: false, results: [] }
      const results = []
      for (const step of pending.steps) {
        const et = eventMap[step.event]
        if (!et) throw new Error(`unknown proposal event ${step.event}`)
        results.push(bridge.act(et, step.payload))
        maybeCheckpoint()
      }
      pending = null
      return { applied: true, results }
    },

    proposeRestartPump() {
      return bridge.act(events.SetPump, { running: true })
    },

    proposeResetAndStart() {
      const ack = bridge.act(events.AcknowledgeAlarm, {
        code: 'PUMP-TRIP',
        reset: true,
      })
      const start = bridge.act(events.SetPump, { running: true })
      return { ack, start }
    },

    agentSuggestAfterFault(kind = 'smart') {
      const proposal =
        kind === 'naive' ? proposalRestartOnly() : proposalResetAndStart()
      return session.queueProposal(proposal)
    },

    fastForward(steps) {
      for (let i = 0; i < steps; i++) {
        bridge.step(fixedStep)
        maybeCheckpoint()
      }
    },

    compareBranches(steps, strategyA, strategyB) {
      const base = bridge.snapshot()
      world.restore(base)
      strategyA(session)
      session.fastForward(steps)
      const outcomeA = readOutcome(session)

      world.restore(base)
      strategyB(session)
      session.fastForward(steps)
      const outcomeB = readOutcome(session)

      return { outcomeA, outcomeB, base }
    },

    getHistorian() {
      return world.getResource(Historian)
    },

    getCheckpoints() {
      return checkpoints.slice()
    },

    /**
     * Restore nearest checkpoint at or before `tick`.
     * @returns {boolean}
     */
    restoreHistorianCheckpoint(tick) {
      if (checkpoints.length === 0) return false
      let best = null
      for (const cp of checkpoints) {
        if (cp.tick <= tick) best = cp
      }
      if (!best) best = checkpoints[0]
      world.restore(best.snapshot)
      return true
    },

    readOutcome() {
      return readOutcome(session)
    },

    entityCount() {
      return bridge.observe().entityCount
    },

    reset() {
      pending = null
      checkpoints.length = 0
      bridge.reset()
    },
  }

  return session
}

function readOutcome(session) {
  const { world, ids, components } = session
  const vessel = world.getComponent(ids.vessel, components.Vessel)
  const pump = world.getComponent(ids.pump, components.Pump)
  const trip = world.getComponent(ids.alarmTrip, components.Alarm)
  const hi = world.getComponent(ids.alarmHi, components.Alarm)
  return {
    level: vessel?.level ?? 0,
    temp: vessel?.temp ?? 0,
    pumpRunning: !!(pump?.running && !pump?.trip),
    pumpTrip: !!pump?.trip,
    alarmTrip: !!trip?.active,
    alarmHiLevel: !!hi?.active,
  }
}
