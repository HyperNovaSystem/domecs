import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Walker, createSim, run } from '../src/sim.mjs'

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

test('same seed, same output; different seed, different output', () => {
  assert.equal(run([3, 1, 4, 1], 50), run([3, 1, 4, 1], 50))
  assert.notEqual(run([3, 1, 4, 1], 50), run([2, 7, 1, 8], 50))
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
    .map((f) => readFileSync(join('src', f), 'utf8'))
    .join('\n')
  assert.ok(!/Math\.random|Date\.now|new Date\(|performance\.now/.test(src))
})
