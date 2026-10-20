import { createAgentBridge, createWorld, defineComponent, defineEvent, entry } from '@domecs/core'

export const Counter = defineComponent('Counter', { defaults: { n: 0 } })
export const Add = defineEvent('Add', { schema: { fields: { by: { kind: 'number' } } } })

let counterId = 0

export function createSim() {
  const world = createWorld({ headless: true, seed: [1, 2, 3, 4] })
  counterId = world.spawn([entry(Counter, { n: 0 })])
  world.system('apply-add', { schedule: 'event', triggers: [Add] }, ({ events }) => {
    for (const e of events.of(Add)) {
      world.getComponent(counterId, Counter).n += e.by
      world.markChanged(counterId, Counter)
    }
  })
  const bridge = createAgentBridge(world)
  bridge.captureBaseline()
  return bridge
}

export function count(world) {
  const [id] = world.listEntities([Counter])
  return world.getComponent(id, Counter).n
}
