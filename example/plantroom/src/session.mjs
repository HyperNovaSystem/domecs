/**
 * Plantroom agent session — bridge + snapshot branch / fast-forward compare.
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPlantWorld } from './model.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const { createAgentBridge } = await import(
  pathToFileURL(join(root, 'packages/domecs/dist/index.js')).href
)

/**
 * @param {{ seed?: number | number[] }} [opts]
 */
export function createPlantSession(opts = {}) {
  const plant = createPlantWorld(opts)
  const { world, ids, components, events } = plant
  const bridge = createAgentBridge(world)
  bridge.captureBaseline()

  const fixedStep = world.time.fixedStep

  return {
    world,
    bridge,
    ids,
    components,
    events,
    fixedStep,

    observe() {
      return bridge.observe()
    },

    /** Inject a deterministic fault (demo moment step 1). */
    injectPumpTrip() {
      return bridge.act(events.InjectFault, { kind: 'pump_trip' })
    },

    /** Agent proposal: try to restart pump (may fail while tripped). */
    proposeRestartPump() {
      return bridge.act(events.SetPump, { running: true })
    },

    /** Better proposal: reset trip then restart. */
    proposeResetAndStart() {
      const ack = bridge.act(events.AcknowledgeAlarm, { code: 'PUMP-TRIP', reset: true })
      const start = bridge.act(events.SetPump, { running: true })
      return { ack, start }
    },

    /** Advance plant by n fixed steps. */
    fastForward(steps) {
      for (let i = 0; i < steps; i++) bridge.step(fixedStep)
    },

    /**
     * Branch current state, run strategy A and B for `steps`, compare outcomes.
     * @param {(s: ReturnType<typeof createPlantSession>) => void} strategyA
     * @param {(s: ReturnType<typeof createPlantSession>) => void} strategyB
     */
    compareBranches(steps, strategyA, strategyB) {
      const base = bridge.snapshot()

      // Branch A
      world.restore(base)
      strategyA(this)
      this.fastForward(steps)
      const outcomeA = readOutcome(this)

      // Branch B
      world.restore(base)
      strategyB(this)
      this.fastForward(steps)
      const outcomeB = readOutcome(this)

      // Leave world on branch B by default; caller can restore base if needed
      return { outcomeA, outcomeB, base }
    },

    readOutcome() {
      return readOutcome(this)
    },

    reset() {
      bridge.reset()
    },
  }
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
