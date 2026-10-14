#!/usr/bin/env node
/**
 * Cold-install smoke (PLAN WS-2): install every `@domecs/*` package into an
 * empty temp directory and run a minimal episode that touches each one, using
 * only what a consumer would get (no workspace source).
 *
 * By default the packages are packed with pnpm (which rewrites `workspace:`
 * ranges and applies publishConfig) — the exact payload `pnpm publish` would
 * ship. With `--registry [version]` they are installed from npm instead
 * (default: the workspace version), to check a release after publishing.
 *
 * Usage (from repo root, after dependencies installed):
 *   node scripts/cold-install.mjs
 *   node scripts/cold-install.mjs --registry          # this version, from npm
 *   node scripts/cold-install.mjs --registry 1.1.0
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
  { name: '@domecs/dom', dir: 'packages/domecs-dom' },
  { name: '@domecs/input', dir: 'packages/domecs-input' },
  { name: '@domecs/persist', dir: 'packages/domecs-persist' },
  { name: '@domecs/inspector', dir: 'packages/domecs-inspector' },
  { name: '@domecs/scene', dir: 'packages/domecs-scene' },
  { name: '@domecs/rules', dir: 'packages/domecs-rules' },
]

const registryAt = process.argv.indexOf('--registry')
const fromRegistry = registryAt !== -1
const registryVersion =
  fromRegistry && process.argv[registryAt + 1] && !process.argv[registryAt + 1].startsWith('-')
    ? process.argv[registryAt + 1]
    : JSON.parse(fs.readFileSync(path.join(root, 'packages/domecs/package.json'), 'utf8')).version

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

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'domecs-cold-'))
console.error(`[cold-install] stage: ${stage}`)

const dependencies = {}
if (fromRegistry) {
  console.error(`[cold-install] installing @domecs/*@${registryVersion} from the registry`)
  for (const p of packs) dependencies[p.name] = registryVersion
} else {
  console.error('[cold-install] build packages…')
  run('pnpm', ['-r', '--filter', './packages/*', 'build'], { cwd: root })
  // Every package is pointed at its local tarball, so the peer dependency on
  // @domecs/core resolves to the packed core rather than the registry's.
  for (const p of packs) {
    const pkgDir = path.join(root, p.dir)
    console.error(`[cold-install] pnpm pack ${p.name}…`)
    // pnpm pack rewrites workspace: ranges and applies publishConfig → dist.
    // Discover the tarball on disk instead of parsing stdout — paths containing
    // spaces (the Windows temp-dir default) would truncate a token-based match.
    const before = new Set(fs.readdirSync(stage).filter((f) => f.endsWith('.tgz')))
    run('pnpm', ['pack', '--pack-destination', stage], { cwd: pkgDir })
    const created = fs.readdirSync(stage).filter((f) => f.endsWith('.tgz') && !before.has(f))
    if (created.length !== 1) {
      throw new Error(`expected exactly one new tarball for ${p.name}, saw: ${created.join(', ') || '(none)'}`)
    }
    dependencies[p.name] = `file:${path.join(stage, created[0])}`
    console.error(`[cold-install]   → ${created[0]}`)
  }
}

fs.writeFileSync(
  path.join(stage, 'package.json'),
  JSON.stringify({ name: 'domecs-cold-install', private: true, type: 'module', dependencies }, null, 2),
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

// The other packages: each must import headless and do one real thing.
import { Parent, setParent, childrenOf } from '@domecs/scene'
import { installRules } from '@domecs/rules'
import { mountDOM } from '@domecs/dom'
import { createInputPlugin } from '@domecs/input'
import { createInspector } from '@domecs/inspector'
for (const [name, fn] of Object.entries({ mountDOM, createInputPlugin, createInspector })) {
  if (typeof fn !== 'function') throw new Error(name)
}
const w2 = createWorld({ headless: true, seed: [1, 2, 3, 4] })
const parent = w2.spawn([entry(C, { n: 1 })])
const child = w2.spawn([entry(C, { n: 2 })])
if (!setParent(w2, child, parent).ok || childrenOf(w2, parent)[0] !== child) throw new Error('scene')
if (w2.getComponent(child, Parent).entity !== parent) throw new Error('scene Parent')
const rules = installRules(w2, [
  { name: 'double', schedule: 'tick', query: ['Cold'], actions: [{ set: 'Cold.n', expr: 'Cold.n * 2' }] },
], (n) => (n === 'Cold' ? C : undefined))
w2.step(1 / 60)
if (w2.getComponent(child, C).n !== 4) throw new Error('rules')
rules.uninstall()

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
