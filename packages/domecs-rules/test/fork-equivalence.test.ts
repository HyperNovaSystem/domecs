import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  canonicalSnapshot,
  createBranch,
  createRecorder,
  createWorld,
  defineComponent,
  defineEvent,
  defineResource,
  entry,
  hashSnapshot,
  replay,
  runBranch,
  type ActLog,
  type ComponentType,
  type InputSnapshot,
  type World,
  type WorldSnapshot,
} from '@domecs/core'
import { composeTransforms, Parent } from '@domecs/scene'
import { compileWorldExpression, installRules, type InstallRulesOptions, type RuleDef, type RulesHandle } from '../src/index.js'

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

// ── 2.2 (plan E13.1): chase rules, input, acts; recorder and branch legs ──
//
// The 2.1 scenario's guarantees, re-checked with the 2.2 rule language
// (cross-entity selectors, the spatial grid, `atan2`/`hypot`/`pow`,
// aggregates, `??`, input reads) on own streams, and extended to the two
// 2.2 ways of continuing a world: a fresh build replaying the act log a
// recorder took from the live world (§7.1), and a `createBranch` +
// `runBranch` arm over the same log (§7.2). Each must reach the live world's
// strict hash (`pendingEvents` included) on every tick for 150 ticks after
// the edits, while acts (`emit` and `action`) and input keep arriving.

const ChPos = defineComponent<{ x: number; y: number }>('ChPos', { defaults: { x: 0, y: 0 } })
const ChVel = defineComponent<{ x: number; y: number }>('ChVel', { defaults: { x: 0, y: 0 } })
const ChChaser = defineComponent<{ speed: number; heading: number; crowd: number }>('ChChaser', {
  defaults: { speed: 1, heading: 0, crowd: 0 },
})
const ChTarget = defineComponent<{ hops: number }>('ChTarget', { defaults: { hops: 0 } })
const ChScore = defineComponent<{ total: number; lo: number; pings: number; boosts: number }>('ChScore', {
  defaults: { total: 0, lo: 0, pings: 0, boosts: 0 },
})
const ChPing = defineEvent<{ v: number }>('ChPing')
const ChBoost = defineEvent<{ amount: number }>('ChBoost', {
  schema: { fields: { amount: { kind: 'number' } } },
})
const ChClock = defineResource<{ n: number }>('ChClock', { default: () => ({ n: 0 }) })

const CH_TYPES: ComponentType<any>[] = [ChPos, ChVel, ChChaser, ChTarget, ChScore]
const chResolve = (name: string): ComponentType<any> | undefined => CH_TYPES.find((t) => t.name === name)
const CH_OPTIONS: InstallRulesOptions = { order: 'stable', rng: 'own', spatial: { component: 'ChPos', cellSize: 4 } }

const seek: RuleDef = {
  name: 'seek', schedule: 'fixed', query: ['ChChaser', 'ChPos', 'ChVel'],
  actions: [
    { set: 'ChChaser.heading', expr: 'atan2(first(ChTarget).ChPos.y - ChPos.y, first(ChTarget).ChPos.x - ChPos.x) ?? ChChaser.heading' },
    { set: 'ChVel.x', expr: 'ChVel.x * 0.9 + cos(ChChaser.heading) * ChChaser.speed * 0.1' },
    { set: 'ChVel.y', expr: 'ChVel.y * 0.9 + sin(ChChaser.heading) * ChChaser.speed * 0.1' },
  ],
}
// Edited at the third version: the pull weakens with crowding.
const seek2: RuleDef = {
  ...seek,
  actions: [
    seek.actions[0]!,
    { set: 'ChVel.x', expr: 'ChVel.x * 0.9 + cos(ChChaser.heading) * ChChaser.speed * 0.1 / (1 + ChChaser.crowd)' },
    { set: 'ChVel.y', expr: 'ChVel.y * 0.9 + sin(ChChaser.heading) * ChChaser.speed * 0.1 / (1 + ChChaser.crowd)' },
  ],
}
const integrate: RuleDef = {
  name: 'integrate', schedule: 'fixed', query: ['ChPos', 'ChVel'],
  actions: [
    { set: 'ChPos.x', expr: 'ChPos.x + ChVel.x * 0.016' },
    { set: 'ChPos.y', expr: 'ChPos.y + ChVel.y * 0.016' },
  ],
}
const separate: RuleDef = {
  name: 'separate', schedule: 'fixed', query: ['ChChaser', 'ChPos', 'ChVel'],
  actions: [
    { set: 'ChVel.x', expr: 'ChVel.x + (ChPos.x - (nearest(ChChaser, 2).ChPos.x ?? ChPos.x)) * 0.05' },
    { set: 'ChVel.y', expr: 'ChVel.y + (ChPos.y - (nearest(ChChaser, 2).ChPos.y ?? ChPos.y)) * 0.05' },
  ],
}
const crowd: RuleDef = {
  name: 'crowd', schedule: 'tick', query: ['ChChaser', 'ChVel'],
  actions: [{ set: 'ChChaser.crowd', expr: 'countWithin(ChChaser, 3) + hypot(ChVel.x, ChVel.y) * 0.01' }],
}
const jink: RuleDef = {
  name: 'jink', schedule: 'tick', query: ['ChChaser', 'ChVel'], when: 'ChChaser.crowd >= 1',
  actions: [{ set: 'ChVel.y', expr: 'ChVel.y + (random() - 0.5) * 0.4' }],
}
// Input: held arrows move the target, a Space edge makes it hop.
const steer: RuleDef = {
  name: 'steer', schedule: 'tick', query: ['ChTarget', 'ChPos'],
  actions: [
    { set: 'ChPos.x', expr: 'ChPos.x + (key("ArrowRight") ? 0.3 : 0) - (key("ArrowLeft") ? 0.3 : 0)' },
    { set: 'ChTarget.hops', expr: 'ChTarget.hops + (pressed("Space") ? 1 : 0)' },
    { set: 'ChPos.y', expr: 'ChPos.y + (pressed("Space") ? pow(0.5, ChTarget.hops) : 0)' },
  ],
}
const score: RuleDef = {
  name: 'score', schedule: 'tick', query: ['ChScore'],
  actions: [
    { set: 'ChScore.total', expr: 'sum(ChChaser, ChChaser.speed) + count(ChChaser) + (avg(ChChaser, ChChaser.crowd) ?? 0)' },
    { set: 'ChScore.lo', expr: 'minOf(ChChaser, ChPos.x) ?? 0' },
  ],
}

const CH_VERSIONS: RuleDef[][] = [
  [seek, integrate, steer],
  [seek, integrate, steer, separate, crowd, jink],
  [crowd, seek2, integrate, separate, score, steer], // jink removed; its stream stays
  [steer, score, separate, seek2, integrate, crowd, jink], // jink back: resumes rule:jink
]
const CH_FINAL = CH_VERSIONS[CH_VERSIONS.length - 1]!

/** Types, host systems and rules; spawns nothing (a `WorldSetup`, §7.2). */
function chSetup(w: World, defs: RuleDef[]): RulesHandle {
  expect(w.register(ChPing, ChBoost).ok).toBe(true)
  w.system('booster', { schedule: 'fixed', query: [ChChaser] }, (ctx) => {
    for (const b of ctx.events.of(ChBoost)) {
      for (const e of ctx.entities) {
        ctx.world.getComponent(e.id, ChChaser)!.speed += b.amount * 0.1
        ctx.world.markChanged(e.id, ChChaser)
      }
    }
  })
  w.system('spawner', { schedule: 'fixed' }, (ctx) => {
    const clock = ctx.world.getResource(ChClock)!
    clock.n += 1
    ctx.world.setResource(ChClock, clock)
    if (clock.n % 9 !== 0) return
    ctx.world.spawn([
      entry(ChPos, { x: ctx.rand.uniformRange(-6, 6), y: ctx.rand.uniformRange(-6, 6) }),
      entry(ChVel, { x: 0, y: 0 }),
      entry(ChChaser, { speed: 0.5 + ctx.rand.uniform(), heading: 0, crowd: 0 }),
    ])
  })
  w.system('reaper', { query: [ChChaser] }, (ctx) => {
    if (ctx.entities.length > 9) ctx.world.despawn(ctx.entities[0]!.id)
  })
  w.system('pinger', { query: [ChChaser] }, (ctx) => {
    ctx.events.emit(ChPing, { v: ctx.rand.uniform() * ctx.entities.length })
  })
  w.system('counter', { schedule: 'fixed', query: [ChScore] }, (ctx) => {
    for (const e of ctx.entities) {
      const s = ctx.world.getComponent(e.id, ChScore)!
      for (const p of ctx.events.of(ChPing)) s.pings += p.v
      for (const b of ctx.events.of(ChBoost)) s.boosts += b.amount
      ctx.world.markChanged(e.id, ChScore)
    }
  })
  const h = installRules(w, defs, chResolve, CH_OPTIONS)
  expect(w.describe().systems.filter((s) => s.name.startsWith('rule:')).length).toBe(defs.length)
  w.system('drag', { schedule: 'fixed', query: [ChVel] }, (ctx) => {
    for (const e of ctx.entities) {
      const v = ctx.world.getComponent(e.id, ChVel)!
      v.x *= 0.995
      v.y *= 0.995
      ctx.world.markChanged(e.id, ChVel)
    }
  })
  return h
}

function chPopulate(w: World): void {
  w.spawn([entry(ChTarget, { hops: 0 }), entry(ChPos, { x: 0, y: 0 })])
  w.spawn([entry(ChScore, { total: 0, lo: 0, pings: 0, boosts: 0 })])
  for (let i = 0; i < 5; i++) {
    w.spawn([
      entry(ChPos, { x: -8 + i * 1.5, y: i % 2 === 0 ? 3 : -3 }),
      entry(ChVel, { x: 0, y: 0 }),
      entry(ChChaser, { speed: 1 + i * 0.25, heading: 0, crowd: 0 }),
    ])
  }
}

function chInput(t: number): InputSnapshot {
  const phase = Math.floor(t / 7) % 4
  const keys = phase === 1 ? ['ArrowRight'] : phase === 3 ? ['ArrowLeft'] : []
  const pressed = t % 21 === 0 ? ['Space'] : []
  return {
    keys: new Set([...keys, ...pressed]),
    keyDelta: { pressed: new Set(pressed), released: new Set() },
    mods: { ctrl: false, alt: false, shift: false, meta: false },
    pointer: { x: 0, y: 0, buttons: 0, delta: { x: 0, y: 0 }, wheel: 0, entered: [] },
    gamepads: [],
    focus: { activeTag: '', consumesKeys: false },
  }
}

/**
 * One driver step `t` (stimulus, then a step): input changes every 7 steps
 * and a Space edge lasts one step; a `ChBoost` is emitted every 11 steps and
 * sent through `world.action` (which takes its own tick) every 25.
 */
function chDrive(w: World, t: number): void {
  if (t % 7 === 0 || t % 21 === 1) w.setInput(chInput(t))
  if (t % 11 === 0) w.emit(ChBoost, { amount: (t % 3) - 1 })
  if (t % 25 === 0) expect(w.action(ChBoost, { amount: 0.5 }).accepted).toBe(true)
  w.step(DT[t % DT.length]! * w.time.fixedStep)
}

/** The strict hash act logs and branches use (`pendingEvents` included). */
const chHash = (w: World): string => hashSnapshot(w.snapshot({ pendingEvents: true }), { includeChanges: true })

interface ChLive {
  w: World
  h: RulesHandle
  /** Driver steps taken so far. */
  t: number
}

/** Live run: the doc edited at driver steps 10, 20, 30 under stimulus. */
function chLiveRun(): ChLive {
  const w = createWorld({ headless: true, seed: [5, 6, 7, 8] })
  chPopulate(w)
  const h = chSetup(w, CH_VERSIONS[0]!)
  let t = 0
  for (; t < EDIT_TICKS * (CH_VERSIONS.length - 1); t++) {
    chDrive(w, t)
    if ((t + 1) % EDIT_TICKS === 0) expect([...h.update(CH_VERSIONS[(t + 1) / EDIT_TICKS]!).entries()]).toEqual([])
  }
  return { w, h, t }
}

const CH_TICKS = 150

/** Drives `live` CH_TICKS more driver steps; returns its hash after every world tick. */
function chContinue(live: ChLive, also?: World): Map<number, string> {
  const hashes = new Map<number, string>()
  live.w.signals.tickEnd.subscribe(() => void hashes.set(live.w.time.tick, chHash(live.w)))
  for (let i = 0; i < CH_TICKS; i++, live.t++) {
    chDrive(live.w, live.t)
    if (also) chDrive(also, live.t)
  }
  return hashes
}

const finalBuild = (): World => {
  const w = createWorld({ headless: true, seed: [5, 6, 7, 8] })
  chSetup(w, CH_FINAL)
  return w
}

/** Records the post-edit live world for CH_TICKS driver steps. */
function chRecorded(): { base: WorldSnapshot; log: ActLog; live: ChLive; hashes: Map<number, string> } {
  const live = chLiveRun()
  const base = live.w.snapshot({ pendingEvents: true })
  const rec = createRecorder(live.w, { hashEvery: 1 })
  const hashes = chContinue(live)
  return { base, log: rec.stop(), live, hashes }
}

describe('fork equivalence (spec §9, 2.2): chase rules, act logs and branches', () => {
  it('the scenario is not vacuous: spatial, input, acts, own streams, spawns, events in flight', () => {
    const { base, log, live, hashes } = chRecorded()
    expect(base.pendingEvents?.some((p) => p.event === 'ChPing')).toBe(true)
    expect(Object.keys(base.rngStreams ?? {}).sort()).toEqual(
      ['rule:crowd', 'rule:integrate', 'rule:jink', 'rule:score', 'rule:seek', 'rule:separate', 'rule:steer'],
    )
    expect(log.gaps ?? []).toEqual([])
    expect(log.frames.filter((f) => f.dt === null).length).toBe(6) // world.action ticks
    const acts = log.frames.flatMap((f) => f.acts ?? [])
    expect(acts.filter((a) => a.via === 'action').length).toBe(6)
    expect(acts.filter((a) => a.via === 'emit').length).toBeGreaterThan(10)
    expect(log.frames.filter((f) => f.input !== undefined).length).toBeGreaterThan(20)
    expect(hashes.size).toBe(CH_TICKS + 6)
    const snap = live.w.snapshot()
    const chasers = snap.entities.filter((e) => 'ChChaser' in e.components)
    expect(chasers.length).toBeGreaterThan(5) // spawned
    expect(snap.nextId).toBeGreaterThan(snap.entities.length) // and despawned
    expect(chasers.some((e) => (e.components.ChChaser as { crowd: number }).crowd >= 1)).toBe(true) // countWithin
    const target = snap.entities.find((e) => 'ChTarget' in e.components)!
    expect((target.components.ChTarget as { hops: number }).hops).toBeGreaterThan(0) // pressed()
    expect((target.components.ChPos as { x: number }).x).not.toBe(0) // key()
  })

  it('live after edits == fresh build of the final doc restored (pendingEvents), under the same stimulus, 150 steps', () => {
    const live = chLiveRun()
    const fork = finalBuild()
    fork.restore(live.w.snapshot({ pendingEvents: true }))
    expect(chHash(fork)).toBe(chHash(live.w))
    const forkHashes = new Map<number, string>()
    fork.signals.tickEnd.subscribe(() => void forkHashes.set(fork.time.tick, chHash(fork)))
    const liveHashes = chContinue(live, fork)
    expect(forkHashes.size).toBe(liveHashes.size)
    expect([...forkHashes]).toEqual([...liveHashes])
  })

  it('recorder leg: a fresh build replaying the log from its base matches every tick (§7.1)', () => {
    const { base, log, live, hashes } = chRecorded()
    const w = finalBuild()
    const replayed = new Map<number, string>()
    const r = replay(w, log, { base, onFrame: (tick, world) => void replayed.set(tick, chHash(world)) })
    expect(r).toEqual({ ok: true, value: { ticks: CH_TICKS + 6, hash: chHash(live.w) } })
    expect([...replayed]).toEqual([...hashes])
    expect(log.checkpoints?.length).toBe(CH_TICKS + 6) // verified at every tick end
  })

  it('recorder leg survives JSON: the log and base as canonicalJson text replay the same', () => {
    const { base, log, live } = chRecorded()
    const w = finalBuild()
    const r = replay(w, JSON.parse(canonicalJson(log)) as ActLog, { base: JSON.parse(canonicalJson(base)) as WorldSnapshot })
    expect(r).toEqual({ ok: true, value: { ticks: CH_TICKS + 6, hash: chHash(live.w) } })
  })

  it('branch leg: createBranch + runBranch over the log matches every tick, and probes match live (§7.2)', () => {
    const { base, log, live, hashes } = chRecorded()
    const b = createBranch((w) => chSetup(w, CH_FINAL), base, { fixedStep: live.w.time.fixedStep })
    if (!b.ok) throw new Error(JSON.stringify(b.error))
    const near = compileWorldExpression('countWithin(ChChaser, 5, first(ChTarget))', chResolve, CH_OPTIONS)
    const total = compileWorldExpression('sum(ChChaser, ChChaser.speed) + count(ChChaser)', chResolve)
    if (!near.expression || !total.expression) throw new Error('world expressions did not compile')
    const probe = (e: typeof near.expression) => (w: World) => {
      const v = e.evaluate(w)
      if (!v.ok) throw new Error(JSON.stringify(v.error))
      return v.value
    }
    const run = runBranch(b.value.world, {
      steps: log.frames.length, log, hashEvery: 1, sampleEvery: 10,
      probes: { near: probe(near.expression), total: probe(total.expression) },
    })
    if (!run.ok) throw new Error(JSON.stringify(run.error))
    expect(run.value.ticks).toBe(CH_TICKS + 6)
    expect(run.value.faults).toEqual([])
    expect(run.value.finalHash).toBe(chHash(live.w))
    expect(run.value.hashes.map((h) => [h.tick, h.hash])).toEqual([...hashes])
    // The same probes on a second replay of the source, sampled at the same ticks.
    const again = finalBuild()
    const want: Array<{ tick: number; values: Record<string, unknown> }> = []
    const sampleTicks = new Set(run.value.samples.map((s) => s.tick))
    expect(replay(again, log, {
      base,
      onFrame: (tick, w) => {
        if (sampleTicks.has(tick)) want.push({ tick, values: { near: probe(near.expression!)(w), total: probe(total.expression!)(w) } })
      },
    }).ok).toBe(true)
    expect(run.value.samples).toEqual(want)
    expect(new Set(run.value.samples.map((s) => s.values.near)).size).toBeGreaterThan(1)
  })

  it('branch leg: two runBranch calls of half the log equal one call over all of it', () => {
    const { base, log, live } = chRecorded()
    const b = createBranch((w) => chSetup(w, CH_FINAL), base, { fixedStep: live.w.time.fixedStep })
    if (!b.ok) throw new Error(JSON.stringify(b.error))
    const half = Math.floor(log.frames.length / 2)
    expect(runBranch(b.value.world, { steps: half, log }).ok).toBe(true)
    // A second branch from a mid-run keyframe of the first also continues on the live path.
    const mid = b.value.world.snapshot({ pendingEvents: true })
    const rest = runBranch(b.value.world, { steps: log.frames.length - half, log })
    if (!rest.ok) throw new Error(JSON.stringify(rest.error))
    expect(rest.value.finalHash).toBe(chHash(live.w))
    const c = createBranch((w) => chSetup(w, CH_FINAL), mid, { fixedStep: live.w.time.fixedStep })
    if (!c.ok) throw new Error(JSON.stringify(c.error))
    const fromMid = runBranch(c.value.world, { steps: log.frames.length - half, log })
    expect(fromMid.ok && fromMid.value.finalHash).toBe(chHash(live.w))
  })

  it('control: replaying into a build of the first doc version diverges', () => {
    const { base, log } = chRecorded()
    const w = createWorld({ headless: true, seed: [5, 6, 7, 8] })
    chSetup(w, CH_VERSIONS[0]!)
    const r = replay(w, log, { base })
    expect(r.ok ? 'ok' : r.error.kind).toBe('diverged')
  })

  it('control: a log with its input frames stripped diverges (input reaches the rules)', () => {
    const { base, log } = chRecorded()
    const stripped: ActLog = {
      ...log,
      frames: log.frames.map((f, i) => (i === 0 ? f : (({ input: _drop, ...rest }) => rest)(f))),
    }
    const r = replay(finalBuild(), stripped, { base })
    expect(r.ok ? 'ok' : r.error.kind).toBe('diverged')
  })

  it('control: a branch run without the log diverges (the acts reach the world)', () => {
    const { base, log, live } = chRecorded()
    const b = createBranch((w) => chSetup(w, CH_FINAL), base, { fixedStep: live.w.time.fixedStep })
    if (!b.ok) throw new Error(JSON.stringify(b.error))
    const run = runBranch(b.value.world, { steps: log.frames.length })
    expect(run.ok && run.value.finalHash).not.toBe(chHash(live.w))
  })
})
