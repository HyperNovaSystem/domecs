import { describe, expect, it } from 'vitest'
import {
  createAgentBridge,
  createWorld,
  defineComponent,
  defineEvent,
  entry,
} from '../src/index.js'

const Counter = defineComponent<{ n: number }>('AgentCounter', {
  defaults: { n: 0 },
})
const Inc = defineEvent<{ by: number }>('AgentInc')

describe('createAgentBridge (WS-3)', () => {
  it('observe exposes describe() manifest + time', () => {
    const world = createWorld({ headless: true, seed: [9, 8, 7, 6] })
    world.spawn([entry(Counter, { n: 1 })])
    const bridge = createAgentBridge(world)
    const obs = bridge.observe()
    expect(obs.tick).toBe(world.time.tick)
    expect(obs.scale).toBe(1)
    expect(obs.entityCount).toBe(1)
    expect(obs.manifest.entityCount).toBe(1)
    expect(obs.manifest.components.some((c) => c.name === 'AgentCounter')).toBe(true)
  })

  it('act / step / snapshot form a deterministic episode loop', () => {
    const world = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    world.system('apply-inc', { schedule: 'event', triggers: [Inc] }, ({ events, world: w }) => {
      for (const e of events.of(Inc)) {
        for (const id of w.listEntities([Counter] as const)) {
          const c = w.getComponent(id, Counter)!
          c.n += e.by
          w.markChanged(id, Counter)
        }
      }
    })
    const id = world.spawn([entry(Counter, { n: 0 })])
    const bridge = createAgentBridge(world)
    bridge.captureBaseline()

    const r1 = bridge.act(Inc, { by: 3 })
    expect(r1.accepted).toBe(true)
    expect(world.getComponent(id, Counter)?.n).toBe(3)

    bridge.step()
    const snapA = JSON.stringify(bridge.snapshot())

    bridge.reset()
    expect(world.getComponent(id, Counter)?.n).toBe(0)

    const r2 = bridge.act(Inc, { by: 3 })
    expect(r2.accepted).toBe(true)
    bridge.step()
    const snapB = JSON.stringify(bridge.snapshot())
    expect(snapB).toBe(snapA)
  })

  it('step(dt) advances fixed schedules; stepOnce does not', () => {
    const world = createWorld({ headless: true, fixedStep: 1 / 60 })
    let fixedFires = 0
    world.system('fixed-count', { schedule: 'fixed' }, () => {
      fixedFires++
    })
    const bridge = createAgentBridge(world)
    bridge.step() // stepOnce — fixed does not fire
    expect(fixedFires).toBe(0)
    bridge.step(1 / 60)
    expect(fixedFires).toBe(1)
  })

  it('reset restores a caller-supplied baseline', () => {
    const world = createWorld({ headless: true })
    const id = world.spawn([entry(Counter, { n: 10 })])
    const baseline = world.snapshot()
    world.getComponent(id, Counter)!.n = 99
    world.markChanged(id, Counter)

    const bridge = createAgentBridge(world, { baseline })
    expect(world.getComponent(id, Counter)?.n).toBe(99)
    bridge.reset()
    expect(world.getComponent(id, Counter)?.n).toBe(10)
  })

  it('entity ids assigned after reset() match ids assigned on the live world (O-38)', () => {
    const world = createWorld({ headless: true })
    world.spawn([entry(Counter, { n: 1 })])
    const scratch = world.spawn([entry(Counter, { n: 2 })]) // highest id
    world.despawn(scratch) // despawn the max-id entity BEFORE the baseline
    const bridge = createAgentBridge(world)
    bridge.captureBaseline()

    // Episode 1 runs directly on live state; episode 2 on restored state.
    // The snapshot carries the id cursor, so both assign the same id — the
    // restored world must not recycle the despawned scratch id.
    const liveId = world.spawn([entry(Counter, { n: 3 })])
    bridge.reset()
    const restoredId = world.spawn([entry(Counter, { n: 3 })])
    expect(restoredId).toBe(liveId)
  })

  it('pending follow-up events do not leak across reset() into the next episode', () => {
    // An event system that emits a downstream event: the follow-up is
    // pending (tick-delayed) when the episode ends. reset() + step must NOT
    // deliver the abandoned episode's follow-up into the fresh episode.
    const Echo = defineEvent<{ from: string }>('AgentEcho')
    const world = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    const id = world.spawn([entry(Counter, { n: 0 })])
    world.system('on-inc', { schedule: 'event', triggers: [Inc] }, ({ events, world: w }) => {
      for (const _ of events.of(Inc)) {
        const c = w.getComponent(id, Counter)!
        c.n += 1
        w.markChanged(id, Counter)
        events.emit(Echo, { from: 'inc' })
      }
    })
    let echoes = 0
    world.system('on-echo', { schedule: 'event', triggers: [Echo] }, ({ events }) => {
      for (const _ of events.of(Echo)) echoes++
    })
    const bridge = createAgentBridge(world)
    bridge.captureBaseline()

    bridge.act(Inc, { by: 1 }) // emits Echo, pending for the NEXT tick
    bridge.reset()
    echoes = 0
    bridge.step() // first tick of the next episode
    expect(echoes).toBe(0)
    expect(world.getComponent(id, Counter)?.n).toBe(0)
  })
})
