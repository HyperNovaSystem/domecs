import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Walker, createSim, run } from '../src/sim.mjs'

// Source with comments and string/template literals blanked, so a comment
// such as "use world.rand, not Math.random" is not mistaken for a call.
function codeOnly(src) {
  let out = ""
  for (let i = 0; i < src.length; ) {
    const c = src[i]
    const d = src[i + 1]
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue }
    if (c === "/" && d === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue }
    if (c === "\"" || c === "'" || c === "`") {
      i++
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1
      i++
      out += " "
      continue
    }
    out += c
    i++
  }
  return out
}

const positions = (world) =>
  world.listEntities([Walker]).map((id) => {
    const w = world.getComponent(id, Walker)
    return [w.x, w.y]
  })

test('100 walkers that actually move', () => {
  const world = createSim([1, 2, 3, 4])
  const ids = world.listEntities([Walker])
  assert.equal(ids.length, 100)
  world.step(1 / 60)
  const moved = ids.filter((id) => {
    const w = world.getComponent(id, Walker)
    return w.x !== 0 || w.y !== 0
  })
  assert.ok(moved.length > 90)
  for (const id of ids) {
    const w = world.getComponent(id, Walker)
    assert.ok(w.x >= -1 && w.x < 1 && w.y >= -1 && w.y < 1)
  }
})

test('walkers take independent random steps', () => {
  const world = createSim([5, 5, 5, 5])
  world.step(1 / 60)
  const steps = positions(world)
  assert.ok(new Set(steps.map(([x]) => x)).size > 90, 'x steps should differ between walkers')
  assert.ok(new Set(steps.map(([, y]) => y)).size > 90, 'y steps should differ between walkers')
})

test('same seed, same trajectories; different seed, different trajectories', () => {
  const walk = (seed) => {
    const world = createSim(seed)
    for (let i = 0; i < 50; i++) world.step(1 / 60)
    return JSON.stringify(positions(world))
  }
  assert.equal(walk([3, 1, 4, 1]), walk([3, 1, 4, 1]))
  assert.notEqual(walk([3, 1, 4, 1]), walk([2, 7, 1, 8]))
})

test('run(seed, ticks) is the snapshot after that many steps', () => {
  const world = createSim([3, 1, 4, 1])
  for (let i = 0; i < 25; i++) world.step(1 / 60)
  assert.equal(run([3, 1, 4, 1], 25), JSON.stringify(world.snapshot()))
})

test('a restored world continues exactly', () => {
  const a = createSim([9, 8, 7, 6])
  for (let i = 0; i < 20; i++) a.step(1 / 60)
  const snap = a.snapshot()
  const b = createSim([1, 1, 1, 1])
  b.restore(snap)
  for (let i = 0; i < 20; i++) {
    a.step(1 / 60)
    b.step(1 / 60)
  }
  assert.equal(JSON.stringify(b.snapshot()), JSON.stringify(a.snapshot()))
})

test('no Math.random or wall-clock time in the source', () => {
  const src = readdirSync('src', { recursive: true })
    .filter((f) => /\.(m?js|ts)$/.test(f))
    .map((f) => codeOnly(readFileSync(join('src', f), 'utf8')))
    .join('\n')
  assert.ok(!/Math\s*\.\s*random|Date\s*\.\s*now|new\s+Date\s*\(|performance\s*\.\s*now/.test(src))
})
