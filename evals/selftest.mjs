#!/usr/bin/env node
/**
 * Grader self-test (free, no agent). First, every reference solution must
 * pass its grader (run.mjs --agent reference). Then each mutant, the
 * reference with one known trap reintroduced, must fail an assertion: a
 * mutant that only breaks loading (syntax, import) does not count as caught,
 * since that would pass a grader that tests nothing.
 *
 *   node evals/selftest.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const evalsDir = path.dirname(fileURLToPath(import.meta.url))

const mutants = {
  'agent-counter': [
    ['no payload schema', [", { schema: { fields: { by: { kind: 'number' } } } }", '']],
    ['act followed by an extra step', ['bridge.captureBaseline()\n', "bridge.captureBaseline()\n  const act = bridge.act.bind(bridge)\n  bridge.act = (t, p, o) => { const r = act(t, p, o); world.stepOnce(); return r }\n"]],
    ['a second Counter that count() reports', ['  counterId = world.spawn([entry(Counter, { n: 0 })])', '  world.spawn([entry(Counter, { n: 0 })])\n  counterId = world.spawn([entry(Counter, { n: 0 })])']],
  ],
  'fixed-projectile': [
    ['stepOnce instead of step(dt)', ['world.step(1 / 60)', 'world.stepOnce()']],
    ['Math.random instead of world.rand', ['world.rand.uniformRange(0, 10), vy: world.rand.uniformRange(0, 10)', 'Math.random() * 10, vy: Math.random() * 10']],
    ["a 'tick' system instead of 'fixed'", ["{ schedule: 'fixed', query: [Body] }", "{ schedule: 'tick', query: [Body] }"]],
    ['no markChanged after moving', ['      world.markChanged(e.id, Body)\n', '']],
  ],
  'change-reader': [
    ['no markChanged after damage', ['  world.getComponent(id, Health).hp -= amount\n  world.markChanged(id, Health)', '  world.getComponent(id, Health).hp -= amount']],
    ['ignores removals', ['Or(OnChanged(Health), OnRemoved(Health))', 'OnChanged(Health)']],
  ],
  'seeded-walk': [
    ['Math.random instead of world.rand', ['rand.uniformRange(-1, 1)\n      e.Walker.y', 'Math.random() * 2 - 1\n      e.Walker.y']],
    ['constant steps instead of random ones', ['e.Walker.x += rand.uniformRange(-1, 1)\n      e.Walker.y += rand.uniformRange(-1, 1)', 'e.Walker.x += 0.25\n      e.Walker.y += 0.25']],
    ['run() returns the wrong thing', ['  return JSON.stringify(world.snapshot())', '  return JSON.stringify(seed)']],
  ],
}

// 1. The references, graded exactly as an agent's work would be.
const ref = spawnSync(process.execPath, [path.join(evalsDir, 'run.mjs'), '--agent', 'reference', '--keep'], { encoding: 'utf8' })
process.stderr.write(ref.stderr.split('\n').filter((l) => l.startsWith('[eval]')).join('\n') + '\n')
if (ref.status !== 0) {
  console.error('[selftest] a reference solution failed its grader')
  process.exit(1)
}
// The kept template from that run, for building mutants.
const template = findTemplate()

// 2. The mutants.
let bad = 0
for (const [task, list] of Object.entries(mutants)) {
  const taskDir = path.join(evalsDir, 'tasks', task)
  const grader = fs.readFileSync(path.join(taskDir, 'grader.test.mjs'), 'utf8')
  for (const [label, [from, to]] of list) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `domecs-mutant-${task}-`))
    fs.cpSync(template, work, { recursive: true })
    fs.cpSync(path.join(taskDir, 'reference'), work, { recursive: true })
    const file = path.join(work, 'src', 'sim.mjs')
    const src = fs.readFileSync(file, 'utf8')
    if (!src.includes(from)) {
      console.error(`[selftest] ${task} / ${label}: mutation anchor not found`)
      bad++
      continue
    }
    fs.writeFileSync(file, src.replace(from, to))
    fs.mkdirSync(path.join(work, '.grader'))
    fs.writeFileSync(path.join(work, '.grader', 'grader.test.mjs'), grader)
    const r = spawnSync(process.execPath, ['--test', '.grader/grader.test.mjs'], { cwd: work, encoding: 'utf8' })
    const out = r.stdout + r.stderr
    const asserted = /ERR_ASSERTION|AssertionError/.test(out)
    const loadError = /SyntaxError|ERR_MODULE_NOT_FOUND|ReferenceError/.test(out)
    const caught = r.status !== 0 && asserted && !loadError
    console.error(`[selftest] ${task} / ${label}: ${caught ? 'caught' : r.status === 0 ? 'NOT CAUGHT' : 'FAILED TO LOAD (not a real catch)'}`)
    if (!caught) bad++
    fs.rmSync(work, { recursive: true, force: true })
  }
}
// 3. A candidate that exits during import, before any grader test
// registers, makes node --test report the file as one passing test. run.mjs
// must still fail it: it needs every named grader test to have run.
{
  const taskDir = path.join(evalsDir, 'tasks', 'agent-counter')
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'domecs-mutant-exit-'))
  fs.cpSync(template, work, { recursive: true })
  fs.mkdirSync(path.join(work, 'src'), { recursive: true })
  fs.writeFileSync(path.join(work, 'src', 'sim.mjs'), 'process.exit(0)\n')
  fs.mkdirSync(path.join(work, '.grader'))
  const grader = fs.readFileSync(path.join(taskDir, 'grader.test.mjs'), 'utf8')
  fs.writeFileSync(path.join(work, '.grader', 'grader.test.mjs'), grader)
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '.grader/grader.test.mjs'], { cwd: work, encoding: 'utf8' })
  const expected = (grader.match(/^test\(/gm) ?? []).length
  const okNamed = (r.stdout.match(/^ok \d+ - (?!\.grader\/)/gm) ?? []).length
  const wouldPass = r.status === 0 && okNamed === expected
  console.error(`[selftest] early exit during import: ${wouldPass ? 'NOT CAUGHT' : 'caught'} (exit ${r.status}, ${okNamed}/${expected} named tests ran)`)
  if (wouldPass) bad++
  fs.rmSync(work, { recursive: true, force: true })
}

fs.rmSync(path.dirname(template), { recursive: true, force: true })
process.exit(bad === 0 ? 0 : 1)

/** The newest template a reference run left in tmp (it was run with --keep). */
function findTemplate() {
  const runs = fs
    .readdirSync(os.tmpdir())
    .filter((d) => d.startsWith('domecs-eval-run-'))
    .map((d) => path.join(os.tmpdir(), d))
    .filter((d) => fs.existsSync(path.join(d, 'template', 'node_modules')))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  if (runs.length === 0) {
    console.error('[selftest] no template from the reference run')
    process.exit(1)
  }
  return path.join(runs[0], 'template')
}
