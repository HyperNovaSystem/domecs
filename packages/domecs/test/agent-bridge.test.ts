import { describe, expect, it } from 'vitest'
import {
  createAgentBridge,
  createWorld,
  defineComponent,
  defineEvent,
  entry,
  hashSnapshot,
  type World,
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

// §4.5 (G10; O-78): name-based act resolves through world.lookupEvent.
describe('AgentBridge.act(name, …)', () => {
  const Hp = defineComponent<{ hp: number }>('ActHp', { defaults: { hp: 10 } })
  const Damage = defineEvent<{ amount: number }>('Damage', {
    schema: { fields: { amount: { kind: 'number' } } },
  })
  const Hurt = defineEvent<{ left: number }>('Hurt')

  function setup(): { world: World; id: number } {
    const world = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    const id = world.spawn([entry(Hp, { hp: 10 })])
    world.register(Damage, Hurt)
    world.system('damage', { schedule: 'event', triggers: [Damage] }, ({ events, world: w }) => {
      for (const d of events.of(Damage)) {
        const c = w.getComponent(id, Hp)!
        c.hp -= d.amount
        w.markChanged(id, Hp)
        events.emit(Hurt, { left: c.hp })
      }
    })
    return { world, id }
  }

  it("act('Damage', …) behaves exactly like act(Damage, …)", () => {
    const a = setup()
    const b = setup()
    const byType = createAgentBridge(a.world).act(Damage, { amount: 3 })
    const byName = createAgentBridge(b.world).act('Damage', { amount: 3 })
    expect(byName).toEqual(byType)
    expect(byName.accepted).toBe(true)
    expect(byName.events.map((e) => e.type)).toEqual([Hurt])
    expect(b.world.getComponent(b.id, Hp)?.hp).toBe(7)
    expect(hashSnapshot(b.world.snapshot(), { includeChanges: true })).toBe(
      hashSnapshot(a.world.snapshot(), { includeChanges: true }),
    )
  })

  it('applies schema rejection (O-39) through the name path', () => {
    const a = setup()
    const b = setup()
    const byType = createAgentBridge(a.world).act(Damage, { amout: 3 } as never)
    const byName = createAgentBridge(b.world).act('Damage', { amout: 3 })
    expect(byName).toEqual(byType)
    expect(byName.accepted).toBe(false)
    expect(byName.reason).toMatch(/unknown field "amout"/)
    expect(b.world.time.tick).toBe(0)
  })

  it('passes ActionOptions through', () => {
    const { world } = setup()
    const r = createAgentBridge(world).act('Damage', { amount: 1 }, { snapshot: true })
    expect(r.snapshot).toBeDefined()
  })

  it('rejects an unknown name with no emit and no tick', () => {
    const { world, id } = setup()
    const bridge = createAgentBridge(world)
    const before = hashSnapshot(world.snapshot(), { includeChanges: true })
    const r = bridge.act('Damag', { amount: 3 })
    expect(r).toEqual({
      accepted: false,
      consumedTurn: false,
      reason: expect.stringMatching(/unknown event "Damag"/),
      events: [],
    })
    expect(world.time.tick).toBe(0)
    expect(hashSnapshot(world.snapshot(), { includeChanges: true })).toBe(before)
    bridge.step()
    expect(world.getComponent(id, Hp)?.hp).toBe(10)
  })

  it('rejects an ambiguous name with no emit and no tick', () => {
    const { world, id } = setup()
    const Twin = defineEvent<{ amount: number }>('Damage')
    world.on(Twin, () => {}) // a second known type named "Damage"
    const bridge = createAgentBridge(world)
    const r = bridge.act('Damage', { amount: 3 })
    expect(r).toEqual({
      accepted: false,
      consumedTurn: false,
      reason: expect.stringMatching(/ambiguous event name "Damage"/),
      events: [],
    })
    expect(world.time.tick).toBe(0)
    bridge.step()
    expect(world.getComponent(id, Hp)?.hp).toBe(10)
  })
})
