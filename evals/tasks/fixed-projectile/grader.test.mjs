import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { OnChanged } from '@domecs/core'
import { Body, advance, createSim } from '../src/sim.mjs'

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

const bodies = (world) => world.listEntities([Body]).map((id) => ({ ...world.getComponent(id, Body) }))

test('10 bodies at the origin with velocities in [0, 10)', () => {
  const b = bodies(createSim([1, 2, 3, 4]))
  assert.equal(b.length, 10)
  for (const body of b) {
    assert.equal(body.x, 0)
    assert.equal(body.y, 0)
    assert.ok(body.vx >= 0 && body.vx < 10 && body.vy >= 0 && body.vy < 10)
  }
})

test('advance(1) runs 60 semi-implicit Euler steps', () => {
  const world = createSim([5, 6, 7, 8])
  const start = bodies(world)
  advance(world, 1)
  const end = bodies(world)
  const dt = 1 / 60
  start.forEach((s, i) => {
    let { x, y, vx, vy } = s
    for (let k = 0; k < 60; k++) {
      vy += -9.8 * dt
      x += vx * dt
      y += vy * dt
    }
    assert.ok(Math.abs(end[i].x - x) < 1e-6, `x of body ${i}: ${end[i].x} vs ${x}`)
    assert.ok(Math.abs(end[i].y - y) < 1e-6, `y of body ${i}: ${end[i].y} vs ${y}`)
    assert.ok(Math.abs(end[i].vy - vy) < 1e-6, `vy of body ${i}`)
  })
})

test('deterministic per seed, different across seeds', () => {
  const run = (seed) => {
    const w = createSim(seed)
    advance(w, 0.5)
    return JSON.stringify(bodies(w))
  }
  assert.equal(run([1, 1, 1, 1]), run([1, 1, 1, 1]))
  assert.notEqual(run([1, 1, 1, 1]), run([9, 9, 9, 9]))
})

test('integration runs on fixed steps, not render ticks', () => {
  const world = createSim([2, 4, 6, 8])
  const [id] = world.listEntities([Body])
  const before = { ...world.getComponent(id, Body) }
  world.step(1 / 120)
  world.step(1 / 120)
  const after = world.getComponent(id, Body)
  const dt = 1 / 60
  const vy = before.vy - 9.8 * dt
  assert.ok(Math.abs(after.vy - vy) < 1e-9, `two half-steps should be one fixed step (vy ${after.vy} vs ${vy})`)
})

test('change readers see every moved body', () => {
  const world = createSim([3, 3, 3, 3])
  let seen = 0
  world.system('grader-reader', { schedule: 'reactive', reactsTo: OnChanged(Body) }, ({ entities }) => {
    seen += entities.length
  })
  world.step(1 / 60)
  assert.equal(seen, 10)
})

test('randomness comes from the world, not Math.random', () => {
  const src = readdirSync('src', { recursive: true })
    .filter((f) => /\.(m?js|ts)$/.test(f))
    .map((f) => codeOnly(readFileSync(join('src', f), 'utf8')))
    .join('\n')
  assert.ok(!/Math\s*\.\s*random/.test(src), 'uses Math.random')
})
