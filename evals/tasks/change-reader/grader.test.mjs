import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { Health, LowHealth, createSim, damage, heal } from '../src/sim.mjs'

const expected = (world) =>
  world.listEntities([Health]).filter((id) => world.getComponent(id, Health).hp < 10)

test('starts with 20 healthy entities and an empty index', () => {
  const world = createSim()
  assert.equal(world.listEntities([Health]).length, 20)
  world.step(1 / 60)
  assert.deepEqual(world.getResource(LowHealth), [])
})

test('damage and heal show up after one step', () => {
  const world = createSim()
  const ids = world.listEntities([Health])
  damage(world, ids[0], 1) // 10 -> 9
  damage(world, ids[5], 7) // 15 -> 8
  world.step(1 / 60)
  assert.deepEqual(world.getResource(LowHealth), [ids[0], ids[5]].sort((a, b) => a - b))
  heal(world, ids[0], 5)
  damage(world, ids[19], 20)
  world.step(1 / 60)
  assert.deepEqual(world.getResource(LowHealth), expected(world))
})

test('despawned entities leave the index', () => {
  const world = createSim()
  const ids = world.listEntities([Health])
  damage(world, ids[2], 5)
  world.step(1 / 60)
  world.despawn(ids[2])
  world.step(1 / 60)
  assert.deepEqual(world.getResource(LowHealth), [])
})

test('a random sequence stays exact', () => {
  const world = createSim()
  // mulberry32: an integer-exact generator (an LCG in plain JS doubles loses
  // precision and barely moves).
  let a = 0x2f6b1a3d
  const rnd = (n) => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (((t ^ (t >>> 14)) >>> 0) % n)
  }
  const sizes = new Set()
  for (let round = 0; round < 40; round++) {
    const ids = world.listEntities([Health])
    for (let k = 0; k < 4; k++) {
      const id = ids[rnd(ids.length)]
      if (rnd(3) > 0) damage(world, id, 1 + rnd(12))
      else heal(world, id, 1 + rnd(12))
    }
    if (round % 7 === 6 && ids.length > 5) world.despawn(ids[rnd(ids.length)])
    world.step(1 / 60)
    assert.deepEqual(world.getResource(LowHealth), expected(world), `round ${round}`)
    sizes.add(world.getResource(LowHealth).length)
  }
  assert.ok(sizes.size > 3, 'the sequence should move entities across the threshold')
})

test('the index is maintained by a change-driven system', () => {
  const world = createSim()
  const systems = world.describe().systems
  assert.ok(
    systems.some((s) => s.schedule === 'reactive'),
    `expected a reactive system, saw: ${systems.map((s) => `${s.name}:${s.schedule}`).join(', ')}`,
  )
})
