import { createWorld, defineComponent, entry } from '@domecs/core'

export const Body = defineComponent('Body', { defaults: { x: 0, y: 0, vx: 0, vy: 0 } })

export function createSim(seed) {
  const world = createWorld({ headless: true, seed, fixedStep: 1 / 60 })
  for (let i = 0; i < 10; i++) {
    world.spawn([entry(Body, { x: 0, y: 0, vx: world.rand.uniformRange(0, 10), vy: world.rand.uniformRange(0, 10) })])
  }
  world.system('integrate', { schedule: 'fixed', query: [Body] }, ({ entities, time }) => {
    const dt = time.fixedStep
    for (const e of entities) {
      const b = e.Body
      b.vy += -9.8 * dt
      b.x += b.vx * dt
      b.y += b.vy * dt
      world.markChanged(e.id, Body)
    }
  })
  return world
}

export function advance(world, seconds) {
  const steps = Math.round(seconds * 60)
  for (let i = 0; i < steps; i++) world.step(1 / 60)
}
