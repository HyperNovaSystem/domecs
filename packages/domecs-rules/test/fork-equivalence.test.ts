import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  canonicalSnapshot,
  createWorld,
  defineComponent,
  defineEvent,
  defineResource,
  entry,
  hashSnapshot,
  type ComponentType,
  type World,
  type WorldSnapshot,
} from '@domecs/core'
import { composeTransforms, Parent } from '@domecs/scene'
import { installRules, type RuleDef, type RulesHandle } from '../src/index.js'

// Spec §9 "Fork equivalence" (2.1; plan E8.2): a live world edited mid-run
// and a fresh build of the final doc restored from the live snapshot
// (`pendingEvents: true`) reach equal strict hashes on every tick after.
// Covers tick and fixed rules, composeTransforms at priority 100, own and
// shared streams, spawns and despawns, `-0` values and events in flight.

const Body = defineComponent<{ x: number; vx: number; y: number; vy: number }>('FeBody', {
  defaults: { x: 0, vx: 0, y: 0, vy: 0 },
})
const Pos = defineComponent<{ x: number; y: number }>('FePos', { defaults: { x: 0, y: 0 } })
const WPos = defineComponent<{ x: number; y: number }>('FeWPos', { defaults: { x: 0, y: 0 } })
const Spark = defineComponent<{ life: number; heat: number }>('FeSpark', { defaults: { life: 0, heat: 0 } })
const Tally = defineComponent<{ pings: number; sum: number }>('FeTally', { defaults: { pings: 0, sum: 0 } })
const Ping = defineEvent<{ at: number; v: number }>('FePing')
const Clock = defineResource<{ n: number }>('FeClock', { default: () => ({ n: 0 }) })

const TYPES: ComponentType<any>[] = [Body, Pos, Spark, Tally]
const resolve = (name: string): ComponentType<any> | undefined => TYPES.find((t) => t.name === name)

// ── The doc: four versions of the rule set, edited at ticks 10, 20, 30 ──

const move: RuleDef = {
  name: 'move', schedule: 'fixed', query: ['FeBody'],
  actions: [
    { set: 'FeBody.x', expr: 'FeBody.x + FeBody.vx * 0.016' },
    { set: 'FeBody.y', expr: 'FeBody.y + FeBody.vy * 0.016' },
  ],
}
// Resting bodies against the wall: vx 0 becomes -0 and stays there.
const bounce: RuleDef = {
  name: 'bounce', schedule: 'fixed', query: ['FeBody'], when: 'FeBody.x >= 10',
  actions: [{ set: 'FeBody.vx', expr: '-abs(FeBody.vx) * 0.5' }],
}
const gravity: RuleDef = {
  name: 'gravity', schedule: 'fixed', query: ['FeBody'],
  actions: [{ set: 'FeBody.vy', expr: 'FeBody.y > 0 ? FeBody.vy - 0.3 : abs(FeBody.vy) * 0.5' }],
}
const wobble: RuleDef = {
  name: 'wobble', schedule: 'tick', query: ['FeBody', 'FePos'],
  actions: [
    { set: 'FePos.x', expr: 'FeBody.x + sin(FeBody.y * 3.7) * 0.25' },
    { set: 'FePos.y', expr: 'FeBody.y + cos(FeBody.x * 1000) * 0.25' },
  ],
}
const jitter: RuleDef = {
  name: 'jitter', schedule: 'tick', query: ['FeBody'], when: 'FeBody.x < 10',
  actions: [{ set: 'FeBody.vx', expr: 'FeBody.vx + random() - 0.5' }],
}
const cool: RuleDef = {
  name: 'cool', schedule: 'tick', query: ['FeSpark'],
  actions: [
    { set: 'FeSpark.life', expr: 'FeSpark.life - 1' },
    { set: 'FeSpark.heat', expr: 'FeSpark.heat * 0.9 + random()' },
  ],
}
// A shared-stream rule: its draws interleave with the host's shared draws.
const flicker: RuleDef = {
  name: 'flicker', schedule: 'fixed', rng: 'shared', query: ['FeSpark'],
  actions: [{ set: 'FeSpark.heat', expr: 'FeSpark.heat + random() * 0.1' }],
}
const wobble2: RuleDef = { ...wobble, actions: [{ set: 'FePos.x', expr: 'FeBody.x - sin(FeBody.vx) * 0.5' }] }

const VERSIONS: RuleDef[][] = [
  [move, bounce, wobble, jitter],
  [move, bounce, gravity, wobble, jitter, cool],
  [cool, move, gravity, bounce, wobble2, flicker], // jitter removed; its stream stays
  [gravity, move, bounce, wobble2, flicker, cool, jitter], // jitter back: resumes rule:jitter
]
const EDIT_TICKS = 10

/** dt sequence (multiples of fixedStep) so fixed backlog is non-zero at times. */
const DT = [1, 1.5, 0.5, 1, 2, 0.25]

interface Built {
  w: World
  h: RulesHandle
}

function build(defs: RuleDef[], order: 'stable' | 'registration' = 'stable'): Built {
  const w = createWorld({ headless: true, seed: [11, 22, 33, 44] })
  expect(w.register(Ping).ok).toBe(true)
  const composed = w.use(composeTransforms(Pos, WPos, (parent, local) => (parent ? { x: parent.x + local.x, y: parent.y + local.y } : { ...local }), { priority: 100 }))
  expect(composed.ok).toBe(true)
  for (let i = 0; i < 6; i++) {
    // Bodies 0 and 1 rest against the wall (vx 0 → -0 on the first bounce).
    w.spawn([
      entry(Body, { x: i < 2 ? 10 : i, vx: i < 2 ? 0 : 0.5 - i * 0.1, y: i * 0.5, vy: 0 }),
      entry(Pos, { x: 0, y: 0 }),
    ])
  }
  const tally = w.spawn([entry(Tally, { pings: 0, sum: 0 })])
  // Host systems, registered before the rules in both worlds.
  w.system('spawner', { schedule: 'fixed', query: [Body] }, (ctx) => {
    const clock = ctx.world.getResource(Clock)!
    clock.n += 1
    ctx.world.setResource(Clock, clock)
    if (clock.n % 7 !== 0) return
    const parent = ctx.rand.pick(ctx.entities)
    ctx.world.spawn([
      entry(Spark, { life: 5 + ctx.rand.uniformInt(20), heat: 1 }),
      entry(Pos, { x: ctx.rand.uniformRange(-1, 1), y: 0 }),
      entry(Parent, { entity: parent.id }),
    ])
  })
  w.system('reaper', { query: [Spark] }, (ctx) => {
    for (const e of ctx.entities) if (ctx.world.getComponent(e.id, Spark)!.life <= 0) ctx.world.despawn(e.id)
  })
  w.system('pinger', { query: [Body] }, (ctx) => {
    ctx.events.emit(Ping, { at: ctx.entities.length, v: ctx.rand.uniform() })
  })
  w.system('counter', { schedule: 'fixed' }, (ctx) => {
    const t = ctx.world.getComponent(tally, Tally)!
    for (const p of ctx.events.of(Ping)) {
      t.pings += 1
      t.sum += p.v * p.at
    }
    ctx.world.markChanged(tally, Tally)
  })
  const h = installRules(w, defs, resolve, { order, rng: 'own' })
  // Every def compiled (installRules reports errors only through update()).
  expect(w.describe().systems.filter((s) => s.name.startsWith('rule:')).length).toBe(defs.length)
  // A user system in the rule band registered after the rules: 'stable'
  // keeps it before them across update(); 'registration' does not.
  w.system('drag', { schedule: 'fixed', query: [Body] }, (ctx) => {
    for (const e of ctx.entities) {
      const b = ctx.world.getComponent(e.id, Body)!
      b.vx = b.vx * 0.99
      ctx.world.markChanged(e.id, Body)
    }
  })
  return { w, h }
}

const strict = (w: World): string => hashSnapshot(w.snapshot(), { includeChanges: true })

/** Live run: edits at ticks 10, 20, 30, then `extra` more steps. */
function liveRun(extra = 0, order: 'stable' | 'registration' = 'stable'): Built {
  const live = build(VERSIONS[0]!, order)
  const fixed = live.w.time.fixedStep
  let t = 0
  for (; t < EDIT_TICKS * (VERSIONS.length - 1); t++) {
    live.w.step(DT[t % DT.length]! * fixed)
    if ((t + 1) % EDIT_TICKS === 0) {
      const errors = live.h.update(VERSIONS[(t + 1) / EDIT_TICKS]!)
      expect([...errors.entries()]).toEqual([])
    }
  }
  for (let i = 0; i < extra; i++, t++) live.w.step(DT[t % DT.length]! * fixed)
  return live
}

/** Steps live and fork in lockstep; returns the first tick whose strict hashes differ, or -1. */
function firstDivergentTick(live: Built, fork: Built, ticks: number, start: number): number {
  const fixed = live.w.time.fixedStep
  for (let i = 0; i < ticks; i++) {
    const dt = DT[(start + i) % DT.length]! * fixed
    live.w.step(dt)
    fork.w.step(dt)
    if (strict(fork.w) !== strict(live.w)) return i
  }
  return -1
}

const EDITED = EDIT_TICKS * (VERSIONS.length - 1)

describe('fork equivalence (spec §9, 2.1)', () => {
  it('the scenario is not vacuous at the fork point', () => {
    const live = liveRun(3)
    const snap = live.w.snapshot({ pendingEvents: true })
    expect(snap.version).toBe(3)
    expect(snap.pendingEvents?.some((p) => p.event === 'FePing')).toBe(true) // events in flight
    const steps = snap.scaledTime! / live.w.time.fixedStep
    expect(steps - Math.floor(steps)).toBeGreaterThan(0.1) // a partial fixed step accumulated
    expect(Object.keys(snap.rngStreams ?? {}).sort()).toEqual(
      ['rule:bounce', 'rule:cool', 'rule:gravity', 'rule:jitter', 'rule:move', 'rule:wobble'],
    )
    expect(snap.entities.some((e) => 'FeSpark' in e.components)).toBe(true) // spawned
    expect(snap.nextId).toBeGreaterThan(snap.entities.length) // and some despawned
    expect(canonicalSnapshot(snap)).toContain('"vx":-0') // -0 survives
    expect(snap.entities.some((e) => 'FeWPos' in e.components)).toBe(true) // compose ran
    const tally = snap.entities.find((e) => 'FeTally' in e.components)!.components.FeTally as { pings: number }
    expect(tally.pings).toBeGreaterThan(0)
  })

  for (const extra of [0, 3, 7]) {
    it(`live after edits == fresh build of the final doc restored (pendingEvents), 150 ticks, fork at +${extra}`, () => {
      const live = liveRun(extra)
      const fork = build(VERSIONS[VERSIONS.length - 1]!)
      fork.w.restore(live.w.snapshot({ pendingEvents: true }))
      expect(strict(fork.w)).toBe(strict(live.w))
      expect(firstDivergentTick(live, fork, 150, EDITED + extra)).toBe(-1)
    })
  }

  it('a fork from canonicalJson text (studio keyframes) also matches: -0 survives the round trip', () => {
    const live = liveRun(3)
    const text = canonicalJson(live.w.snapshot({ pendingEvents: true }))
    const fork = build(VERSIONS[VERSIONS.length - 1]!)
    fork.w.restore(JSON.parse(text) as WorldSnapshot)
    expect(strict(fork.w)).toBe(strict(live.w))
    expect(firstDivergentTick(live, fork, 120, EDITED + 3)).toBe(-1)
  })

  it('control: without pendingEvents the fork drops the in-flight Ping and diverges', () => {
    const live = liveRun(3)
    const fork = build(VERSIONS[VERSIONS.length - 1]!)
    fork.w.restore(live.w.snapshot())
    expect(firstDivergentTick(live, fork, 120, EDITED + 3)).not.toBe(-1)
  })

  it('control: a JSON.stringify round trip (writes -0 as 0) diverges', () => {
    const live = liveRun(3)
    const fork = build(VERSIONS[VERSIONS.length - 1]!)
    fork.w.restore(JSON.parse(JSON.stringify(live.w.snapshot({ pendingEvents: true }))) as WorldSnapshot)
    expect(strict(fork.w)).not.toBe(strict(live.w))
  })

  it("control: the same edits under order 'registration' diverge (§4.3)", () => {
    const live = liveRun(3, 'registration')
    const fork = build(VERSIONS[VERSIONS.length - 1]!, 'registration')
    fork.w.restore(live.w.snapshot({ pendingEvents: true }))
    expect(firstDivergentTick(live, fork, 120, EDITED + 3)).not.toBe(-1)
  })

  it('control: a snapshot stripped of rngStreams diverges (own streams travel in the snapshot)', () => {
    const live = liveRun(3)
    const { rngStreams: _drop, ...rest } = live.w.snapshot({ pendingEvents: true })
    const fork = build(VERSIONS[VERSIONS.length - 1]!)
    fork.w.restore(rest as WorldSnapshot)
    expect(firstDivergentTick(live, fork, 120, EDITED + 3)).not.toBe(-1)
  })

  it("the suite runs own-stream rules plus one 'shared' rule", () => {
    const live = liveRun(0)
    const keys = live.w.describe().systems.filter((s) => s.name.startsWith('rule:')).map((s) => [s.name, s.rng])
    expect(keys.filter(([, rng]) => rng === 'own').length).toBe(VERSIONS[VERSIONS.length - 1]!.length - 1)
    expect(keys.find(([name]) => name === 'rule:flicker')?.[1]).toBe('shared')
  })
})
