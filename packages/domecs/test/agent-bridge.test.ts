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

// E17.2 (harness spec §6.4; O-89): reset({ scale, input }) — episode-boundary
// hygiene for the host controls the snapshot does not carry.
describe('AgentBridge.reset(options) (E17.2, O-89)', () => {
  const Pos = defineComponent<{ x: number }>('ResetPos', { defaults: { x: 0 } })

  function setup(): { world: World; id: number; boots: { n: number } } {
    const world = createWorld({ headless: true, seed: [5, 6, 7, 8] })
    const boots = { n: 0 }
    world.system('boot', { schedule: 'once' }, () => {
      boots.n++
    })
    // Moves right while ArrowRight is held; the step size follows time.scale.
    world.system('walk', { schedule: 'tick' }, ({ world: w, time }) => {
      if (!w.input.keys.has('ArrowRight')) return
      for (const e of w.listEntities([Pos] as const)) {
        w.getComponent(e, Pos)!.x += time.scale
        w.markChanged(e, Pos)
      }
    })
    const id = world.spawn([entry(Pos, { x: 0 })])
    return { world, id, boots }
  }

  function holdRight(world: World): void {
    const input = world.input
    world.setInput({ ...input, keys: new Set(['ArrowRight']) })
  }

  it('reset({ scale, input: "empty" }) starts every episode from the same host state', () => {
    const { world, id } = setup()
    const bridge = createAgentBridge(world)
    bridge.captureBaseline()

    const episode = (): string => {
      bridge.reset({ scale: 1, input: 'empty' })
      expect(world.time.scale).toBe(1)
      expect(world.input.keys.size).toBe(0)
      bridge.step() // nothing held: no movement
      expect(world.getComponent(id, Pos)?.x).toBe(0)
      holdRight(world)
      bridge.step()
      return hashSnapshot(bridge.snapshot(), { includeChanges: true })
    }

    const first = episode()
    // The first episode ends rescaled with ArrowRight still held …
    world.setScale(3)
    // … the second must not inherit either.
    const second = episode()
    expect(second).toBe(first)
    expect(world.getComponent(id, Pos)?.x).toBe(1)

    // An episode that ends paused resumes at the requested scale.
    world.pause()
    expect(episode()).toBe(first)
  })

  it('reset() with no options keeps scale and input (the 2.0 behaviour)', () => {
    const { world } = setup()
    const bridge = createAgentBridge(world)
    world.setScale(2)
    holdRight(world)
    bridge.reset()
    expect(world.time.scale).toBe(2)
    expect(world.input.keys.has('ArrowRight')).toBe(true)
    bridge.reset({ input: 'keep' })
    expect(world.input.keys.has('ArrowRight')).toBe(true)
  })

  it('reset({ scale: 0 }) pauses; a later scale resumes', () => {
    const { world } = setup()
    const bridge = createAgentBridge(world)
    bridge.reset({ scale: 0 })
    expect(world.time.scale).toBe(0)
    bridge.reset({ scale: 0.5 })
    expect(world.time.scale).toBe(0.5)
  })

  it('rejects a bad scale or input option before restoring anything', () => {
    const { world, id } = setup()
    const bridge = createAgentBridge(world)
    bridge.captureBaseline()
    world.getComponent(id, Pos)!.x = 42
    world.markChanged(id, Pos)
    expect(() => bridge.reset({ scale: -1 })).toThrow(/scale/)
    expect(() => bridge.reset({ scale: Number.NaN })).toThrow(/scale/)
    expect(() => bridge.reset({ input: 'clear' as never })).toThrow(TypeError)
    expect(world.getComponent(id, Pos)?.x).toBe(42)
  })

  it('once systems do not re-run after reset()', () => {
    const { world, boots } = setup()
    const bridge = createAgentBridge(world)
    bridge.step()
    expect(boots.n).toBe(1)
    bridge.captureBaseline()
    bridge.reset({ scale: 1, input: 'empty' })
    bridge.step()
    bridge.reset()
    bridge.step()
    expect(boots.n).toBe(1)
  })
})
