/**
 * Plantroom WS-4 episode: fault → agent proposals → branch compare.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

describe('plantroom episode (WS-4)', () => {
  it('builds core then runs fault / branch / compare', async () => {
    const build = spawnSync(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['--filter', '@domecs/core', 'build'],
      { cwd: root, encoding: 'utf8', shell: true },
    )
    assert.equal(build.status, 0, build.stderr || build.stdout)

    const { createPlantSession } = await import(
      pathToFileURL(path.join(root, 'example/plantroom/src/session.mjs')).href
    )

    const session = createPlantSession({ seed: [1, 2, 3, 4] })
    const obs0 = session.observe()
    assert.ok(obs0.entityCount >= 5)
    assert.ok(obs0.manifest.components.some((c) => c.name === 'Vessel'))

    // Warm plant
    session.fastForward(5)
    const healthy = session.readOutcome()
    assert.equal(healthy.pumpRunning, true)
    assert.equal(healthy.pumpTrip, false)

    // Fault develops
    session.injectPumpTrip()
    session.fastForward(1)
    const faulted = session.readOutcome()
    assert.equal(faulted.pumpTrip, true)
    assert.equal(faulted.alarmTrip, true)

    // Compare strategies after fault
    const { outcomeA, outcomeB } = session.compareBranches(
      40,
      (s) => {
        // Naive agent: just try to restart (fails while tripped)
        s.proposeRestartPump()
      },
      (s) => {
        // Competent agent: reset trip then start
        s.proposeResetAndStart()
      },
    )

    // Branch B should recover cooling; branch A stays tripped / hotter
    assert.equal(outcomeA.pumpTrip, true, 'naive restart leaves trip')
    assert.equal(outcomeB.pumpTrip, false, 'reset+start clears trip')
    assert.equal(outcomeB.pumpRunning, true)
    assert.ok(
      outcomeB.temp < outcomeA.temp,
      `competent strategy cooler: B=${outcomeB.temp} A=${outcomeA.temp}`,
    )
  })

  it('is deterministic across identical seeds', async () => {
    const { createPlantSession } = await import(
      pathToFileURL(path.join(root, 'example/plantroom/src/session.mjs')).href
    )
    const run = () => {
      const s = createPlantSession({ seed: [9, 9, 9, 9] })
      s.fastForward(10)
      s.injectPumpTrip()
      s.fastForward(20)
      return JSON.stringify(s.readOutcome())
    }
    assert.equal(run(), run())
  })
})
