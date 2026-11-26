import { describe, expect, it } from 'vitest'
import { createWorld, defineComponent, defineEvent, entry, type ComponentType, type World } from '@domecs/core'
import { installRules, type RuleDef } from '../src/index.js'

// H-13 (Harbor findings): a rule had no rate, so a `fixed` standing order
// polled every step; and (H-17) an event rule handled what a fixed rule
// emitted only after the whole fixed phase, so a sim written as rules was
// frame-rate dependent. Rules take `rateHz` / `phase`, and event rules
// `fixed: true`.

const Crane = defineComponent<{ condition: number; busy: number; services: number; polls: number }>('RrCrane', {
  defaults: { condition: 1, busy: 0, services: 0, polls: 0 },
})
const Service = defineEvent<{ crane: number }>('RrService', { schema: { fields: { crane: { kind: 'entity', required: true } } } })
const TYPES: ComponentType<any>[] = [Crane]
const resolve = (name: string): ComponentType<any> | undefined => TYPES.find((t) => t.name === name)

function world(fixedStep = 1 / 16): World {
  const w = createWorld({ headless: true, fixedStep, seed: [1, 1, 2, 3] })
  w.register(Service, Crane)
  return w
}

const poll = (extra: Partial<RuleDef>): RuleDef => ({
  name: 'poll',
  schedule: 'fixed',
  query: ['RrCrane'],
  actions: [{ set: 'RrCrane.polls', expr: 'RrCrane.polls + 1' }],
  ...extra,
})

describe('rule rates (H-13)', () => {
  it('rateHz runs a fixed rule on every d-th step, and phase shifts it', () => {
    for (const [extra, steps, polls] of [
      [{}, 32, 32],
      [{ rateHz: 1 }, 32, 2],
      [{ rateHz: 4, phase: 3 }, 8, 2],
    ] as const) {
      const w = world()
      const errors = installRules(w, [poll(extra)], resolve).update([poll(extra)])
      expect([...errors]).toEqual([])
      const id = w.spawn([entry(Crane, { condition: 1, busy: 0, services: 0, polls: 0 })])
      for (let i = 0; i < steps; i++) w.step(1 / 16)
      expect({ extra, polls: w.getComponent(id, Crane)!.polls }).toEqual({ extra, polls })
    }
  })

  it('a bad rate or phase is a RuleError, never a throw', () => {
    const w = world()
    const cases: Array<[Partial<RuleDef>, string]> = [
      [{ rateHz: 3 }, 'rateHz'], // 16 Hz has no whole divisor for 3 Hz
      [{ rateHz: 0 }, 'rateHz'],
      [{ rateHz: 4, phase: 4 }, 'phase'],
      [{ phase: 1.5 }, 'phase'],
      [{ schedule: 'tick', rateHz: 4 }, 'rateHz'],
      [{ fixed: true }, 'fixed'],
    ]
    for (const [extra, field] of cases) {
      const errors = installRules(w, [], resolve).update([poll(extra)])
      expect({ extra, fields: (errors.get('poll') ?? []).map((e) => e.field) }).toEqual({ extra, fields: [field] })
    }
  })
})

describe('fixed event rules (H-13, H-17)', () => {
  /** A crane that wears, a standing order that asks for service, and the service. */
  function standingOrders(fixedService: boolean): RuleDef[] {
    return [
      { name: 'wear', schedule: 'fixed', query: ['RrCrane'], when: 'RrCrane.busy == 0', actions: [{ set: 'RrCrane.condition', expr: 'RrCrane.condition - 0.05' }] },
      { name: 'cool', schedule: 'fixed', query: ['RrCrane'], when: 'RrCrane.busy > 0', actions: [{ set: 'RrCrane.busy', expr: 'RrCrane.busy - 1' }] },
      {
        name: 'order',
        schedule: 'fixed',
        query: ['RrCrane'],
        when: 'RrCrane.busy == 0 && RrCrane.condition < 0.45',
        actions: [],
        effects: [{ emit: 'RrService', payload: { crane: 'self.id' } }],
      },
      {
        name: 'service',
        schedule: 'event',
        on: 'RrService',
        self: 'event.crane',
        query: ['RrCrane'],
        when: 'RrCrane.busy == 0',
        priority: -100,
        ...(fixedService ? { fixed: true } : {}),
        actions: [
          { set: 'RrCrane.busy', expr: '10' },
          { set: 'RrCrane.condition', expr: '1' },
          { set: 'RrCrane.services', expr: 'RrCrane.services + 1' },
        ],
      },
    ]
  }

  function run(fixedService: boolean, perFrame: number): string {
    const w = world()
    const defs = standingOrders(fixedService)
    expect([...installRules(w, [], resolve).update(defs)]).toEqual([])
    const id = w.spawn([entry(Crane, { condition: 1, busy: 0, services: 0, polls: 0 })])
    const steps = 16 * 20
    for (let done = 0; done < steps; done += perFrame) w.step(Math.min(perFrame, steps - done) / 16)
    return JSON.stringify(w.getComponent(id, Crane))
  }

  it('a sim of rules with a fixed event rule is the same at every frame rate', () => {
    const one = run(true, 1)
    expect(JSON.parse(one).services).toBeGreaterThan(5)
    expect(run(true, 16)).toBe(one)
    expect(run(true, 17)).toBe(one)
  })

  it('without it, the same rules diverge between frame rates (what Harbor hit)', () => {
    expect(run(false, 16)).not.toBe(run(false, 1))
  })

  it('describe() marks the fixed event rule', () => {
    const w = world()
    installRules(w, [], resolve).update(standingOrders(true))
    const sys = w.describe().systems.find((s) => s.name === 'rule:service')
    expect(sys).toMatchObject({ schedule: 'event', fixed: true, priority: -100 })
  })
})
