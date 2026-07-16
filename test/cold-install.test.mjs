/**
 * Cold-install gate (PLAN WS-2). Skipped unless RUN_COLD_INSTALL=1 so default
 * CI stays fast; release paths and manual checks set the env var.
 */
import { describe, it } from 'node:test'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const enabled = process.env.RUN_COLD_INSTALL === '1'

describe('cold-install from packed tarballs', { skip: !enabled }, () => {
  it('installs packed @domecs/core + persist and runs agent bridge probe', () => {
    const r = spawnSync(process.execPath, [path.join(root, 'scripts/cold-install.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      timeout: 180_000,
    })
    assert.equal(r.status, 0, r.stderr || r.stdout)
    assert.match(r.stdout, /"ok":\s*true/)
  })
})
