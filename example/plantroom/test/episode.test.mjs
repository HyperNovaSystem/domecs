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

describe('plantroom episode (WS-4)', () => {
  it('fault → branch compare: competent strategy cooler', async () => {
    const { createPlantSession } = await loadSession()
    const session = createPlantSession({ seed: [1, 2, 3, 4], sensorCount: 200 })
    assert.ok(session.entityCount() >= 200, 'hundreds of entities')

    session.fastForward(5)
    assert.equal(session.readOutcome().pumpRunning, true)

    session.injectPumpTrip()
    session.fastForward(1)
    assert.equal(session.readOutcome().pumpTrip, true)

    const { outcomeA, outcomeB } = session.compareBranches(
      40,
      (s) => s.proposeRestartPump(),
      (s) => s.proposeResetAndStart(),
    )
    assert.equal(outcomeA.pumpTrip, true)
    assert.equal(outcomeB.pumpTrip, false)
    assert.equal(outcomeB.pumpRunning, true)
    assert.ok(outcomeB.temp < outcomeA.temp)
  })

  it('operator approval: proposal does not apply until approve', async () => {
    const { createPlantSession } = await loadSession()
    const session = createPlantSession({ seed: [2, 2, 2, 2], sensorCount: 50 })
    session.fastForward(3)
    session.injectPumpTrip()
    session.fastForward(1)
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
    assert.equal(session.getPendingProposal(), null)
    assert.equal(session.readOutcome().pumpTrip, false)
    assert.equal(session.readOutcome().pumpRunning, true)
  })

  it('historian records samples; checkpoints restore', async () => {
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
    const ok = session.restoreHistorianCheckpoint(midTick)
    assert.equal(ok, true)
    // After restore to pre-fault era, trip should be false
    assert.equal(session.readOutcome().pumpTrip, false)
  })

  it('is deterministic across identical seeds', async () => {
    const { createPlantSession } = await loadSession()
    const run = () => {
      const s = createPlantSession({ seed: [9, 9, 9, 9], sensorCount: 30 })
      s.fastForward(10)
      s.injectPumpTrip()
      s.fastForward(20)
      return JSON.stringify(s.readOutcome())
    }
    assert.equal(run(), run())
  })
})
