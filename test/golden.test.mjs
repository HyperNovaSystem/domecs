/**
 * Dual-runtime determinism golden (spec §3.4; plan E8.1).
 *
 * `scripts/determinism-golden.mjs` builds fixed headless worlds from the
 * built `@domecs/core` dist and prints one JSON line
 * `{ buildId, fixtures: { <name>: <strict hash> }, dmathFingerprint }`.
 * This test spawns it under `process.execPath` and compares `fixtures` and
 * `dmathFingerprint` with `test/golden/determinism.json`. With
 * `DOMECS_ALT_RUNTIME` set (for example
 * `"env ELECTRON_RUN_AS_NODE=1 /path/to/electron"`) it also spawns the script
 * under that command and requires byte-identical output.
 *
 *   pnpm test:golden                                   # builds core first
 *   DOMECS_ALT_RUNTIME="env ELECTRON_RUN_AS_NODE=1 $(which electron)" pnpm test:golden
 *   node scripts/determinism-golden.mjs --write        # deliberate re-bless
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts/determinism-golden.mjs')
const golden = JSON.parse(fs.readFileSync(path.join(root, 'test/golden/determinism.json'), 'utf8'))

const FIXTURES = ['bounce0', 'own-streams', 'random', 'trig']

/** Run the golden script under `argv0 ...prefix` and return [stdout line, parsed]. */
function runUnder(command, extraArgs = [], cwd = root) {
  const [cmd, ...prefix] = command
  const r = spawnSync(cmd, [...prefix, script, ...extraArgs], { cwd, encoding: 'utf8', timeout: 120_000 })
  assert.equal(r.status, 0, `${command.join(' ')} failed (${r.status})\n${r.stderr}\n${r.stdout}`)
  const lines = r.stdout.trim().split('\n')
  assert.equal(lines.length, 1, `expected one JSON line, got:\n${r.stdout}`)
  return [lines[0], JSON.parse(lines[0])]
}

const [nodeLine, nodeOut] = runUnder([process.execPath])

test('the script prints { buildId, fixtures, dmathFingerprint } with strict hashes', () => {
  assert.deepEqual(Object.keys(nodeOut), ['buildId', 'fixtures', 'dmathFingerprint'])
  assert.equal(typeof nodeOut.buildId, 'string')
  assert.deepEqual(Object.keys(nodeOut.fixtures).sort(), FIXTURES)
  for (const [name, hash] of Object.entries(nodeOut.fixtures)) {
    assert.match(hash, /^[0-9a-f]{16}$/, name)
  }
  assert.match(nodeOut.dmathFingerprint, /^[0-9a-f]{16}$/)
  // Every fixture is a distinct world.
  assert.equal(new Set(Object.values(nodeOut.fixtures)).size, FIXTURES.length)
})

test('Node output matches the committed golden (fixtures and dmathFingerprint, not buildId)', () => {
  assert.deepEqual(nodeOut.fixtures, golden.fixtures)
  assert.equal(nodeOut.dmathFingerprint, golden.dmathFingerprint)
})

test('the script is deterministic within one runtime', () => {
  const [again] = runUnder([process.execPath])
  assert.equal(again, nodeLine)
})

test('--engine resolves @domecs/core from a node_modules directory (studio runs the vendored copy)', () => {
  const nm = fs.mkdtempSync(path.join(os.tmpdir(), 'domecs-golden-'))
  try {
    fs.mkdirSync(path.join(nm, '@domecs'))
    fs.symlinkSync(path.join(root, 'packages/domecs'), path.join(nm, '@domecs/core'), 'dir')
    const [line] = runUnder([process.execPath], ['--engine', nm], os.tmpdir())
    assert.equal(line, nodeLine)
  } finally {
    fs.rmSync(nm, { recursive: true, force: true })
  }
})

const alt = process.env.DOMECS_ALT_RUNTIME?.trim()
test(
  'DOMECS_ALT_RUNTIME prints identical output',
  { skip: alt ? false : 'set DOMECS_ALT_RUNTIME (e.g. "env ELECTRON_RUN_AS_NODE=1 /path/electron") to run' },
  () => {
    const [altLine, altOut] = runUnder(alt.split(/\s+/))
    assert.deepEqual(altOut.fixtures, nodeOut.fixtures)
    assert.equal(altOut.dmathFingerprint, nodeOut.dmathFingerprint)
    assert.equal(altLine, nodeLine)
  },
)
