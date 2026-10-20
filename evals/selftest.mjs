#!/usr/bin/env node
/**
 * Grader self-test (free, no agent): every reference solution must pass its
 * grader, and each mutant, the reference with one known trap reintroduced,
 * must fail it. A grader that passes a mutant is not testing that trap.
 *
 *   node evals/selftest.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const evalsDir = path.dirname(fileURLToPath(import.meta.url))
const template = path.join(evalsDir, '.cache', 'template')

const mutants = {
  'agent-counter': [
    ['no payload schema', [", { schema: { fields: { by: { kind: 'number' } } } }", '']],
    ['act followed by an extra step', ['bridge.captureBaseline()\n', "bridge.captureBaseline()\n  const act = bridge.act.bind(bridge)\n  bridge.act = (t, p, o) => { const r = act(t, p, o); world.stepOnce(); return r }\n"]],
  ],
  'fixed-projectile': [
    ['stepOnce instead of step(dt)', ['world.step(1 / 60)', 'world.stepOnce()']],
    ['Math.random instead of world.rand', ['world.rand.uniformRange(0, 10), vy: world.rand.uniformRange(0, 10)', 'Math.random() * 10, vy: Math.random() * 10']],
  ],
  'change-reader': [
    ['no markChanged after damage', ['  world.getComponent(id, Health).hp -= amount\n  world.markChanged(id, Health)', '  world.getComponent(id, Health).hp -= amount']],
    ['ignores removals', ['Or(OnChanged(Health), OnRemoved(Health))', 'OnChanged(Health)']],
  ],
  'seeded-walk': [
    ['Math.random instead of world.rand', ['rand.uniformRange(-1, 1)\n      e.Walker.y', 'Math.random() * 2 - 1\n      e.Walker.y']],
  ],
}

if (!fs.existsSync(template)) {
  const r = spawnSync(process.execPath, [path.join(evalsDir, 'run.mjs'), '--agent', 'reference'], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

let bad = 0
for (const [task, list] of Object.entries(mutants)) {
  const taskDir = path.join(evalsDir, 'tasks', task)
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
    fs.copyFileSync(path.join(taskDir, 'grader.test.mjs'), path.join(work, '.grader', 'grader.test.mjs'))
    const r = spawnSync(process.execPath, ['--test', '.grader/grader.test.mjs'], { cwd: work, encoding: 'utf8' })
    const caught = r.status !== 0
    console.error(`[selftest] ${task} / ${label}: ${caught ? 'caught' : 'NOT CAUGHT'}`)
    if (!caught) bad++
    fs.rmSync(work, { recursive: true, force: true })
  }
}
process.exit(bad === 0 ? 0 : 1)
