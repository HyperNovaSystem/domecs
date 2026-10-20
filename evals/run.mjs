#!/usr/bin/env node
/**
 * Agent evals for DOMECS (PLAN WS-5 B6): can a coding agent build working
 * DOMECS code from what the npm packages ship? Run on demand, at the start
 * and end of an improvement run; never on a schedule.
 *
 * Each task gives the agent a prompt and an empty project with the packed
 * @domecs/core tarball installed (exactly what an npm user gets), then runs a
 * hidden behavioral grader against what it wrote. A task is attempted `k`
 * times; we report pass@1 (mean pass rate) and pass^k (every attempt passed).
 *
 *   node evals/run.mjs --agent reference            # free: grades the reference solutions
 *   node evals/run.mjs --agent claude --k 3 --confirm-cost [--model sonnet] [--budget 2]
 *   node evals/run.mjs --agent codex  --k 3 --confirm-cost [--model gpt-5]
 *   node evals/run.mjs --task fixed-projectile --agent reference
 *
 * Paid agents run in a temp directory, isolated from user settings, hooks,
 * plugins and MCP servers as far as each CLI allows (see evals/README.md).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const evalsDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(evalsDir, '..')
const args = parseArgs(process.argv.slice(2))
const agent = args.agent ?? 'reference'
const k = Math.max(1, Number(args.k ?? (agent === 'reference' ? 1 : 3)))
const timeoutMs = Number(args.timeout ?? 15 * 60) * 1000
const budgetUsd = Number(args.budget ?? 2)

if (!['reference', 'claude', 'codex'].includes(agent)) fail(`unknown --agent ${agent}`)
if (agent !== 'reference' && !args['confirm-cost']) {
  fail(`--agent ${agent} spends money (about $${budgetUsd} cap per Claude attempt). Re-run with --confirm-cost.`)
}

const tasksDir = path.join(evalsDir, 'tasks')
const tasks = fs
  .readdirSync(tasksDir)
  .filter((d) => fs.existsSync(path.join(tasksDir, d, 'task.json')))
  .filter((d) => !args.task || args.task === d)
  .map((d) => ({ dir: path.join(tasksDir, d), ...JSON.parse(fs.readFileSync(path.join(tasksDir, d, 'task.json'), 'utf8')) }))
if (tasks.length === 0) fail(`no task matches ${args.task}`)

const template = prepareTemplate()
const attempts = []
for (const task of tasks) {
  for (let i = 0; i < k; i++) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `domecs-eval-${task.id}-`))
    fs.cpSync(template, work, { recursive: true })
    const started = Date.now()
    const run = runAgent(task, work)
    const grade = gradeAttempt(task, work)
    const attempt = {
      task: task.id,
      attempt: i + 1,
      passed: grade.passed,
      tests: grade.tests,
      durationMs: Date.now() - started,
      ...run.meta,
      work,
    }
    attempts.push(attempt)
    console.error(
      `[eval] ${task.id} #${i + 1}: ${grade.passed ? 'PASS' : 'FAIL'} (${grade.tests.pass}/${grade.tests.pass + grade.tests.fail} tests)` +
        (run.meta.costUsd != null ? ` $${run.meta.costUsd.toFixed(2)}` : '') +
        (run.meta.agentError ? ` agent error: ${run.meta.agentError}` : ''),
    )
    if (grade.passed && !args.keep) fs.rmSync(work, { recursive: true, force: true })
  }
}

const perTask = tasks.map((task) => {
  const runs = attempts.filter((a) => a.task === task.id)
  const passes = runs.filter((a) => a.passed).length
  return { task: task.id, k: runs.length, passes, passAt1: passes / runs.length, passPowK: passes === runs.length }
})
const summary = {
  when: new Date().toISOString(),
  agent,
  model: args.model ?? null,
  k,
  engine: JSON.parse(fs.readFileSync(path.join(root, 'packages/domecs/package.json'), 'utf8')).version,
  commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
  passAt1: perTask.reduce((a, t) => a + t.passAt1, 0) / perTask.length,
  passPowK: perTask.filter((t) => t.passPowK).length / perTask.length,
  costUsd: attempts.some((a) => a.costUsd != null) ? attempts.reduce((a, t) => a + (t.costUsd ?? 0), 0) : null,
  perTask,
  attempts,
}
if (agent !== 'reference' || args.write) {
  const out = path.join(evalsDir, 'results', `${summary.when.slice(0, 10)}-${agent}${args.model ? `-${args.model}` : ''}.json`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(summary, null, 2) + '\n')
  console.error(`[eval] wrote ${path.relative(root, out)}`)
}
console.log(JSON.stringify({ ...summary, attempts: undefined }, null, 2))
if (agent === 'reference' && summary.passPowK < 1) process.exit(1)

/** Pack @domecs/core once and install it into a template project. */
function prepareTemplate() {
  const cache = path.join(evalsDir, '.cache')
  const template = path.join(cache, 'template')
  fs.rmSync(cache, { recursive: true, force: true })
  fs.mkdirSync(template, { recursive: true })
  run('pnpm', ['--filter', '@domecs/core', 'build'], { cwd: root })
  run('pnpm', ['pack', '--pack-destination', cache], { cwd: path.join(root, 'packages/domecs') })
  const tarball = fs.readdirSync(cache).find((f) => f.endsWith('.tgz'))
  fs.writeFileSync(
    path.join(template, 'package.json'),
    JSON.stringify(
      { name: 'domecs-eval-task', private: true, type: 'module', dependencies: { '@domecs/core': `file:${path.join(cache, tarball)}` } },
      null,
      2,
    ) + '\n',
  )
  run('npm', ['install', '--no-package-lock', '--install-links', '--no-audit', '--no-fund'], { cwd: template })
  fs.mkdirSync(path.join(template, 'src'))
  return template
}

function runAgent(task, work) {
  if (agent === 'reference') {
    fs.cpSync(path.join(task.dir, 'reference'), work, { recursive: true })
    return { meta: {} }
  }
  if (agent === 'claude') {
    const cli = [
      '-p',
      task.prompt,
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Read Write Edit Glob Grep Bash(node:*) Bash(ls:*) Bash(cat:*) Bash(mkdir:*)',
      '--setting-sources',
      'project',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--max-budget-usd',
      String(budgetUsd),
    ]
    if (args.model) cli.push('--model', args.model)
    const r = spawnSync('claude', cli, { cwd: work, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20 })
    let parsed = null
    try {
      parsed = JSON.parse(r.stdout)
    } catch {
      // Not JSON: the CLI failed before producing a result.
    }
    return {
      meta: {
        costUsd: parsed?.total_cost_usd ?? null,
        turns: parsed?.num_turns ?? null,
        agentError: r.error ? String(r.error.message) : parsed?.is_error ? String(parsed.result).slice(0, 200) : null,
      },
    }
  }
  const cli = ['exec', '--skip-git-repo-check', '--ignore-user-config', '--ephemeral', '-s', 'workspace-write']
  if (args.model) cli.push('-m', args.model)
  cli.push(task.prompt)
  const r = spawnSync('codex', cli, { cwd: work, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20, input: '' })
  const tokens = /tokens used\s*\n?\s*([\d,]+)/.exec(r.stdout + r.stderr)?.[1]
  return {
    meta: {
      tokens: tokens ? Number(tokens.replace(/,/g, '')) : null,
      agentError: r.error ? String(r.error.message) : r.status !== 0 ? `exit ${r.status}` : null,
    },
  }
}

/** Copy the hidden grader in after the agent is done, and run it. */
function gradeAttempt(task, work) {
  const graderDir = path.join(work, '.grader')
  fs.mkdirSync(graderDir, { recursive: true })
  fs.copyFileSync(path.join(task.dir, 'grader.test.mjs'), path.join(graderDir, 'grader.test.mjs'))
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '.grader/grader.test.mjs'], {
    cwd: work,
    encoding: 'utf8',
    timeout: 120_000,
  })
  const count = (label) => Number(new RegExp(`^# ${label} (\\d+)`, 'm').exec(r.stdout)?.[1] ?? 0)
  const tests = { pass: count('pass'), fail: count('fail') }
  fs.writeFileSync(path.join(work, '.grader', 'result.tap'), r.stdout + r.stderr)
  return { passed: r.status === 0 && tests.fail === 0 && tests.pass > 0, tests }
}

function run(cmd, cliArgs, opts) {
  const r = spawnSync(cmd, cliArgs, { encoding: 'utf8', ...opts })
  if (r.status !== 0) fail(`${cmd} ${cliArgs.join(' ')} failed\n${r.stdout}\n${r.stderr}`)
  return r.stdout
}

function fail(message) {
  console.error(`[eval] ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) out[argv[i].slice(2)] = argv[++i]
    else out[argv[i].slice(2)] = true
  }
  return out
}
