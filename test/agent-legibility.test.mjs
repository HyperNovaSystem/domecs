/**
 * WS-3 falsifiable legibility gate: the skill-shaped mini-app must complete
 * a deterministic agent episode against built @domecs/core dist.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('agent legibility mini-app (WS-3)', () => {
  it('observe→act→step→snapshot→reset is deterministic with score=7', () => {
    // Ensure dist exists for published-layout resolution.
    const build = spawnSync(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['--filter', '@domecs/core', 'build'],
      { cwd: root, encoding: 'utf8', shell: true },
    )
    assert.equal(build.status, 0, build.stderr || build.stdout)

    const r = spawnSync(
      process.execPath,
      [path.join(root, 'example/agent-legibility/run.mjs')],
      { cwd: root, encoding: 'utf8' },
    )
    assert.equal(r.status, 0, r.stderr || r.stdout)
    const json = JSON.parse(r.stdout.trim())
    assert.equal(json.ok, true)
    assert.equal(json.finalScore, 7)
    assert.equal(json.deterministic, true)
    assert.equal(json.observation.entityCount, 1)
  })
})
