import { createWorld, defineComponent, entry } from '@domecs/core'

export const Walker = defineComponent('Walker', { defaults: { x: 0, y: 0 } })

export function createSim(seed) {
  const world = createWorld({ headless: true, seed })
  for (let i = 0; i < 100; i++) world.spawn([entry(Walker, { x: 0, y: 0 })])
  world.system('walk', { schedule: 'tick', query: [Walker] }, ({ entities, rand }) => {
    for (const e of entities) {
      e.Walker.x += rand.uniformRange(-1, 1)
      e.Walker.y += rand.uniformRange(-1, 1)
      world.markChanged(e.id, Walker)
    }
  })
  return world
}

export function run(seed, ticks) {
  const world = createSim(seed)
  for (let i = 0; i < ticks; i++) world.step(1 / 60)
  return JSON.stringify(world.snapshot())
}
