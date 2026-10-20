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
 *   node evals/run.mjs --regrade evals/results/<file>.json   # free: re-grade kept workspaces
 *
 * Paid agents run in a temp directory outside the repo and are graded in a
 * separate, fresh workspace that receives only their src/. Isolation from
 * user settings, hooks, plugins and MCP servers is as far as each CLI
 * allows; evals/README.md lists what is not covered.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const evalsDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(evalsDir, '..')
const args = parseArgs(process.argv.slice(2))
if (typeof args.regrade === 'string') {
  // Agent fields are taken from the results file being re-graded.
  args.agent = JSON.parse(fs.readFileSync(args.regrade, 'utf8')).agent
  args['confirm-cost'] = true
}
const agent = args.agent ?? 'reference'
const k = intArg('k', agent === 'reference' ? 1 : 3, 1, 50)
const timeoutMs = intArg('timeout', 15 * 60, 30, 3 * 60 * 60) * 1000
const budgetUsd = numArg('budget', 2, 0.1, 50)

if (!['reference', 'claude', 'codex'].includes(agent)) fail(`unknown --agent ${agent}`)
if (args['confirm-cost'] !== undefined && args['confirm-cost'] !== true) fail('--confirm-cost takes no value')
if (agent !== 'reference' && args['confirm-cost'] !== true) {
  fail(`--agent ${agent} spends money (about $${budgetUsd} cap per Claude attempt). Re-run with --confirm-cost.`)
}

// Agents run on the CLI's own login (a Claude or ChatGPT subscription), not
// an API key that happens to be in the shell: with a key in the env, either
// CLI may bill the API instead.
const agentEnv = { ...process.env }
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) delete agentEnv[key]

const tasksDir = path.join(evalsDir, 'tasks')
const tasks = fs
  .readdirSync(tasksDir)
  .filter((d) => fs.existsSync(path.join(tasksDir, d, 'task.json')))
  .filter((d) => !args.task || args.task === d)
  .map((d) => ({ dir: path.join(tasksDir, d), ...JSON.parse(fs.readFileSync(path.join(tasksDir, d, 'task.json'), 'utf8')) }))
if (tasks.length === 0) fail(`no task matches ${args.task}`)

// Per-run scratch outside the repo: concurrent runs never share it, and no
// path in an agent's workspace points back at the checkout (and its graders).
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'domecs-eval-run-'))
const template = prepareTemplate(scratch)

// --regrade: re-grade the kept (failed) workspaces of an earlier run with the
// current graders, without running any agent. Passing attempts' workspaces
// were deleted, so their verdicts carry over: fix a grader only by making it
// fairer, and say so in the commit.
if (typeof args.regrade === 'string') {
  const prior = JSON.parse(fs.readFileSync(args.regrade, 'utf8'))
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const regraded = prior.attempts.map((a) => {
    if (a.passed || !fs.existsSync(path.join(a.work, 'src'))) return a
    const grade = gradeAttempt(byId.get(a.task), a.work)
    console.error(`[eval] regrade ${a.task} #${a.attempt}: ${grade.passed ? 'PASS' : 'FAIL'} (${grade.tests.pass}/${grade.tests.expected} tests)`)
    return { ...a, passed: grade.passed, tests: grade.tests, regraded: true }
  })
  const perTask = [...new Set(regraded.map((a) => a.task))].map((task) => {
    const runs = regraded.filter((a) => a.task === task)
    const passes = runs.filter((a) => a.passed).length
    return { task, k: runs.length, passes, passAt1: passes / runs.length, passPowK: passes === runs.length }
  })
  const out = {
    ...prior,
    regradedAt: new Date().toISOString(),
    regradedFrom: path.basename(args.regrade),
    graderCommit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
    passAt1: perTask.reduce((a, t) => a + t.passAt1, 0) / perTask.length,
    passPowK: perTask.filter((t) => t.passPowK).length / perTask.length,
    perTask,
    attempts: regraded,
  }
  const file = args.regrade.replace(/\.json$/, '-regraded.json')
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', { flag: 'wx' })
  console.error(`[eval] wrote ${path.relative(root, file)}`)
  console.log(JSON.stringify({ ...out, attempts: undefined }, null, 2))
  fs.rmSync(scratch, { recursive: true, force: true })
  process.exit(0)
}
const attempts = []
for (const task of tasks) {
  for (let i = 0; i < k; i++) {
    const work = fs.mkdtempSync(path.join(scratch, `${task.id}-`))
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
    if (grade.passed && args.keep !== true) fs.rmSync(work, { recursive: true, force: true })
  }
}
if (attempts.every((a) => a.passed) && args.keep !== true) fs.rmSync(scratch, { recursive: true, force: true })

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
if (agent !== 'reference' || args.write === true) {
  // A full timestamp and exclusive create: a before/after pair on the same
  // day, or two task selections, never overwrite each other.
  const stamp = summary.when.replace(/[:.]/g, '-')
  const out = path.join(evalsDir, 'results', `${stamp}-${agent}${args.model ? `-${args.model}` : ''}.json`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' })
  console.error(`[eval] wrote ${path.relative(root, out)}`)
}
console.log(JSON.stringify({ ...summary, attempts: undefined }, null, 2))
if (agent === 'reference' && summary.passPowK < 1) process.exit(1)

/**
 * Pack @domecs/core once per run and install it into a template project.
 * The tarball sits inside the template and is referenced relatively, so the
 * workspace holds no path back to the repo.
 */
function prepareTemplate(scratch) {
  const template = path.join(scratch, 'template')
  fs.mkdirSync(path.join(template, 'vendor'), { recursive: true })
  run('pnpm', ['--filter', '@domecs/core', 'build'], { cwd: root })
  run('pnpm', ['pack', '--pack-destination', path.join(template, 'vendor')], { cwd: path.join(root, 'packages/domecs') })
  const tarball = fs.readdirSync(path.join(template, 'vendor')).find((f) => f.endsWith('.tgz'))
  fs.writeFileSync(
    path.join(template, 'package.json'),
    JSON.stringify(
      { name: 'domecs-eval-task', private: true, type: 'module', dependencies: { '@domecs/core': `file:./vendor/${tarball}` } },
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
      // Available tools (not just pre-approved ones), then what runs unasked.
      '--tools',
      'Read,Write,Edit,Glob,Grep,Bash',
      '--allowedTools',
      'Read Write Edit Glob Grep Bash(node:*) Bash(ls:*) Bash(cat:*) Bash(mkdir:*)',
      // The repo (and its graders) lives under /home; the workspace is in tmp.
      '--settings',
      JSON.stringify({ permissions: { deny: ['Read(//home/**)', 'Glob(//home/**)', 'Grep(//home/**)'] } }),
      '--setting-sources',
      'project',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--max-budget-usd',
      String(budgetUsd),
    ]
    if (args.model) cli.push('--model', args.model)
    const r = spawnSync('claude', cli, { cwd: work, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20, env: agentEnv })
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
  const cli = ['exec', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--ephemeral', '-s', 'workspace-write']
  if (args.model) cli.push('-m', args.model)
  cli.push(task.prompt)
  const r = spawnSync('codex', cli, { cwd: work, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20, input: '', env: agentEnv })
  const tokens = /tokens used\s*\n?\s*([\d,]+)/.exec(r.stdout + r.stderr)?.[1]
  return {
    meta: {
      tokens: tokens ? Number(tokens.replace(/,/g, '')) : null,
      agentError: r.error ? String(r.error.message) : r.status !== 0 ? `exit ${r.status}` : null,
    },
  }
}

/**
 * Grade in a fresh workspace built from the template, holding only the
 * agent's src/: nothing else the agent wrote (a planted .grader, edited
 * node_modules) reaches the grader. Passing needs every named test in the
 * grader to have run and passed; a candidate that exits during import, before
 * any test registers, shows up as one passing "file" and must not count.
 */
function gradeAttempt(task, work) {
  const graderFile = path.join(task.dir, 'grader.test.mjs')
  const expected = (fs.readFileSync(graderFile, 'utf8').match(/^test\(/gm) ?? []).length
  const grading = fs.mkdtempSync(path.join(path.dirname(work), `${path.basename(work)}-grade-`))
  fs.cpSync(template, grading, { recursive: true })
  fs.rmSync(path.join(grading, 'src'), { recursive: true, force: true })
  if (fs.existsSync(path.join(work, 'src'))) {
    fs.cpSync(path.join(work, 'src'), path.join(grading, 'src'), { recursive: true, dereference: true })
  }
  fs.mkdirSync(path.join(grading, '.grader'))
  fs.copyFileSync(graderFile, path.join(grading, '.grader', 'grader.test.mjs'))
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '.grader/grader.test.mjs'], {
    cwd: grading,
    encoding: 'utf8',
    timeout: 120_000,
  })
  const count = (label) => Number(new RegExp(`^# ${label} (\\d+)`, 'm').exec(r.stdout)?.[1] ?? 0)
  // Top-level `ok N - name` lines, one per grader test that ran and passed.
  const okNamed = (r.stdout.match(/^ok \d+ - (?!\.grader\/)/gm) ?? []).length
  const tests = { pass: count('pass'), fail: count('fail'), expected }
  fs.writeFileSync(path.join(work, 'grader-result.tap'), r.stdout + r.stderr)
  fs.rmSync(grading, { recursive: true, force: true })
  const passed = r.status === 0 && tests.fail === 0 && expected > 0 && tests.pass === expected && okNamed === expected
  return { passed, tests }
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

function intArg(name, fallback, min, max) {
  if (args[name] === undefined) return fallback
  const n = Number(args[name])
  if (!Number.isInteger(n) || n < min || n > max) fail(`--${name} must be an integer from ${min} to ${max}`)
  return n
}

function numArg(name, fallback, min, max) {
  if (args[name] === undefined) return fallback
  const n = Number(args[name])
  if (!Number.isFinite(n) || n < min || n > max) fail(`--${name} must be a number from ${min} to ${max}`)
  return n
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
