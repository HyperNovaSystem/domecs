#!/usr/bin/env node
/**
 * CPU profile of one workload against the built dist (PLAN WS-5 A0).
 * Re-runs itself under `node --cpu-prof`, so the .cpuprofile lands in
 * bench/profiles/ (open it in Chrome DevTools > Performance).
 *
 *   pnpm bench:profile soak|windowed|telemetry [ticks]   # builds core first
 *   node bench/profile.mjs soak 5000
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const which = process.argv[2] ?? 'soak'
const ticks = Number(process.argv[3] ?? 5000)

if (!process.execArgv.some((a) => a.startsWith('--cpu-prof'))) {
  const dir = join(root, 'bench/profiles')
  const run = spawnSync(
    process.execPath,
    ['--cpu-prof', `--cpu-prof-dir=${dir}`, `--cpu-prof-name=${which}-${Date.now()}.cpuprofile`, fileURLToPath(import.meta.url), which, String(ticks)],
    { stdio: 'inherit' },
  )
  if (run.status === 0) console.error(`[profile] wrote bench/profiles/${which}-*.cpuprofile`)
  process.exit(run.status ?? 1)
}

const { createWorld, defineComponent, entry, OnChanged } = await import(
  pathToFileURL(join(root, 'packages/domecs/dist/index.js')).href
)
const Position = defineComponent('BenchPosition', { defaults: { x: 0, y: 0 } })
const Velocity = defineComponent('BenchVelocity', { defaults: { dx: 0, dy: 0 } })
const Telemetry = defineComponent('BenchTelemetry', { defaults: { value: 0, dirty: false } })
const Row = defineComponent('BenchRow', { defaults: { rank: 0, label: '' } })

// The same shapes as bench/run.mjs, built for many ticks of samples.
const builders = {
  soak() {
    const world = createWorld({ headless: true, fixedStep: 1 / 60 })
    world.system('bench-move', { schedule: 'fixed', query: [Position, Velocity] }, ({ entities }) => {
      for (const e of entities) {
        e.BenchPosition.x += e.BenchVelocity.dx
        e.BenchPosition.y += e.BenchVelocity.dy
        world.markChanged(e.id, Position)
      }
    })
    world.system('bench-read-changes', { schedule: 'reactive', reactsTo: OnChanged(Position) }, () => {})
    for (let i = 0; i < 5000; i++) {
      world.spawn([entry(Position, { x: i % 100, y: (i * 3) % 100 }), entry(Velocity, { dx: 0.01, dy: -0.02 })])
    }
    return world
  },
  windowed() {
    const world = createWorld({ headless: true })
    const ids = []
    for (let i = 0; i < 2000; i++) ids.push(world.spawn([entry(Telemetry, { value: i, dirty: false })]))
    let windowStart = 0
    const visible = new Set()
    world.system('window-project', { schedule: 'tick' }, () => {
      const next = new Set()
      for (let k = 0; k < 50; k++) next.add(ids[(windowStart + k) % ids.length])
      for (const id of visible) if (!next.has(id)) { world.removeComponent(id, Row); visible.delete(id) }
      for (const id of next) {
        if (!visible.has(id)) { world.addComponent(id, Row, { rank: 0, label: String(id) }); visible.add(id) }
        else { const r = world.getComponent(id, Row); r.rank = (r.rank + 1) % 1000; world.markChanged(id, Row) }
      }
      windowStart = (windowStart + 3) % ids.length
    })
    return world
  },
  telemetry() {
    const world = createWorld({ headless: true })
    const ids = []
    for (let i = 0; i < 2000; i++) ids.push(world.spawn([entry(Telemetry, { value: 0, dirty: false })]))
    const hot = ids.slice(0, 100)
    world.system('bench-firehose', { schedule: 'tick' }, () => {
      for (let k = 0; k < 1000; k++) {
        const id = hot[k % hot.length]
        const t = world.getComponent(id, Telemetry)
        t.value += 1
        world.markChanged(id, Telemetry)
      }
    })
    world.system('bench-consume', { schedule: 'reactive', reactsTo: OnChanged(Telemetry) }, () => {})
    return world
  },
}

const build = builders[which]
if (!build) {
  console.error(`[profile] unknown workload "${which}"; use ${Object.keys(builders).join(' | ')}`)
  process.exit(1)
}
const world = build()
for (let t = 0; t < ticks; t++) world.step(1 / 60)
