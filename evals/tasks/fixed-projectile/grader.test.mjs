import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Body, advance, createSim } from '../src/sim.mjs'

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

test('randomness comes from the world, not Math.random', () => {
  const src = readdirSync('src', { recursive: true })
    .filter((f) => /\.(m?js|ts)$/.test(f))
    .map((f) => readFileSync(join('src', f), 'utf8'))
    .join('\n')
  assert.ok(!/Math\.random/.test(src), 'uses Math.random')
})
