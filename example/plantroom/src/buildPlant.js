/**
 * Shared Plantroom domain factory.
 * Call with the `@domecs/core` module (Node dist or Vite-resolved source).
 *
 * Features for WS-4 finish:
 * - PLC tags / alarms / vessel+pump dynamics (fixed schedule)
 * - LIC-101 level control loop: healthy operation holds level ≈ 50%, so
 *   alarms fire only on genuine upsets
 * - Historian ring (samples + optional snapshot checkpoints)
 * - Optional field sensors (hundreds of entities)
 * - Typed control events for agent/operator actions, each answered by a
 *   `CommandResult` downstream event so `world.action` verdicts are truthful
 *   (use {@link resolveCommand} as the action resolver)
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
    defaults: { code: '', severity: 'warn', active: false, acked: false, message: '' },
  })

  const Pump = defineComponent('Pump', {
    defaults: { running: true, trip: false, flow: 0.6 },
  })

  const Vessel = defineComponent('Vessel', {
    defaults: { level: 50, temp: 40, highAlarm: 80, highTemp: 70 },
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
   * restore-based scrub live *outside* the world (checkpoints.mjs) so we
   * never nest snapshots inside the snapshot envelope. `total` counts every
   * sample ever pushed — it drives checkpoint cadence in sim time and,
   * because it lives in a resource, rewinds correctly on restore.
   * @typedef {{ tick: number, level: number, temp: number, flow: number, pumpTrip: boolean }} Sample
   */
  const Historian = defineResource('Historian', {
    default: () => ({
      capacity: 300,
      samples: /** @type {Sample[]} */ ([]),
      total: 0,
    }),
  })

  const SetPump = defineEvent('SetPump') // { running: boolean }
  const InjectFault = defineEvent('InjectFault') // { kind: 'pump_trip' }
  const AcknowledgeAlarm = defineEvent('AcknowledgeAlarm') // { code, reset? }
  /**
   * Downstream verdict for every control command:
   * `{ command, applied, reason }`. Read it with {@link resolveCommand} so
   * `world.action(...)` reports `accepted: false` for commands that changed
   * nothing (restart of a latched pump, ack of an inactive alarm, unknown
   * fault kind) instead of blindly accepting.
   */
  const CommandResult = defineEvent('CommandResult')

  /**
   * Action resolver over the `CommandResult` the control systems emit.
   * Pass as `{ resolve: resolveCommand }` to `world.action` / `bridge.act`.
   */
  function resolveCommand({ events }) {
    for (const e of events) {
      if (e.type === CommandResult) {
        const r = /** @type {{ applied: boolean, reason?: string }} */ (e.payload)
        return {
          accepted: r.applied,
          consumedTurn: r.applied,
          reason: r.applied ? undefined : r.reason,
        }
      }
    }
    return { accepted: false, consumedTurn: false, reason: 'command produced no CommandResult' }
  }

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
      total: 0,
    })

    const tagLevel = world.spawn([entry(Tag, { name: 'LIC-101', value: 50, unit: '%' })])
    const tagTemp = world.spawn([entry(Tag, { name: 'TI-201', value: 40, unit: 'C' })])
    const tagFlow = world.spawn([entry(Tag, { name: 'FI-150', value: 0.6, unit: 'm3/h' })])

    const vessel = world.spawn([
      entry(Vessel, { level: 50, temp: 40, highAlarm: 80, highTemp: 70 }),
    ])
    const pump = world.spawn([entry(Pump, { running: true, trip: false, flow: 0.6 })])

    const alarmHi = world.spawn([
      entry(Alarm, {
        code: 'HI-LEVEL',
        severity: 'alarm',
        active: false,
        acked: false,
        message: 'Vessel high level',
      }),
    ])
    const alarmHiTemp = world.spawn([
      entry(Alarm, {
        code: 'HI-TEMP',
        severity: 'alarm',
        active: false,
        acked: false,
        message: 'Vessel high temperature',
      }),
    ])
    const alarmTrip = world.spawn([
      entry(Alarm, {
        code: 'PUMP-TRIP',
        severity: 'critical',
        active: false,
        acked: false,
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

    // Constant process feed into the vessel; the pump both drains the vessel
    // (LIC-101 P-loop: setpoint 50%) and provides cooling circulation.
    const PROCESS_INFLOW = 0.6

    world.system('plant-dynamics', { schedule: 'fixed' }, ({ world: w, time }) => {
      const v = w.getComponent(vessel, Vessel)
      const p = w.getComponent(pump, Pump)
      if (!v || !p) return

      // LIC-101: proportional level controller through the pump. Healthy
      // equilibrium at level 50 (flow == inflow); trip → flow 0 → level
      // rises toward HI-LEVEL. Discrete update converges (factor 0.8).
      p.flow =
        p.running && !p.trip
          ? clamp(PROCESS_INFLOW + 0.1 * (v.level - 50), 0, 2)
          : 0
      v.level = clamp(v.level + (PROCESS_INFLOW - p.flow) * 2, 0, 100)
      // Cooling circulation relaxes temp to 40; a tripped/stopped pump lets
      // the process heat at +0.8/step toward the 120 clamp.
      v.temp = clamp(
        p.running && !p.trip ? v.temp + (40 - v.temp) * 0.05 : v.temp + 0.8,
        20,
        120,
      )
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

      // Alarm conditions recompute from process state; `acked` latches an
      // operator acknowledgement while the condition persists and clears
      // itself when the alarm returns to normal.
      const setAlarm = (id, active) => {
        const al = w.getComponent(id, Alarm)
        if (!al) return
        const was = al.active
        const wasAcked = al.acked
        al.active = active
        if (!al.active && al.acked) al.acked = false
        if (al.active !== was || al.acked !== wasAcked) w.markChanged(id, Alarm)
      }
      setAlarm(alarmHi, v.level >= v.highAlarm)
      setAlarm(alarmHiTemp, v.temp >= v.highTemp)
      setAlarm(alarmTrip, p.trip)

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
        hist.total += 1
        while (hist.samples.length > hist.capacity) hist.samples.shift()
      }
    })

    world.system('on-set-pump', { schedule: 'event', triggers: [SetPump] }, ({ events, world: w }) => {
      for (const cmd of events.of(SetPump)) {
        const p = w.getComponent(pump, Pump)
        if (!p) continue
        if (p.trip && cmd.running) {
          events.emit(CommandResult, {
            command: 'SetPump',
            applied: false,
            reason: 'PUMP-TRIP latched — acknowledge with reset before start',
          })
          continue
        }
        p.running = !!cmd.running
        w.markChanged(pump, Pump)
        events.emit(CommandResult, { command: 'SetPump', applied: true, reason: '' })
      }
    })

    world.system(
      'on-inject-fault',
      { schedule: 'event', triggers: [InjectFault] },
      ({ events, world: w }) => {
        for (const f of events.of(InjectFault)) {
          if (f.kind !== 'pump_trip') {
            events.emit(CommandResult, {
              command: 'InjectFault',
              applied: false,
              reason: `unknown fault kind ${String(f.kind)}`,
            })
            continue
          }
          const p = w.getComponent(pump, Pump)
          if (!p) continue
          p.trip = true
          p.running = false
          p.flow = 0
          w.markChanged(pump, Pump)
          const st = w.getResource(PlantState)
          if (st) w.setResource(PlantState, { ...st, faultInjected: true })
          events.emit(CommandResult, { command: 'InjectFault', applied: true, reason: '' })
        }
      },
    )

    world.system(
      'on-ack-alarm',
      { schedule: 'event', triggers: [AcknowledgeAlarm] },
      ({ events, world: w }) => {
        for (const a of events.of(AcknowledgeAlarm)) {
          let found = false
          let applied = false
          let reason = ''
          for (const id of w.listEntities([Alarm])) {
            const al = w.getComponent(id, Alarm)
            if (!al || al.code !== a.code) continue
            found = true
            if (a.code === 'PUMP-TRIP' && a.reset) {
              const p = w.getComponent(pump, Pump)
              if (p && p.trip) {
                p.trip = false
                w.markChanged(pump, Pump)
                al.acked = true
                w.markChanged(id, Alarm)
                applied = true
              } else {
                reason = 'pump is not tripped'
              }
            } else if (al.active && !al.acked) {
              al.acked = true
              w.markChanged(id, Alarm)
              applied = true
            } else {
              reason = al.active ? 'alarm already acknowledged' : 'alarm not active'
            }
          }
          if (!found) reason = `unknown alarm code ${String(a.code)}`
          events.emit(CommandResult, {
            command: 'AcknowledgeAlarm',
            applied,
            reason: applied ? '' : reason,
          })
        }
      },
    )

    return {
      world,
      ids: {
        tagLevel,
        tagTemp,
        tagFlow,
        vessel,
        pump,
        alarmHi,
        alarmHiTemp,
        alarmTrip,
        sensors,
      },
      components: { Tag, Alarm, Pump, Vessel, Sensor, PlantState, Historian },
      events: { SetPump, InjectFault, AcknowledgeAlarm, CommandResult },
    }
  }

  return {
    createPlantWorld,
    resolveCommand,
    components: { Tag, Alarm, Pump, Vessel, Sensor, PlantState, Historian },
    events: { SetPump, InjectFault, AcknowledgeAlarm, CommandResult },
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

/**
 * Operator-approval proposal helpers (pure data; not world state).
 *
 * Proposals carry no id here — the session/UI stamps one at queue time so
 * ids stay reproducible per session instead of leaking a module-global
 * counter across sessions and episode resets.
 * @typedef {{ id?: string, title: string, rationale: string, steps: Array<{ event: string, payload: object }> }} Proposal
 */

/** @returns {Proposal} */
export function makeProposal(title, rationale, steps) {
  return { title, rationale, steps }
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
