/**
 * Plantroom WS-4 episode suite: fault/branch, approval, historian, scale.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function ensureCoreBuilt() {
  const build = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['--filter', '@domecs/core', 'build'],
    { cwd: root, encoding: 'utf8', shell: true },
  )
  assert.equal(build.status, 0, build.stderr || build.stdout)
}

async function loadSession() {
  ensureCoreBuilt()
  return import(pathToFileURL(path.join(root, 'example/plantroom/src/session.mjs')).href)
}

async function loadModel() {
  return import(pathToFileURL(path.join(root, 'example/plantroom/src/model.mjs')).href)
}

describe('plantroom episode (WS-4)', () => {
  it('healthy plant holds steady state — no alarms without an upset', async () => {
    const { createPlantSession } = await loadSession()
    const session = createPlantSession({ seed: [1, 2, 3, 4], sensorCount: 20 })
    session.fastForward(80)
    const o = session.readOutcome()
    assert.equal(o.pumpTrip, false)
    assert.equal(o.alarmHiLevel, false, `level=${o.level}`)
    assert.equal(o.alarmHiTemp, false, `temp=${o.temp}`)
    assert.ok(Math.abs(o.level - 50) < 2, `level holds setpoint, got ${o.level}`)
  })

  it('fault → branch compare: competent strategy cooler; compare is a pure evaluator', async () => {
    const { createPlantSession } = await loadSession()
    const session = createPlantSession({ seed: [1, 2, 3, 4], sensorCount: 200 })
    assert.ok(session.entityCount() >= 200, 'hundreds of entities')

    session.fastForward(5)
    assert.equal(session.readOutcome().pumpRunning, true)

    const fault = session.injectPumpTrip()
    assert.equal(fault.accepted, true)
    session.fastForward(1)
    assert.equal(session.readOutcome().pumpTrip, true)

    const preTick = session.world.time.tick
    const preOutcome = JSON.stringify(session.readOutcome())

    const { outcomeA, outcomeB } = session.compareBranches(
      40,
      (s) => s.proposeRestartPump(),
      (s) => s.proposeResetAndStart(),
    )
    assert.equal(outcomeA.pumpTrip, true)
    assert.equal(outcomeA.alarmHiLevel, true, 'naive branch floods the vessel')
    assert.equal(outcomeB.pumpTrip, false)
    assert.equal(outcomeB.pumpRunning, true)
    assert.equal(outcomeB.alarmHiLevel, false, 'competent branch recovers level')
    assert.ok(outcomeB.temp < outcomeA.temp)

    // Pure evaluator: the live world is back on the shared base, not on B.
    assert.equal(session.world.time.tick, preTick, 'compare must not advance the live world')
    assert.equal(JSON.stringify(session.readOutcome()), preOutcome)
  })

  it('operator approval: proposal does not apply until approve; verdicts are honest', async () => {
    const { createPlantSession } = await loadSession()
    const session = createPlantSession({ seed: [2, 2, 2, 2], sensorCount: 50 })
    session.fastForward(3)
    session.injectPumpTrip()
    session.fastForward(1)
    assert.equal(session.readOutcome().pumpTrip, true)

    // The naive command is rejected while the trip latch holds — the action
    // boundary reports the truth instead of accepted:true-for-a-no-op.
    const naive = session.proposeRestartPump()
    assert.equal(naive.accepted, false)
    assert.match(naive.reason ?? '', /PUMP-TRIP latched/)
    assert.equal(session.readOutcome().pumpTrip, true)

    const prop = session.agentSuggestAfterFault('smart')
    assert.ok(prop)
    assert.equal(session.getPendingProposal()?.id, prop.id)
    // Still tripped — not applied
    assert.equal(session.readOutcome().pumpTrip, true)

    session.rejectProposal()
    assert.equal(session.getPendingProposal(), null)
    assert.equal(session.readOutcome().pumpTrip, true)

    session.agentSuggestAfterFault('smart')
    const r = session.approveProposal()
    assert.equal(r.applied, true)
    assert.equal(r.results.length, 2)
    assert.ok(r.results.every((step) => step.accepted === true))
    assert.equal(session.getPendingProposal(), null)
    assert.equal(session.readOutcome().pumpTrip, false)
    assert.equal(session.readOutcome().pumpRunning, true)

    // A malformed proposal is rejected atomically — nothing applies.
    session.queueProposal({
      title: 'bad',
      rationale: 'unknown event name',
      steps: [
        { event: 'SetPump', payload: { running: false } },
        { event: 'NoSuchEvent', payload: {} },
      ],
    })
    const before = JSON.stringify(session.readOutcome())
    const bad = session.approveProposal()
    assert.equal(bad.applied, false)
    assert.match(bad.reason ?? '', /unknown proposal event/)
    assert.equal(JSON.stringify(session.readOutcome()), before)
  })

  it('alarm acknowledgement latches while active and reports honest verdicts', async () => {
    const { createPlantSession } = await loadSession()
    const { resolveCommand } = await loadModel()
    const session = createPlantSession({ seed: [4, 4, 4, 4], sensorCount: 10 })
    const { world, ids, components, events, bridge } = session
    const ackAlarm = (payload) =>
      bridge.act(events.AcknowledgeAlarm, payload, { resolve: resolveCommand })

    // Ack of an inactive alarm is rejected.
    assert.equal(ackAlarm({ code: 'HI-LEVEL' }).accepted, false)

    // Trip the pump and flood the vessel until HI-LEVEL fires.
    session.injectPumpTrip()
    session.fastForward(30)
    assert.equal(session.readOutcome().alarmHiLevel, true)

    const ack = ackAlarm({ code: 'HI-LEVEL' })
    assert.equal(ack.accepted, true)
    assert.equal(world.getComponent(ids.alarmHi, components.Alarm)?.acked, true)

    // Second ack of the same active alarm is a no-op → rejected.
    assert.equal(ackAlarm({ code: 'HI-LEVEL' }).accepted, false)

    // Recover; when the condition clears, the ack latch clears with it.
    session.proposeResetAndStart()
    session.fastForward(60)
    const hi = world.getComponent(ids.alarmHi, components.Alarm)
    assert.equal(hi?.active, false)
    assert.equal(hi?.acked, false)
  })

  it('historian records samples; checkpoint restore is timeline-consistent after a branch compare', async () => {
    const { createPlantSession } = await loadSession()
    const session = createPlantSession({ seed: [3, 3, 3, 3], sensorCount: 20 })
    session.fastForward(50)
    const hist = session.getHistorian()
    assert.ok(hist.samples.length >= 40, `samples=${hist.samples.length}`)
    const midTick = hist.samples[Math.floor(hist.samples.length / 2)].tick

    session.injectPumpTrip()
    session.fastForward(10)
    assert.equal(session.readOutcome().pumpTrip, true)

    const cps = session.getCheckpoints()
    assert.ok(cps.length > 0, 'expected checkpoints')

    // Asking for a tick before the earliest checkpoint refuses instead of
    // silently jumping forward.
    const earliest = cps[0].tick
    assert.equal(session.restoreHistorianCheckpoint(earliest - 1), false)

    // A branch compare must not pollute the ring with speculative snapshots.
    const before = session.getCheckpoints().map((c) => c.tick)
    session.compareBranches(
      40,
      (s) => s.proposeRestartPump(),
      (s) => s.proposeResetAndStart(),
    )
    assert.deepEqual(
      session.getCheckpoints().map((c) => c.tick),
      before,
      'speculative rollouts must not enter the checkpoint ring',
    )

    // Restore to the pre-fault era and verify the restored timeline: the trip
    // is gone AND checkpoints from the abandoned future were dropped.
    const ok = session.restoreHistorianCheckpoint(midTick)
    assert.equal(ok, true)
    assert.equal(session.readOutcome().pumpTrip, false)
    const maxTick = Math.max(...session.getCheckpoints().map((c) => c.tick))
    assert.ok(
      maxTick <= session.world.time.tick,
      `stale future checkpoints survive restore (max=${maxTick}, tick=${session.world.time.tick})`,
    )

    // Continue on the new timeline: re-visited ticks replace instead of
    // keeping the abandoned timeline's snapshots.
    session.fastForward(30)
    const revisit = session
      .getCheckpoints()
      .find((c) => c.tick > midTick)
    assert.ok(revisit, 'new timeline records fresh checkpoints')
    assert.equal(session.restoreHistorianCheckpoint(revisit.tick), true)
    assert.equal(
      session.readOutcome().pumpTrip,
      false,
      'restored checkpoint must reflect the live (recovered) timeline, not the abandoned faulted one',
    )
  })

  it('is deterministic across identical seeds (full snapshot compare)', async () => {
    const { createPlantSession } = await loadSession()
    const run = () => {
      const s = createPlantSession({ seed: [9, 9, 9, 9], sensorCount: 30 })
      s.fastForward(10)
      s.injectPumpTrip()
      s.fastForward(20)
      return JSON.stringify(s.bridge.snapshot())
    }
    assert.equal(run(), run())
  })
})
