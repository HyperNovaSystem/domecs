import { OnChanged, OnRemoved, Or, createWorld, defineComponent, defineResource, entry } from '@domecs/core'

export const Health = defineComponent('Health', { defaults: { hp: 0 } })
export const LowHealth = defineResource('LowHealth', { default: () => [] })

export function createSim() {
  const world = createWorld({ headless: true })
  for (let k = 0; k < 20; k++) world.spawn([entry(Health, { hp: 10 + k })])
  world.setResource(LowHealth, [])
  world.system(
    'low-health-index',
    { schedule: 'reactive', reactsTo: Or(OnChanged(Health), OnRemoved(Health)) },
    () => {
      const low = new Set(world.getResource(LowHealth))
      for (const id of [...low]) if (!world.isAlive(id) || !world.getComponent(id, Health)) low.delete(id)
      for (const id of world.listEntities([Health])) {
        if (world.getComponent(id, Health).hp < 10) low.add(id)
        else low.delete(id)
      }
      world.setResource(LowHealth, [...low].sort((a, b) => a - b))
    },
  )
  return world
}

export function damage(world, id, amount) {
  world.getComponent(id, Health).hp -= amount
  world.markChanged(id, Health)
}

export function heal(world, id, amount) {
  world.getComponent(id, Health).hp += amount
  world.markChanged(id, Health)
}
