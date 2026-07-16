/**
 * Plantroom domain model — PLC-style tags, alarms, simple plant dynamics.
 * Headless; no DOM required for the core bet.
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const core = await import(pathToFileURL(join(root, 'packages/domecs/dist/index.js')).href)

const {
  createWorld,
  defineComponent,
  defineEvent,
  defineResource,
  entry,
} = core

export const Tag = defineComponent('Tag', {
  defaults: { name: '', value: 0, unit: '' },
  schema: {
    fields: {
      name: { kind: 'string' },
      value: { kind: 'number' },
      unit: { kind: 'string' },
    },
  },
})

export const Alarm = defineComponent('Alarm', {
  defaults: { code: '', severity: 'warn', active: false, message: '' },
})

export const Pump = defineComponent('Pump', {
  defaults: { running: true, trip: false, flow: 1 },
})

export const Vessel = defineComponent('Vessel', {
  defaults: { level: 50, temp: 40, highAlarm: 80, highTemp: 90 },
})

export const PlantState = defineResource('PlantState', {
  default: { mode: 'auto', faultInjected: false },
})

export const SetPump = defineEvent('SetPump') // { running: boolean }
export const InjectFault = defineEvent('InjectFault') // { kind: 'pump_trip' }
export const AcknowledgeAlarm = defineEvent('AcknowledgeAlarm') // { code: string }

/**
 * @param {{ seed?: number | number[] }} [opts]
 */
export function createPlantWorld(opts = {}) {
  const world = createWorld({
    headless: true,
    seed: opts.seed ?? [42, 7, 13, 99],
    fixedStep: 0.1, // 10 Hz plant tick
  })

  world.setResource(PlantState, { mode: 'auto', faultInjected: false })

  // Tags as entities (PLC-style)
  const tagLevel = world.spawn([entry(Tag, { name: 'LIC-101', value: 50, unit: '%' })])
  const tagTemp = world.spawn([entry(Tag, { name: 'TI-201', value: 40, unit: 'C' })])
  const tagFlow = world.spawn([entry(Tag, { name: 'FI-150', value: 1, unit: 'm3/h' })])

  const vessel = world.spawn([entry(Vessel, { level: 50, temp: 40, highAlarm: 80, highTemp: 90 })])
  const pump = world.spawn([entry(Pump, { running: true, trip: false, flow: 1 })])

  // Alarm entities (created on demand by systems)
  const alarmHi = world.spawn([
    entry(Alarm, { code: 'HI-LEVEL', severity: 'alarm', active: false, message: 'Vessel high level' }),
  ])
  const alarmTrip = world.spawn([
    entry(Alarm, {
      code: 'PUMP-TRIP',
      severity: 'critical',
      active: false,
      message: 'Cooling pump trip',
    }),
  ])

  world.system('plant-dynamics', { schedule: 'fixed' }, ({ world: w }) => {
    const v = w.getComponent(vessel, Vessel)
    const p = w.getComponent(pump, Pump)
    if (!v || !p) return

    const inflow = p.running && !p.trip ? p.flow : 0
    const outflow = 0.4
    v.level = clamp(v.level + (inflow - outflow) * 2, 0, 100)
    // Heat rises when pump is down (no cooling).
    v.temp = clamp(v.temp + (p.running && !p.trip ? -0.2 : 0.8), 20, 120)
    p.flow = p.running && !p.trip ? 1 : 0
    w.markChanged(vessel, Vessel)
    w.markChanged(pump, Pump)

    // Mirror to tags
    const lvl = w.getComponent(tagLevel, Tag)
    const tmp = w.getComponent(tagTemp, Tag)
    const flw = w.getComponent(tagFlow, Tag)
    if (lvl) {
      lvl.value = v.level
      w.markChanged(tagLevel, Tag)
    }
    if (tmp) {
      tmp.value = v.temp
      w.markChanged(tagTemp, Tag)
    }
    if (flw) {
      flw.value = p.flow
      w.markChanged(tagFlow, Tag)
    }

    // Alarms
    const hi = w.getComponent(alarmHi, Alarm)
    if (hi) {
      const was = hi.active
      hi.active = v.level >= v.highAlarm
      if (hi.active !== was) w.markChanged(alarmHi, Alarm)
    }
    const trip = w.getComponent(alarmTrip, Alarm)
    if (trip) {
      const was = trip.active
      trip.active = p.trip
      if (trip.active !== was) w.markChanged(alarmTrip, Alarm)
    }
  })

  world.system('on-set-pump', { schedule: 'event', triggers: [SetPump] }, ({ events, world: w }) => {
    for (const cmd of events.of(SetPump)) {
      const p = w.getComponent(pump, Pump)
      if (!p) continue
      if (p.trip && cmd.running) continue // cannot start a tripped pump without reset
      p.running = !!cmd.running
      w.markChanged(pump, Pump)
    }
  })

  world.system(
    'on-inject-fault',
    { schedule: 'event', triggers: [InjectFault] },
    ({ events, world: w }) => {
      for (const f of events.of(InjectFault)) {
        if (f.kind === 'pump_trip') {
          const p = w.getComponent(pump, Pump)
          if (!p) continue
          p.trip = true
          p.running = false
          p.flow = 0
          w.markChanged(pump, Pump)
          const st = w.getResource(PlantState)
          if (st) {
            st.faultInjected = true
            w.setResource(PlantState, st)
          }
        }
      }
    },
  )

  world.system(
    'on-ack-alarm',
    { schedule: 'event', triggers: [AcknowledgeAlarm] },
    ({ events, world: w }) => {
      for (const a of events.of(AcknowledgeAlarm)) {
        for (const id of w.listEntities([Alarm])) {
          const al = w.getComponent(id, Alarm)
          if (al && al.code === a.code && al.active) {
            // Reset trip if acknowledging pump trip with explicit reset path
            if (a.code === 'PUMP-TRIP' && a.reset) {
              const p = w.getComponent(pump, Pump)
              if (p) {
                p.trip = false
                w.markChanged(pump, Pump)
              }
              al.active = false
              w.markChanged(id, Alarm)
            }
          }
        }
      }
    },
  )

  return {
    world,
    ids: { tagLevel, tagTemp, tagFlow, vessel, pump, alarmHi, alarmTrip },
    components: { Tag, Alarm, Pump, Vessel, PlantState },
    events: { SetPump, InjectFault, AcknowledgeAlarm },
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}
