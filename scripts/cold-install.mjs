#!/usr/bin/env node
/**
 * Cold-install smoke (PLAN WS-2): pack runtime packages with pnpm (rewrites
 * workspace:* deps and applies publishConfig), install into an empty temp
 * directory, and import/run a minimal createWorld + createAgentBridge episode
 * using only packed tarballs (no workspace source).
 *
 * Usage (from repo root, after dependencies installed):
 *   node scripts/cold-install.mjs
 *   pnpm cold-install
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packs = [
  { name: '@domecs/core', dir: 'packages/domecs' },
  { name: '@domecs/persist', dir: 'packages/domecs-persist' },
]

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...opts,
  })
  if (r.status !== 0) {
    const detail = [r.stdout, r.stderr].filter(Boolean).join('\n')
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})\n${detail}`)
  }
  return r.stdout
}

console.error('[cold-install] build packages…')
run('pnpm', ['-r', '--filter', '@domecs/core', '--filter', '@domecs/persist', 'build'], {
  cwd: root,
})

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'domecs-cold-'))
console.error(`[cold-install] stage: ${stage}`)

// Install core first (file: tarball), then persist which depends on @domecs/core@1.0.0.
// Pointing both at local tarballs avoids hitting the registry for the workspace twin.
const tarballByName = {}
for (const p of packs) {
  const pkgDir = path.join(root, p.dir)
  console.error(`[cold-install] pnpm pack ${p.name}…`)
  // pnpm pack rewrites workspace:* → version and applies publishConfig → dist.
  // Discover the tarball on disk instead of parsing stdout — paths containing
  // spaces (the Windows temp-dir default) would truncate a token-based match.
  const before = new Set(fs.readdirSync(stage).filter((f) => f.endsWith('.tgz')))
  run('pnpm', ['pack', '--pack-destination', stage], { cwd: pkgDir })
  const created = fs.readdirSync(stage).filter((f) => f.endsWith('.tgz') && !before.has(f))
  if (created.length !== 1) {
    throw new Error(`expected exactly one new tarball for ${p.name}, saw: ${created.join(', ') || '(none)'}`)
  }
  const tgzPath = path.join(stage, created[0])
  tarballByName[p.name] = tgzPath
  console.error(`[cold-install]   → ${created[0]}`)
}

fs.writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'domecs-cold-install',
      private: true,
      type: 'module',
      dependencies: {
        '@domecs/core': `file:${tarballByName['@domecs/core']}`,
        '@domecs/persist': `file:${tarballByName['@domecs/persist']}`,
      },
    },
    null,
    2,
  ),
)

console.error('[cold-install] npm install…')
run('npm', ['install', '--no-package-lock', '--install-links'], { cwd: stage })

const probe = `
import { createWorld, createAgentBridge, defineComponent, entry } from '@domecs/core'
import { save, loadIfPresent, createMemoryStorage } from '@domecs/persist'

const C = defineComponent('Cold', { defaults: { n: 0 } })
const world = createWorld({ headless: true, seed: [1, 2, 3, 4] })
const id = world.spawn([entry(C, { n: 1 })])
const bridge = createAgentBridge(world)
bridge.captureBaseline()
const obs = bridge.observe()
if (obs.entityCount !== 1) throw new Error('entityCount')
if (!obs.manifest.components.some(c => c.name === 'Cold')) throw new Error('manifest')
world.getComponent(id, C).n = 9
world.markChanged(id, C)
bridge.reset()
if (world.getComponent(id, C).n !== 1) throw new Error('reset')
const storage = createMemoryStorage()
const s = save(world, storage, 's')
if (!s.ok) throw new Error('save')
const boot = loadIfPresent(createWorld({ headless: true }), storage, 'missing')
if (!boot.ok || boot.value !== false) throw new Error('loadIfPresent missing')
console.log(JSON.stringify({ ok: true, tick: obs.tick, entityCount: obs.entityCount }))
`

const probePath = path.join(stage, 'probe.mjs')
fs.writeFileSync(probePath, probe)
console.error('[cold-install] run probe…')
let result
try {
  result = run('node', [probePath], { cwd: stage })
} catch (err) {
  // Deliberate: the stage survives failures so the wreckage can be inspected.
  console.error(`[cold-install] FAILED — stage left for inspection: ${stage}`)
  throw err
}
console.log(result.trim())
console.error('[cold-install] OK')

try {
  fs.rmSync(stage, { recursive: true, force: true })
} catch {
  /* leave stage for inspection on stubborn Windows locks */
}
