#!/usr/bin/env node
/**
 * Browser projection bench (PLAN WS-5 A0): the windowed workload with a real
 * DOM, in headless Chromium. A DOM shim cannot measure style and layout, so
 * this is the projection number; bench/run.mjs stays the headless one.
 *
 * Each trial loads bench/browser/page.html once per engine (DOMECS with
 * @domecs/dom, Koota with hand-written DOM, plain JS), interleaved so host
 * drift hits each engine alike. The verdict uses the same protocol as
 * bench/run.mjs: per-trial paired p95 ratios, median with a seeded
 * bootstrap 95% CI, and a decisive win needs the CI's upper bound ≤ 0.70.
 *
 * Usage:
 *   pnpm bench:browser                 # builds core + dom first
 *   node bench/browser/run.mjs --trials 7 --frames 300 --entities 2000
 *   CHROMIUM_PATH=/path/to/chrome node bench/browser/run.mjs
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { bootstrapMedianCI, median } from '../measure.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const args = parseArgs(process.argv.slice(2))
const trials = Math.max(1, Number(args.trials ?? 7))
const frames = Number(args.frames ?? 300)
const entities = Number(args.entities ?? 2000)
const windowSize = Number(args.window ?? 50)
const engines = ['domecs', 'koota', 'vanilla']

for (const dist of ['packages/domecs/dist/index.js', 'packages/domecs-dom/dist/index.js']) {
  if (!existsSync(join(root, dist))) {
    console.error(`[bench:browser] ${dist} not found; run \`pnpm bench:browser\` (it builds first).`)
    process.exit(1)
  }
}

const executablePath =
  process.env.CHROMIUM_PATH ??
  ['/usr/bin/chromium', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find((p) => existsSync(p))
if (!executablePath) {
  console.error('[bench:browser] No Chromium found. Set CHROMIUM_PATH.')
  process.exit(1)
}

const server = await serveRepo()
const base = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ executablePath, headless: true })

const byTrial = []
try {
  for (let t = 0; t < trials; t++) {
    const rows = {}
    for (const engine of engines) {
      const page = await browser.newPage({ viewport: { width: 800, height: 1200 } })
      const url = `${base}/bench/browser/page.html?engine=${engine}&n=${entities}&window=${windowSize}&frames=${frames}`
      await page.goto(url)
      await page.waitForFunction(() => window.__benchResult !== undefined, null, { timeout: 120_000 })
      const result = await page.evaluate(() => window.__benchResult)
      await page.close()
      if (result.error) throw new Error(`${engine}: ${result.error}`)
      rows[engine] = result
    }
    byTrial.push(rows)
  }
} finally {
  await browser.close()
  server.close()
}

const engineRows = engines.map((engine) => {
  const rs = byTrial.map((rows) => rows[engine])
  return {
    engine,
    trials: rs.length,
    scriptP95Ms: median(rs.map((r) => r.scriptP95Ms)),
    frameP50Ms: median(rs.map((r) => r.frameP50Ms)),
    frameP95Ms: median(rs.map((r) => r.frameP95Ms)),
    longAnimationFrames: rs.reduce((a, r) => a + r.longAnimationFrames, 0),
    domSplit: rs[0].domSplit,
    rowsMounted: rs[0].rowsMounted,
  }
})

const verdict = {}
for (const other of ['koota', 'vanilla']) {
  const ratios = byTrial.map((rows) => rows.domecs.frameP95Ms / rows[other].frameP95Ms)
  const ci = bootstrapMedianCI(ratios)
  verdict[`frame_domecs_vs_${other}_p95`] = {
    median: Number(ci.median.toFixed(3)),
    ci95: ci.ci95.map((x) => Number(x.toFixed(3))),
    range: [Math.min(...ratios), Math.max(...ratios)].map((x) => Number(x.toFixed(3))),
  }
}

// Same logical DOM work, or the timings compare different work. DOMECS's
// view also runs `update` once for each row it creates (first paint, O-2);
// the hand-written engines paint inside create, so those updates are
// subtracted before comparing.
const work = (r, e) => ({
  create: r.domSplit.create,
  update: e === 'domecs' ? r.domSplit.update - r.domSplit.create : r.domSplit.update,
  remove: r.domSplit.remove,
})
const works = engineRows.map((r) => JSON.stringify(work(r, r.engine)))
const workEqual = works.every((w) => w === works[0]) && engineRows.every((r) => r.rowsMounted === windowSize)

const wins = Object.entries(verdict)
  .filter(([, v]) => v.ci95[1] <= 0.7)
  .map(([k, v]) => `${k} (median ${v.median}×, CI ${v.ci95[0]}–${v.ci95[1]}×)`)

const summary = {
  when: new Date().toISOString(),
  browser: `${executablePath} ${browser.version?.() ?? ''}`.trim(),
  entities,
  windowSize,
  frames,
  trials,
  engines: engineRows,
  verdict,
  workEqual,
  decisiveRuntimeWins: wins,
  note:
    (workEqual ? '' : 'WARNING: engines did different DOM work; timings are not comparable. ') +
    (wins.length > 0 ? `Decisive win(s): ${wins.join('; ')}` : 'No projection win with a bootstrap CI under 0.70× p95.'),
}
console.log(JSON.stringify(summary, null, 2))
for (const r of engineRows) {
  console.error(
    `[browser:${r.engine}] n=${entities} window=${windowSize} frame p50=${r.frameP50Ms.toFixed(3)}ms ` +
      `p95=${r.frameP95Ms.toFixed(3)}ms script p95=${r.scriptP95Ms.toFixed(3)}ms LoAF=${r.longAnimationFrames}`,
  )
}

/** Static server for the repo root, so the page can import dist and koota. */
function serveRepo() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.map': 'application/json' }
  const server = createServer((req, res) => {
    const path = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)))
    if (!path.startsWith(root + sep) || !existsSync(path) || !statSync(path).isFile()) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, {
      'content-type': types[extname(path)] ?? 'application/octet-stream',
      // Cross-origin isolation: without it Chrome rounds performance.now()
      // to 0.1 ms, coarser than the frames being measured.
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    })
    res.end(readFileSync(path))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
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
