/**
 * Shared Plantroom domain factory.
 * Call with the `@domecs/core` module (Node dist or Vite-resolved source).
 *
 * Features for WS-4 finish:
 * - PLC tags / alarms / vessel+pump dynamics
 * - Historian ring (samples + optional snapshot checkpoints)
 * - Optional field sensors (hundreds of entities)
 * - Typed control events for agent/operator actions
 */

/**
 * @param {typeof import('@domecs/core')} core
 */
export function buildPlant(core) {
  const {
    createWorld,
    defineComponent,
    defineEvent,
    defineResource,
    entry,
  } = core

  const Tag = defineComponent('Tag', {
    defaults: { name: '', value: 0, unit: '' },
  })

  const Alarm = defineComponent('Alarm', {
    defaults: { code: '', severity: 'warn', active: false, message: '' },
  })

  const Pump = defineComponent('Pump', {
    defaults: { running: true, trip: false, flow: 1 },
  })

  const Vessel = defineComponent('Vessel', {
    defaults: { level: 50, temp: 40, highAlarm: 80, highTemp: 90 },
  })

  /** Ambient / field sensor (scaled fleet of entities). */
  const Sensor = defineComponent('Sensor', {
    defaults: { name: '', value: 0, noise: 0, unit: 'u' },
  })

  /**
   * Live plant meta + pending operator-approval proposal (UI shell also tracks
   * proposals; resource is snapshot-visible for restore demos).
   */
  const PlantState = defineResource('PlantState', {
    default: () => ({
      mode: 'auto',
      faultInjected: false,
      sensorCount: 0,
    }),
  })

  /**
   * Historian sample ring (lightweight). Full snapshot checkpoints for
   * restore-based scrub live *outside* the world (session/UI) so we never
   * nest snapshots inside the snapshot envelope.
   * @typedef {{ tick: number, level: number, temp: number, flow: number, pumpTrip: boolean }} Sample
   */
  const Historian = defineResource('Historian', {
    default: () => ({
      capacity: 300,
      samples: /** @type {Sample[]} */ ([]),
    }),
  })

  const SetPump = defineEvent('SetPump') // { running: boolean }
  const InjectFault = defineEvent('InjectFault') // { kind: 'pump_trip' }
  const AcknowledgeAlarm = defineEvent('AcknowledgeAlarm') // { code, reset? }

  /**
   * @param {{
   *   seed?: number | number[]
   *   headless?: boolean
   *   sensorCount?: number
   *   historianCapacity?: number
   * }} [opts]
   */
  function createPlantWorld(opts = {}) {
    const sensorCount = opts.sensorCount ?? 200
    const historianCapacity = opts.historianCapacity ?? 300

    const world = createWorld({
      headless: opts.headless !== false,
      seed: opts.seed ?? [42, 7, 13, 99],
      fixedStep: 0.1,
    })

    world.setResource(PlantState, {
      mode: 'auto',
      faultInjected: false,
      sensorCount,
    })
    world.setResource(Historian, {
      capacity: historianCapacity,
      samples: [],
    })

    const tagLevel = world.spawn([entry(Tag, { name: 'LIC-101', value: 50, unit: '%' })])
    const tagTemp = world.spawn([entry(Tag, { name: 'TI-201', value: 40, unit: 'C' })])
    const tagFlow = world.spawn([entry(Tag, { name: 'FI-150', value: 1, unit: 'm3/h' })])

    const vessel = world.spawn([
      entry(Vessel, { level: 50, temp: 40, highAlarm: 80, highTemp: 90 }),
    ])
    const pump = world.spawn([entry(Pump, { running: true, trip: false, flow: 1 })])

    const alarmHi = world.spawn([
      entry(Alarm, {
        code: 'HI-LEVEL',
        severity: 'alarm',
        active: false,
        message: 'Vessel high level',
      }),
    ])
    const alarmTrip = world.spawn([
      entry(Alarm, {
        code: 'PUMP-TRIP',
        severity: 'critical',
        active: false,
        message: 'Cooling pump trip',
      }),
    ])

    const sensors = []
    for (let i = 0; i < sensorCount; i++) {
      sensors.push(
        world.spawn([
          entry(Sensor, {
            name: `XS-${String(i + 1).padStart(3, '0')}`,
            value: (i * 17) % 100,
            noise: ((i * 13) % 10) / 50,
            unit: 'u',
          }),
        ]),
      )
    }

    world.system('plant-dynamics', { schedule: 'fixed' }, ({ world: w, time }) => {
      const v = w.getComponent(vessel, Vessel)
      const p = w.getComponent(pump, Pump)
      if (!v || !p) return

      const inflow = p.running && !p.trip ? p.flow : 0
      const outflow = 0.4
      v.level = clamp(v.level + (inflow - outflow) * 2, 0, 100)
      v.temp = clamp(v.temp + (p.running && !p.trip ? -0.2 : 0.8), 20, 120)
      p.flow = p.running && !p.trip ? 1 : 0
      w.markChanged(vessel, Vessel)
      w.markChanged(pump, Pump)

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

      // Field sensors: slow drift (keeps hundreds of entities "live")
      for (let i = 0; i < sensors.length; i++) {
        if ((time.tick + i) % 7 !== 0) continue
        const id = sensors[i]
        const s = w.getComponent(id, Sensor)
        if (!s) continue
        s.value = clamp(s.value + s.noise * (i % 2 === 0 ? 1 : -1), 0, 100)
        w.markChanged(id, Sensor)
      }

      // Historian sample every fixed step (values only — no nested snapshots)
      const hist = w.getResource(Historian)
      if (hist) {
        hist.samples.push({
          tick: time.tick,
          level: v.level,
          temp: v.temp,
          flow: p.flow,
          pumpTrip: p.trip,
        })
        while (hist.samples.length > hist.capacity) hist.samples.shift()
      }
    })

    world.system('on-set-pump', { schedule: 'event', triggers: [SetPump] }, ({ events, world: w }) => {
      for (const cmd of events.of(SetPump)) {
        const p = w.getComponent(pump, Pump)
        if (!p) continue
        if (p.trip && cmd.running) continue
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
            if (st) w.setResource(PlantState, { ...st, faultInjected: true })
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
            if (!al || al.code !== a.code) continue
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
      },
    )

    return {
      world,
      ids: { tagLevel, tagTemp, tagFlow, vessel, pump, alarmHi, alarmTrip, sensors },
      components: { Tag, Alarm, Pump, Vessel, Sensor, PlantState, Historian },
      events: { SetPump, InjectFault, AcknowledgeAlarm },
    }
  }

  return {
    createPlantWorld,
    components: { Tag, Alarm, Pump, Vessel, Sensor, PlantState, Historian },
    events: { SetPump, InjectFault, AcknowledgeAlarm },
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

/**
 * Operator-approval proposal helpers (pure; not world state).
 * @typedef {{ id: string, title: string, rationale: string, steps: Array<{ event: string, payload: object }> }} Proposal
 */

let proposalSeq = 0

/** @returns {Proposal} */
export function makeProposal(title, rationale, steps) {
  proposalSeq += 1
  return {
    id: `prop-${proposalSeq}`,
    title,
    rationale,
    steps,
  }
}

export function proposalRestartOnly() {
  return makeProposal(
    'Restart pump only',
    'Naive recovery: command pump running without clearing trip latch.',
    [{ event: 'SetPump', payload: { running: true } }],
  )
}

export function proposalResetAndStart() {
  return makeProposal(
    'Reset trip + start pump',
    'Competent recovery: clear PUMP-TRIP latch, then start cooling pump.',
    [
      { event: 'AcknowledgeAlarm', payload: { code: 'PUMP-TRIP', reset: true } },
      { event: 'SetPump', payload: { running: true } },
    ],
  )
}
