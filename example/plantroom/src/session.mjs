/**
 * Plantroom agent session — bridge, branch compare, proposals, historian scrub.
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPlantWorld,
  resolveCommand,
  proposalRestartOnly,
  proposalResetAndStart,
  SetPump,
  InjectFault,
  AcknowledgeAlarm,
  Historian,
} from './model.mjs'
import { createCheckpointRing, compareBranches } from './checkpoints.mjs'

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
  let proposalSeq = 0
  const ring = createCheckpointRing(world, {
    getSampleCount: () => world.getResource(Historian)?.total ?? 0,
    everySamples: 10,
    capacity: 40,
  })

  function act(type, payload) {
    return bridge.act(type, payload, { resolve: resolveCommand })
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
      return act(events.InjectFault, { kind: 'pump_trip' })
    },

    queueProposal(proposal) {
      proposalSeq += 1
      pending = { ...proposal, id: `prop-${proposalSeq}` }
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

    /**
     * Apply the pending proposal through the action boundary. All step event
     * names are resolved BEFORE the first act — a malformed proposal is
     * rejected atomically instead of half-applied.
     */
    approveProposal() {
      if (!pending) return { applied: false, results: [], reason: 'no pending proposal' }
      const resolved = []
      for (const step of pending.steps) {
        const et = eventMap[step.event]
        if (!et) {
          return {
            applied: false,
            results: [],
            reason: `unknown proposal event ${step.event}`,
          }
        }
        resolved.push({ et, payload: step.payload })
      }
      const results = []
      for (const step of resolved) {
        results.push(act(step.et, step.payload))
        ring.maybeCheckpoint()
      }
      pending = null
      return { applied: true, results }
    },

    proposeRestartPump() {
      return act(events.SetPump, { running: true })
    },

    proposeResetAndStart() {
      const ack = act(events.AcknowledgeAlarm, { code: 'PUMP-TRIP', reset: true })
      const start = act(events.SetPump, { running: true })
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
        ring.maybeCheckpoint()
      }
    },

    /**
     * Pure evaluator: rolls each strategy forward from the same base
     * snapshot and puts the world BACK on base before returning. Applying a
     * winner is an explicit follow-up (through the approval flow). Nothing
     * speculative enters the checkpoint ring.
     */
    compareBranches(steps, strategyA, strategyB) {
      const { outcomes, base } = compareBranches({
        world,
        bridge,
        ring,
        steps,
        fixedStep,
        strategies: [() => strategyA(session), () => strategyB(session)],
        readOutcome: () => readOutcome(session),
      })
      return { outcomeA: outcomes[0], outcomeB: outcomes[1], base }
    },

    getHistorian() {
      return world.getResource(Historian)
    },

    getCheckpoints() {
      return ring.list()
    },

    /**
     * Restore nearest checkpoint at or before `tick`. Returns `false` when
     * no checkpoint ≤ `tick` exists — it never falls forward to a later
     * checkpoint. Checkpoints from the abandoned future are dropped.
     * @returns {boolean}
     */
    restoreHistorianCheckpoint(tick) {
      return ring.restoreAtOrBefore(tick)
    },

    readOutcome() {
      return readOutcome(session)
    },

    entityCount() {
      return bridge.observe().entityCount
    },

    reset() {
      pending = null
      proposalSeq = 0
      ring.clear()
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
  const hiTemp = world.getComponent(ids.alarmHiTemp, components.Alarm)
  return {
    level: vessel?.level ?? 0,
    temp: vessel?.temp ?? 0,
    pumpRunning: !!(pump?.running && !pump?.trip),
    pumpTrip: !!pump?.trip,
    alarmTrip: !!trip?.active,
    alarmHiLevel: !!hi?.active,
    alarmHiTemp: !!hiTemp?.active,
  }
}
