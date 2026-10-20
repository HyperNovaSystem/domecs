import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { Add, Counter, count, createSim } from '../src/sim.mjs'

test('exports the contract', () => {
  assert.equal(typeof createSim, 'function')
  assert.equal(typeof count, 'function')
  assert.ok(Add && typeof Add.name === 'string')
  assert.ok(Counter && typeof Counter.name === 'string')
})

test('exactly one entity holds Counter, and count() reads it', () => {
  const bridge = createSim()
  const ids = bridge.world.listEntities([Counter])
  assert.equal(ids.length, 1)
  bridge.act(Add, { by: 4 })
  assert.equal(bridge.world.getComponent(ids[0], Counter).n, 4)
  assert.equal(count(bridge.world), 4)
})

test('one act applies the command and advances exactly one tick', () => {
  const bridge = createSim()
  const t0 = bridge.world.time.tick
  const r = bridge.act(Add, { by: 3 })
  assert.equal(r.accepted, true)
  assert.equal(count(bridge.world), 3)
  assert.equal(bridge.world.time.tick, t0 + 1)
  bridge.act(Add, { by: -1 })
  assert.equal(count(bridge.world), 2)
})

test('the command boundary rejects malformed payloads without ticking', () => {
  const bridge = createSim()
  const t0 = bridge.world.time.tick
  assert.equal(bridge.act(Add, { by: 'x' }).accepted, false)
  assert.equal(bridge.act(Add, { by: 1, extra: true }).accepted, false)
  assert.equal(bridge.world.time.tick, t0)
  assert.equal(count(bridge.world), 0)
})

test('reset restores the starting state', () => {
  const bridge = createSim()
  bridge.act(Add, { by: 5 })
  bridge.reset()
  assert.equal(count(bridge.world), 0)
  bridge.act(Add, { by: 2 })
  assert.equal(count(bridge.world), 2)
})

test('episodes are deterministic', () => {
  const run = () => {
    const b = createSim()
    for (const by of [1, 2, 3]) b.act(Add, { by })
    return JSON.stringify(b.snapshot())
  }
  assert.equal(run(), run())
})
