import { describe, expect, it } from 'vitest'
import { createAgentBridge } from '../src/agent.js'
import { accept, defineCommand, refuse } from '../src/commands.js'
import { defineComponent } from '../src/component.js'
import { defineEvent } from '../src/events.js'
import { defineResource } from '../src/resource.js'
import { entry } from '../src/types.js'
import type { SystemicFault } from '../src/errors.js'
import { createWorld, type World } from '../src/world.js'

// H-5 / P-1 (Harbor findings): a handler had no way to refuse a command —
// `bridge.act` reported `accepted: true` unless the *caller* passed a
// resolver — so every app wrote a Rejected event, a resolver to turn it back
// into a verdict, and a payload preamble per command. A command is now a
// first-class thing: its handler's verdict is what action() returns.

const Crane = defineComponent<{ serviced: number }>('CmCrane', { defaults: { serviced: 0 } })
const Cash = defineResource<number>('CmCash', { default: 50 })
const Serviced = defineEvent<{ crane: number }>('CmServiced')

const ServiceCrane = defineCommand<{ crane: number }>('CmService', {
  description: 'Send a crane for service: $40.',
  schema: { fields: { crane: { kind: 'entity', required: true, with: ['CmCrane'] } } },
  handle(ctx, { crane }) {
    const cash = ctx.world.getResource(Cash)!
    if (cash < 40) return refuse(`Not enough cash: $40 needed, $${cash} held.`)
    ctx.world.setResource(Cash, cash - 40)
    ctx.world.getComponent(crane, Crane)!.serviced += 1
    ctx.events.emit(Serviced, { crane })
    return accept()
  },
})

function port(): { w: World; a: number; b: number } {
  const w = createWorld({ headless: true })
  w.register(ServiceCrane, Serviced, Cash)
  const a = w.spawn([entry(Crane, { serviced: 0 })])
  const b = w.spawn([entry(Crane, { serviced: 0 })])
  return { w, a, b }
}

describe('commands: the handler decides the verdict (H-5, P-1)', () => {
  it('action() returns what the handler said', () => {
    const { w, a, b } = port()
    const ok = w.action(ServiceCrane, { crane: a })
    expect(ok).toMatchObject({ accepted: true, consumedTurn: true })
    expect(ok.events.map((e) => [e.type.name, e.payload])).toEqual([['CmServiced', { crane: a }]])
    const no = w.action(ServiceCrane, { crane: b })
    expect(no).toEqual({ accepted: false, consumedTurn: false, reason: 'Not enough cash: $40 needed, $10 held.', events: [] })
    expect(w.getComponent(b, Crane)!.serviced).toBe(0)
  })

  it('bridge.act by name says so too — no resolver, no Rejected event', () => {
    const { w, a } = port()
    const bridge = createAgentBridge(w)
    w.setResource(Cash, 0)
    const r = bridge.act('CmService', { crane: a })
    expect(r.accepted).toBe(false)
    expect(r.reason).toMatch(/^Not enough cash/)
  })

  it('a void return is acceptance', () => {
    const Ping = defineCommand<{ n: number }>('CmPing', {
      schema: { fields: { n: { kind: 'number', required: true } } },
      handle: () => {},
    })
    const w = createWorld({ headless: true })
    w.register(Ping)
    expect(w.action(Ping, { n: 1 }).accepted).toBe(true)
  })

  it('answers for its own command when others of the type are handled in the same tick', () => {
    const { w, a, b } = port()
    w.emit(ServiceCrane, { crane: a }) // handled first, and spends the cash
    const r = w.action(ServiceCrane, { crane: b })
    expect(r.accepted).toBe(false)
    expect(w.getComponent(a, Crane)!.serviced).toBe(1)
    expect(w.getComponent(b, Crane)!.serviced).toBe(0)
  })

  it('refuses a command that is not registered in the world, before any tick', () => {
    const w = createWorld({ headless: true })
    const r = w.action(ServiceCrane, { crane: 0 })
    expect(r.accepted).toBe(false)
    expect(r.reason).toMatch(/command "CmService" is not registered in this world: world\.register\(CmService\)/)
    expect(w.time.tick).toBe(0)
  })

  it('a handler that throws refuses that command, raises a fault, and the rest are still handled', () => {
    const Flaky = defineCommand<{ boom: boolean }>('CmFlaky', {
      schema: { fields: { boom: { kind: 'boolean', required: true } } },
      handle(ctx, { boom }) {
        if (boom) throw new Error('kaput')
        ctx.events.emit(Serviced, { crane: -1 })
      },
    })
    const w = createWorld({ headless: true })
    w.register(Flaky, Serviced)
    const faults: SystemicFault[] = []
    w.signals.faultRaised.subscribe((f) => void faults.push(f))
    w.emit(Flaky, { boom: true })
    const r = w.action(Flaky, { boom: false })
    expect(r.accepted).toBe(true)
    expect(faults.map((f) => [f.source, f.entry.kind])).toEqual([['CmFlaky', 'event_handler_threw']])
    expect(w.action(Flaky, { boom: true })).toMatchObject({ accepted: false, reason: 'command "CmFlaky" handler threw: kaput' })
  })

  it('a caller resolve still decides, and sees the handler verdict', () => {
    const { w, a } = port()
    const r = w.action(ServiceCrane, { crane: a }, {
      resolve: ({ verdict }) => ({ accepted: false, reason: `audit: ${String(verdict?.accepted)}` }),
    })
    expect(r).toMatchObject({ accepted: false, reason: 'audit: true' })
  })

  it('register is idempotent: one handler, run before equal systems (the commands band)', () => {
    const { w, a } = port()
    w.register(ServiceCrane)
    const order: string[] = []
    w.system('after', { schedule: 'event', triggers: [ServiceCrane] }, () => void order.push('after'))
    w.action(ServiceCrane, { crane: a })
    expect(w.getComponent(a, Crane)!.serviced).toBe(1)
    const sys = w.describe().systems.filter((s) => s.name.startsWith('command:'))
    expect(sys).toEqual([expect.objectContaining({ name: 'command:CmService', schedule: 'event', priority: -100 })])
    expect(order).toEqual(['after'])
  })

  it('describe() tells commands from notifications', () => {
    const { w } = port()
    const events = w.describe().events
    expect(events.find((e) => e.name === 'CmService')).toMatchObject({ command: true, description: 'Send a crane for service: $40.' })
    expect(events.find((e) => e.name === 'CmServiced')).not.toHaveProperty('command')
  })

  it('a fixed command is handled in the next fixed step; a tick with none leaves it queued', () => {
    const Steer = defineCommand<{ to: number }>('CmSteer', {
      fixed: true,
      schema: { fields: { to: { kind: 'number', required: true } } },
      handle(ctx, { to }) {
        if (to < 0) return refuse('No reverse.')
        ctx.world.setResource(Heading, to + ctx.time.fixedTick / 1000)
      },
    })
    const Heading = defineResource<number>('CmHeading', { default: 0 })
    const w = createWorld({ headless: true, fixedStep: 1 / 16 })
    w.register(Steer, Heading)
    expect(w.action(Steer, { to: 3 }, { dt: 1 / 16 })).toMatchObject({ accepted: true })
    expect(w.getResource(Heading)).toBe(3.001)
    expect(w.action(Steer, { to: -1 }, { dt: 1 / 16 })).toMatchObject({ accepted: false, reason: 'No reverse.' })
    const queued = w.action(Steer, { to: 5 })
    expect(queued.accepted).toBe(false)
    expect(queued.reason).toMatch(/handled in the fixed schedule/)
    w.step(1 / 16)
    expect(w.getResource(Heading)).toBe(5.003)
  })

  it('defineCommand checks its definition', () => {
    expect(() => defineCommand('CmBad', { handle: 3 } as never)).toThrow(TypeError)
    expect(() => defineCommand('CmBad', { handle: () => {}, fixed: 'yes' } as never)).toThrow(TypeError)
    expect(() => defineCommand('CmBad', { handle: () => {}, priority: Number.NaN })).toThrow(TypeError)
    expect(() => refuse('')).toThrow(TypeError)
  })
})

// P-1: replay records each command's verdict, so a refusal that differs on
// replay is caught at the act instead of at the next hash checkpoint.
describe('commands in act logs (P-1)', () => {
  it('records the verdict with the act, and replays to the same verdicts', async () => {
    const { createRecorder, replay } = await import('../src/replay.js')
    const { w, a, b } = port()
    const base = w.snapshot({ pendingEvents: true })
    const rec = createRecorder(w)
    w.action(ServiceCrane, { crane: a })
    w.action(ServiceCrane, { crane: b })
    const log = rec.stop()
    const acts = log.frames.flatMap((f) => f.acts ?? [])
    expect(acts.map((x) => x.verdict)).toEqual([
      { accepted: true },
      { accepted: false, reason: 'Not enough cash: $40 needed, $10 held.' },
    ])
    const fork = port().w
    expect(replay(fork, log, { base }).ok).toBe(true)
  })

  it('a verdict that differs on replay is reported at its act', async () => {
    const { createRecorder, replay } = await import('../src/replay.js')
    const { w, a } = port()
    const base = w.snapshot({ pendingEvents: true })
    const rec = createRecorder(w)
    w.action(ServiceCrane, { crane: a })
    const log = rec.stop()
    // A replay world that is not the recording's setup: a tick system spends the cash first.
    const fork = port().w
    fork.system('drain', {}, () => fork.setResource(Cash, 0))
    const r = replay(fork, log, { base, verify: false })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toEqual({
      kind: 'verdict_mismatch',
      event: 'CmService',
      tick: 0,
      expected: { accepted: true },
      actual: { accepted: false, reason: 'Not enough cash: $40 needed, $0 held.' },
    })
  })
})
