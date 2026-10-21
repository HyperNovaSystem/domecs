import { describe, expect, it } from 'vitest'
import {
  Faulted,
  createWorld,
  defineComponent,
  defineEvent,
  entry,
  hashSnapshot,
  type ComponentBag,
  type ComponentType,
  type World,
} from '@domecs/core'
import { compileRule, installRules, type InstallRulesOptions, type RuleDef, type RuleError } from '../src/index.js'

// Spec §6.1 (G8, O-84), plan E14.2: deferred rule effects — emit, spawn,
// despawn, add, remove — applied at the end of the rule's run.

const Pos = defineComponent<{ x: number; y: number }>('FxPos', { defaults: { x: 0, y: 0 } })
const Hp = defineComponent<{ hp: number }>('FxHp', { defaults: { hp: 3 } })
const Tag = defineComponent<{ n: number }>('FxTag', { defaults: { n: 0 } })
const Bullet = defineComponent<{ vx: number; path: number[] }>('FxBullet', { defaults: { vx: 0, path: [] } })
const Gun = defineComponent<{ t: number; kills: number }>('FxGun', { defaults: { t: 0, kills: 0 } })
const Loose = defineComponent<{ v?: number }>('FxLoose')

const Ping = defineEvent<{ n?: number }>('FxPing') // schema-less
const Died = defineEvent<{ who: number }>('FxDied', { schema: { fields: { who: { kind: 'number' } } } })
const Seen = defineEvent<{ v: number }>('FxSeen', { schema: { fields: { v: { kind: 'number' } } } })
const Fire = defineEvent<{ from: number; speed: number }>('FxFire', {
  schema: { fields: { from: { kind: 'number' }, speed: { kind: 'number' } } },
})
const Hit = defineEvent<{ a: number; b: number }>('FxHit', { schema: { fields: { a: { kind: 'number' }, b: { kind: 'number' } } } })

const TYPES: ComponentType<any>[] = [Pos, Hp, Tag, Bullet, Gun, Loose]
const resolve = (name: string): ComponentType<any> | undefined => TYPES.find((t) => t.name === name)

// One shared bag on purpose: spawn must clone it (spawn shallow-copies, O-34).
const BULLET: ComponentBag = [entry(Pos, { x: 0, y: 0 }), entry(Bullet, { vx: 1, path: [1, 2] })]
const prefabs = (name: string): ComponentBag | undefined => (name === 'bullet' ? BULLET : undefined)
const OPTIONS: InstallRulesOptions = { prefabs, spatial: { component: 'FxPos' } }

function world(): World {
  const w = createWorld({ headless: true, seed: [9, 8, 7, 6] })
  expect(w.register(Ping, Died, Seen, Fire, Hit).ok).toBe(true)
  return w
}

function install(w: World, defs: RuleDef[], options: InstallRulesOptions = OPTIONS): void {
  const errors = installRules(w, [], resolve, options).update(defs)
  expect([...errors]).toEqual([])
}

const strict = (w: World): string => hashSnapshot(w.snapshot({ pendingEvents: true }), { includeChanges: true })

function systemic(w: World): string[] {
  const seen: string[] = []
  w.signals.faultRaised.subscribe((f) => seen.push(`${f.source}: ${String((f.entry.detail as { message?: unknown })?.message)}`))
  return seen
}

function faultsOf(w: World, id: number): string[] {
  return (w.getComponent(id, Faulted)?.faults ?? []).map((f) => `${f.source}: ${String((f.detail as { message?: unknown })?.message)}`)
}

describe('E14.2 emit', () => {
  // World-scope relay: each ping emits the next until n reaches 3.
  const RELAY: RuleDef[] = [
    {
      name: 'relay',
      schedule: 'event',
      on: 'FxPing',
      query: [],
      when: 'event.n < 3',
      actions: [],
      effects: [{ emit: 'FxPing', payload: { n: 'event.n + 1' } }],
    },
    { name: 'mark', schedule: 'event', on: 'FxPing', query: ['FxTag'], actions: [{ set: 'FxTag.n', expr: 'event.n' }] },
  ]

  it('test 3: an emit arrives next tick and triggers a chained event rule then', () => {
    const w = world()
    install(w, RELAY)
    const tag = w.spawn([entry(Tag, { n: -1 })])
    w.emit(Ping, { n: 0 })
    const seen: number[] = []
    for (let i = 0; i < 6; i++) {
      w.stepOnce()
      seen.push(w.getComponent(tag, Tag)!.n)
      if (i === 0) expect(w.pendingEvents()).toEqual([{ type: Ping, payload: { n: 1 } }])
    }
    expect(seen).toEqual([0, 1, 2, 3, 3, 3])
    expect(w.pendingEvents()).toEqual([])
  })

  it('test 3: a fork snapshotted between the emit and its delivery delivers it (equal strict hashes)', () => {
    const live = world()
    install(live, RELAY)
    live.spawn([entry(Tag, { n: -1 })])
    live.emit(Ping, { n: 0 })
    live.stepOnce() // relay emitted n: 1, pending
    expect(live.pendingEvents()).toHaveLength(1)
    const fork = world()
    install(fork, RELAY)
    fork.restore(live.snapshot({ pendingEvents: true }))
    expect(strict(fork)).toBe(strict(live))
    for (let i = 0; i < 4; i++) {
      live.stepOnce()
      fork.stepOnce()
      expect(strict(fork), `tick ${i}`).toBe(strict(live))
    }
    const tag = fork.listEntities([Tag])[0]!
    expect(fork.getComponent(tag, Tag)!.n).toBe(3)
  })

  it('test 3: a schema-invalid emit is a rule_eval_failed fault on the queuing entity (systemic in world scope)', () => {
    const w = world()
    const faults = systemic(w)
    install(w, [
      {
        name: 'bad',
        schedule: 'tick',
        query: ['FxHp'],
        actions: [{ set: 'FxHp.hp', expr: 'FxHp.hp - 1' }],
        effects: [{ emit: 'FxDied', payload: { who: '"nobody"' } }, { emit: 'FxPing', payload: { n: 'FxHp.hp' } }],
      },
      { name: 'bad-world', schedule: 'event', on: 'FxPing', query: [], actions: [], effects: [{ emit: 'FxSeen', payload: { v: '"x"' } }] },
    ])
    const id = w.spawn([entry(Hp, { hp: 5 })])
    w.stepOnce()
    // The action committed; the invalid emit was dropped, the valid one sent.
    expect(w.getComponent(id, Hp)!.hp).toBe(4)
    expect(faultsOf(w, id)).toEqual([expect.stringMatching(/^rule:bad: .*FxDied.*field "who" must be a number, got string/)])
    expect(w.pendingEvents()).toEqual([{ type: Ping, payload: { n: 4 } }])
    w.stepOnce()
    expect(faults).toEqual([expect.stringMatching(/^rule:bad-world: .*FxSeen.*field "v" must be a number/)])
  })

  it('an apply-time failure after the queuing entity despawned itself is a systemic fault, never dropped', () => {
    // `despawn: self` then an emit is the common "die and announce" shape;
    // core drops entity faults on a dead entity, so the fault must not be
    // attached to the (now dead) queuing entity.
    const w = world()
    const faults = systemic(w)
    install(w, [
      {
        name: 'die',
        schedule: 'tick',
        query: ['FxHp'],
        actions: [],
        effects: [{ despawn: 'self' }, { emit: 'FxDied', payload: { who: '"nobody"' } }, { spawn: 'bullet', set: { 'FxBullet.vx': '"fast"' } }],
      },
    ])
    const a = w.spawn([entry(Hp, { hp: 1 })])
    w.stepOnce()
    expect(w.isAlive(a)).toBe(false)
    expect(w.pendingEvents()).toEqual([])
    expect(faults).toEqual([
      expect.stringMatching(new RegExp(`^rule:die: entity ${a} \\(despawned\\): emit "FxDied".*field "who" must be a number`)),
      expect.stringMatching(new RegExp(`^rule:die: entity ${a} \\(despawned\\): spawn "bullet".*FxBullet\\.vx`)),
    ])
  })

  it('emit payload fields are built in def order from values at queue time; no payload is {}', () => {
    const w = world()
    install(w, [
      {
        name: 'r',
        schedule: 'tick',
        query: ['FxHp'],
        actions: [{ set: 'FxHp.hp', expr: 'FxHp.hp * 2' }],
        effects: [{ emit: 'FxPing', payload: { n: 'FxHp.hp' } }, { emit: 'FxPing' }],
      },
    ])
    w.spawn([entry(Hp, { hp: 5 })])
    w.stepOnce()
    // Effects see the entity's own staged writes, like later actions do.
    expect(w.pendingEvents().map((e) => e.payload)).toEqual([{ n: 10 }, {}])
  })
})

describe('E14.2 spawn', () => {
  const SHOOT: RuleDef = {
    name: 'shoot',
    schedule: 'event',
    on: 'FxFire',
    self: 'event.from',
    query: ['FxPos'],
    actions: [],
    effects: [
      {
        spawn: 'bullet',
        at: { x: 'FxPos.x + 1', y: 'FxPos.y' },
        set: { 'FxBullet.vx': 'event.speed', 'FxTag.n': 'self.id' },
      },
    ],
  }

  function run(): { w: World; shooter: number; bullets: number[] } {
    const w = world()
    install(w, [SHOOT])
    const shooter = w.spawn([entry(Pos, { x: 10, y: 20 })])
    w.action(Fire, { from: shooter, speed: 4 })
    w.emit(Fire, { from: shooter, speed: 5 })
    w.emit(Fire, { from: shooter, speed: 6 })
    w.stepOnce()
    return { w, shooter, bullets: w.listEntities([Bullet]) }
  }

  it('test 4: deterministic ids, at and set applied, components outside the prefab added with defaults', () => {
    const a = run()
    const b = run()
    expect(a.bullets).toEqual([a.shooter + 1, a.shooter + 2, a.shooter + 3])
    expect(b.bullets).toEqual(a.bullets)
    expect(strict(b.w)).toBe(strict(a.w))
    expect(a.bullets.map((id) => a.w.getComponent(id, Pos))).toEqual([
      { x: 11, y: 20 },
      { x: 11, y: 20 },
      { x: 11, y: 20 },
    ])
    expect(a.bullets.map((id) => a.w.getComponent(id, Bullet)!.vx)).toEqual([4, 5, 6])
    expect(a.bullets.map((id) => a.w.getComponent(id, Tag))).toEqual([{ n: a.shooter }, { n: a.shooter }, { n: a.shooter }])
  })

  it('test 4: the prefab bag is not shared between spawns', () => {
    const { w, bullets } = run()
    w.getComponent(bullets[0]!, Bullet)!.path.push(99)
    expect(w.getComponent(bullets[1]!, Bullet)!.path).toEqual([1, 2])
    expect((BULLET as ReadonlyArray<readonly [unknown, { path: number[] }]>)[1]![1].path).toEqual([1, 2])
    expect(w.getComponent(bullets[0]!, Pos)).not.toBe(w.getComponent(bullets[1]!, Pos))
  })

  it('prefabs is called per spawn; a set the component cannot take faults the spawner and spawns nothing', () => {
    let calls = 0
    const w = world()
    install(w, [{ ...SHOOT, effects: [{ spawn: 'bullet', set: { 'FxBullet.nope': '1' } }, { spawn: 'bullet', set: { 'FxBullet.vx': '"fast"' } }] }], {
      ...OPTIONS,
      prefabs: (name) => {
        calls++
        return prefabs(name)
      },
    })
    expect(calls).toBe(2) // each spawn effect checked at compile time
    const shooter = w.spawn([entry(Pos, { x: 0, y: 0 })])
    w.action(Fire, { from: shooter, speed: 1 })
    expect(calls).toBe(4)
    expect(w.listEntities([Bullet])).toEqual([])
    expect(faultsOf(w, shooter)).toEqual([
      expect.stringMatching(/spawn "bullet".*FxBullet\.nope.*no such field/),
      expect.stringMatching(/spawn "bullet".*FxBullet\.vx.*expected a number, got string/),
    ])
  })

  it('a prefabs callback that throws is a compile error at install and a fault at apply time', () => {
    const throwing = (): ComponentBag | undefined => {
      throw new Error('catalog offline')
    }
    expect([...installRules(world(), [], resolve, { ...OPTIONS, prefabs: throwing }).update([{ ...SHOOT, effects: [{ spawn: 'bullet' }] }])]).toEqual([
      ['shoot', [expect.objectContaining({ message: expect.stringMatching(/prefab "bullet".*catalog offline/) })]],
    ])
    let applyTime = false
    const w = world()
    install(w, [{ ...SHOOT, effects: [{ spawn: 'bullet' }, { emit: 'FxPing', payload: { n: '9' } }] }], {
      ...OPTIONS,
      prefabs: (name) => (applyTime ? throwing() : prefabs(name)),
    })
    const shooter = w.spawn([entry(Pos, { x: 0, y: 0 })])
    const before = w.listEntities([]).length
    const pings: number[] = []
    w.on(Ping, (p) => pings.push(p.n ?? -1))
    applyTime = true
    w.action(Fire, { from: shooter, speed: 1 })
    w.stepOnce()
    expect(w.listEntities([]).length).toBe(before)
    expect(faultsOf(w, shooter)).toEqual([expect.stringMatching(/spawn "bullet".*catalog offline/)])
    expect(pings).toEqual([9]) // the later effect still applied
  })

  it('a prefab with a conflicting component type faults the spawner and spawns nothing', () => {
    const Impostor = defineComponent<{ x: number; y: number }>('FxPos', { defaults: { x: 0, y: 0 } })
    let applyTime = false
    const w = world()
    install(w, [{ ...SHOOT, effects: [{ spawn: 'bullet' }] }], {
      ...OPTIONS,
      prefabs: (name) => (applyTime ? [entry(Bullet, { vx: 1, path: [] }), entry(Impostor, { x: 0, y: 0 })] : prefabs(name)),
    })
    const shooter = w.spawn([entry(Pos, { x: 0, y: 0 })])
    const before = w.listEntities([]).length
    applyTime = true
    w.action(Fire, { from: shooter, speed: 1 })
    expect(w.listEntities([]).length).toBe(before)
    expect(faultsOf(w, shooter)).toEqual([expect.stringMatching(/spawn "bullet".*another component type.*"FxPos"/)])
    w.stepOnce() // the world still steps
  })
})

describe('E14.2 despawn, add, remove', () => {
  it('test 5: a despawn is deferred: later entities in the run read the entity alive', () => {
    const w = world()
    install(w, [
      {
        name: 'r',
        schedule: 'tick',
        query: ['FxHp'],
        actions: [],
        effects: [{ emit: 'FxSeen', payload: { v: 'entity(FxTag.n).FxHp.hp ?? -1' } }, { despawn: 'self' }],
      },
    ])
    const a = w.spawn([entry(Hp, { hp: 7 })])
    w.addComponent(a, Tag, { n: a })
    const b = w.spawn([entry(Hp, { hp: 1 }), entry(Tag, { n: a })])
    w.stepOnce()
    expect(w.isAlive(a)).toBe(false)
    expect(w.isAlive(b)).toBe(false)
    expect(w.pendingEvents().map((e) => e.payload)).toEqual([{ v: 7 }, { v: 7 }])
  })

  it('despawn is idempotent; later effects on a despawned entity are skipped', () => {
    const w = world()
    install(w, [
      {
        name: 'r',
        schedule: 'tick',
        query: ['FxHp'],
        actions: [],
        effects: [{ despawn: 'self' }, { despawn: 'self' }, { add: 'FxTag', set: { n: '1' } }, { remove: 'FxHp' }],
      },
    ])
    const a = w.spawn([entry(Hp, { hp: 7 })])
    expect(() => w.stepOnce()).not.toThrow()
    expect(w.isAlive(a)).toBe(false)
  })

  it('add uses defaults plus set; adding an existing component applies only set; remove of an absent one is a no-op', () => {
    const w = world()
    install(w, [
      {
        name: 'r',
        schedule: 'tick',
        query: ['FxHp'],
        actions: [{ set: 'FxHp.hp', expr: 'FxHp.hp + 1' }],
        effects: [
          { add: 'FxPos', set: { x: 'FxHp.hp' } },
          { add: 'FxTag', to: 'self', set: { 'FxTag.n': 'FxHp.hp * 10' } },
          { remove: 'FxLoose', from: 'self' },
          { remove: 'FxBullet' },
        ],
      },
    ])
    const a = w.spawn([entry(Hp, { hp: 1 }), entry(Tag, { n: 5 }), entry(Bullet, { vx: 1, path: [] })])
    w.stepOnce()
    expect(w.getComponent(a, Pos)).toEqual({ x: 2, y: 0 })
    expect(w.getComponent(a, Tag)).toEqual({ n: 20 })
    expect(w.has(a, Bullet)).toBe(false)
    w.stepOnce()
    expect(w.getComponent(a, Pos)).toEqual({ x: 3, y: 0 })
    expect(w.getComponent(a, Tag)).toEqual({ n: 30 })
  })

  it('add of a type whose name another type holds in the world faults the entity, never throws', () => {
    const w = world()
    const Impostor = defineComponent<{ n: number }>('FxTag', { defaults: { n: 0 } })
    const errors = installRules(w, [], (n) => (n === 'FxTag' ? Impostor : resolve(n)), OPTIONS).update([
      { name: 'tagger', schedule: 'tick', query: ['FxHp'], actions: [], effects: [{ add: 'FxTag' }] },
    ])
    expect([...errors]).toEqual([])
    w.register(Tag)
    const a = w.spawn([entry(Hp, { hp: 1 })])
    w.stepOnce()
    expect(w.has(a, Tag)).toBe(false)
    expect(faultsOf(w, a)).toEqual([expect.stringMatching(/add "FxTag".*another component type.*"FxTag"/)])
  })

  it('add of an existing component marks it changed only through set', () => {
    const w = world()
    install(w, [{ name: 'r', schedule: 'tick', query: ['FxHp'], actions: [], effects: [{ add: 'FxTag', set: { n: '4' } }] }])
    const a = w.spawn([entry(Hp, { hp: 1 })])
    w.stepOnce()
    expect(w.getComponent(a, Tag)).toEqual({ n: 4 })
    w.getComponent(a, Tag)!.n = 1
    w.markChanged(a, Tag)
    w.stepOnce()
    expect(w.getComponent(a, Tag)).toEqual({ n: 4 })
  })

  it('effects on other: add, remove and despawn the bound entity', () => {
    const w = world()
    install(w, [
      {
        name: 'hit',
        schedule: 'event',
        on: 'FxHit',
        self: 'event.a',
        other: 'event.b',
        query: ['FxHp'],
        actions: [{ set: 'FxHp.hp', expr: 'FxHp.hp - 1' }],
        effects: [{ add: 'FxTag', to: 'other', set: { n: 'self.id' } }, { remove: 'FxPos', from: 'other' }, { despawn: 'other' }],
      },
    ])
    const a = w.spawn([entry(Hp, { hp: 3 })])
    const b = w.spawn([entry(Pos, { x: 1, y: 1 })])
    const removed: string[] = []
    w.signals.componentRemoved.subscribe((e) => removed.push(`${e.entity}:${e.type.name}`))
    w.action(Hit, { a, b })
    expect(w.getComponent(a, Hp)!.hp).toBe(2)
    expect(w.isAlive(b)).toBe(false)
    expect(removed).toEqual([`${b}:FxPos`, `${b}:FxTag`])
    // A dead or unbound other: effects on it are skipped.
    w.action(Hit, { a, b })
    expect(w.getComponent(a, Hp)!.hp).toBe(1)
    expect(w.has(a, Faulted)).toBe(false)
  })
})

describe('E14.2 atomicity', () => {
  it('test 6: a failing action queues no effects for that entity', () => {
    const w = world()
    install(w, [
      {
        name: 'r',
        schedule: 'tick',
        query: ['FxHp'],
        actions: [{ set: 'FxHp.hp', expr: 'FxHp.hp + FxLoose.v' }],
        effects: [{ emit: 'FxPing', payload: { n: 'self.id' } }, { spawn: 'bullet' }, { despawn: 'self' }],
      },
    ])
    const good = w.spawn([entry(Hp, { hp: 1 }), entry(Loose, { v: 1 })])
    const bad = w.spawn([entry(Hp, { hp: 1 })])
    w.stepOnce()
    expect(w.isAlive(bad)).toBe(true)
    expect(w.isAlive(good)).toBe(false)
    expect(w.pendingEvents().map((e) => e.payload)).toEqual([{ n: good }])
    expect(w.listEntities([Bullet])).toHaveLength(1)
    expect(faultsOf(w, bad)).toHaveLength(1)
  })

  it('a failing effect expression commits no write and queues nothing', () => {
    const w = world()
    install(w, [
      {
        name: 'r',
        schedule: 'tick',
        query: ['FxHp'],
        actions: [{ set: 'FxHp.hp', expr: 'FxHp.hp + 1' }],
        effects: [{ despawn: 'self' }, { emit: 'FxPing', payload: { n: 'FxLoose.v' } }],
      },
    ])
    const bad = w.spawn([entry(Hp, { hp: 1 })])
    w.stepOnce()
    expect(w.isAlive(bad)).toBe(true)
    expect(w.getComponent(bad, Hp)!.hp).toBe(1)
    expect(w.pendingEvents()).toEqual([])
    expect(faultsOf(w, bad)).toEqual([expect.stringMatching(/FxLoose\.v/)])
  })

  it('a false when queues no effects', () => {
    const w = world()
    install(w, [{ name: 'r', schedule: 'tick', query: ['FxHp'], when: 'FxHp.hp > 5', actions: [], effects: [{ despawn: 'self' }] }])
    const a = w.spawn([entry(Hp, { hp: 1 })])
    w.stepOnce()
    expect(w.isAlive(a)).toBe(true)
  })
})

describe('E14.2 live vs fork', () => {
  const RULES: RuleDef[] = [
    { name: 'clock', schedule: 'tick', query: ['FxGun'], actions: [{ set: 'FxGun.t', expr: 'FxGun.t + 1' }] },
    {
      name: 'fire',
      schedule: 'tick',
      query: ['FxGun', 'FxPos'],
      when: 'FxGun.t % 3 == 0',
      actions: [],
      effects: [
        { spawn: 'bullet', at: { x: 'FxPos.x', y: 'random() * 10' }, set: { 'FxBullet.vx': 'random() - 0.5' } },
        { emit: 'FxPing', payload: { n: 'FxGun.t' } },
      ],
    },
    { name: 'move', schedule: 'tick', query: ['FxBullet', 'FxPos'], actions: [{ set: 'FxPos.x', expr: 'FxPos.x + FxBullet.vx' }] },
    {
      name: 'expire',
      schedule: 'tick',
      query: ['FxBullet', 'FxPos'],
      when: 'abs(FxPos.x) > 2',
      actions: [],
      effects: [{ despawn: 'self' }, { emit: 'FxDied', payload: { who: 'self.id' } }],
    },
    { name: 'count', schedule: 'event', on: 'FxDied', query: ['FxGun'], actions: [{ set: 'FxGun.kills', expr: 'FxGun.kills + 1' }] },
    {
      name: 'ping',
      schedule: 'event',
      on: 'FxPing',
      query: ['FxGun'],
      when: 'event.n % 2 == 0',
      actions: [],
      effects: [{ add: 'FxTag', set: { n: 'event.n' } }],
    },
    { name: 'untag', schedule: 'tick', query: ['FxTag'], when: 'FxTag.n % 4 == 0', actions: [], effects: [{ remove: 'FxTag' }] },
  ]

  function build(): World {
    const w = world()
    install(w, RULES, { ...OPTIONS, rng: 'own' })
    return w
  }

  it('test 7: equal strict hashes with spawns, despawns and emits in flight across the snapshot point', () => {
    const live = build()
    live.spawn([entry(Gun, { t: 0, kills: 0 }), entry(Pos, { x: 0, y: 0 })])
    live.spawn([entry(Gun, { t: 1, kills: 0 }), entry(Pos, { x: 1, y: 0 })])
    const dt = 1 / 60
    const TOTAL = 90
    const forks: Array<{ at: number; world: World }> = []
    let sawPending = 0
    // Control: a fork restored without the pending events (taken where
    // some were in flight) must diverge.
    let lossy: World | undefined
    for (let i = 0; i < TOTAL; i++) {
      live.step(dt)
      if (lossy) lossy.step(dt)
      else if (i > 10 && live.pendingEvents().some((e) => e.type === Died)) {
        lossy = build()
        lossy.restore(live.snapshot())
      }
      if (i % 7 === 3) {
        if (live.pendingEvents().length > 0) sawPending++
        const fork = build()
        fork.restore(live.snapshot({ pendingEvents: true }))
        forks.push({ at: i, world: fork })
      }
      for (const f of forks) {
        if (f.at === i) continue
        f.world.step(dt)
        expect(strict(f.world), `fork@${f.at} tick ${i}`).toBe(strict(live))
      }
    }
    // Not vacuous: bullets were spawned and despawned, kills counted, tags toggled.
    const guns = live.listEntities([Gun])
    expect(guns.map((g) => live.getComponent(g, Gun)!.kills).some((k) => k > 0)).toBe(true)
    expect(live.listEntities([Bullet]).length).toBeGreaterThan(0)
    expect(sawPending).toBeGreaterThan(5)
    expect(live.describe().entityCount).toBeLessThan(2 + TOTAL / 3 * 2)
    expect(lossy).toBeDefined()
    expect(strict(lossy!)).not.toBe(strict(live))
  })
})

describe('E14.2 compile errors (test 8: field attribution)', () => {
  const w = world()
  const base: RuleDef = { name: 'r', schedule: 'tick', query: ['FxHp'], actions: [] }
  const errorsOf = (effects: unknown, over: Partial<RuleDef> = {}, options: Parameters<typeof compileRule>[2] = OPTIONS_C): RuleError[] =>
    compileRule({ ...base, ...over, effects } as RuleDef, resolve, options).errors
  // `OPTIONS_C` is defined below; hoisted by the closure.
  const e = (effect: number, part: string, position = -1, message: RegExp = /./) =>
    ({ rule: 'r', position, message: expect.stringMatching(message), field: { effect, part } })

  it('effect shape', () => {
    expect(errorsOf('x')).toEqual([e(-1, 'effects', -1, /array/)])
    expect(errorsOf([null])).toEqual([e(0, 'effect', -1, /exactly one of/)])
    expect(errorsOf([{}])).toEqual([e(0, 'effect', -1, /exactly one of/)])
    expect(errorsOf([{ emit: 'FxPing', despawn: 'self' }])).toEqual([e(0, 'effect', -1, /exactly one of/)])
  })

  it('emit', () => {
    expect(errorsOf([{ emit: 'Nope' }])).toEqual([e(0, 'emit', -1, /Unknown event "Nope"/)])
    expect(errorsOf([{ emit: 'FxDied', payload: { whom: '1' } }])).toEqual([e(0, 'payload.whom', -1, /FxDied.*"whom".*who/)])
    expect(errorsOf([{ emit: 'FxPing', payload: { constructor: '1' } }])).toEqual([e(0, 'payload.constructor', -1, /not allowed/)])
    expect(errorsOf([{ emit: 'FxPing', payload: { n: '1 +' } }])).toEqual([e(0, 'payload.n', 3)])
    expect(errorsOf([{ emit: 'FxPing', payload: { n: 'Nope.x' } }])).toEqual([e(0, 'payload.n', 0, /Unknown component "Nope"/)])
    expect(errorsOf([{ emit: 'FxPing', payload: { n: 'other.id' } }])).toEqual([e(0, 'payload.n', 0, /only event rules/)])
    expect(errorsOf([{ emit: 'FxPing', payload: 'x' }])).toEqual([e(0, 'payload', -1, /object/)])
    expect(errorsOf([{ emit: 'FxPing', payload: { n: 7 } }])).toEqual([e(0, 'payload.n', -1, /expression string/)])
  })

  it('spawn', () => {
    expect(errorsOf([{ spawn: 'bullet' }], {}, {})).toEqual([e(0, 'spawn', -1, /prefabs option/)])
    expect(errorsOf([{ spawn: 'rocket' }])).toEqual([e(0, 'spawn', -1, /Unknown prefab "rocket"/)])
    expect(errorsOf([{ spawn: 'bullet', at: { x: '1', y: '2' } }], {}, { prefabs })).toEqual([e(0, 'at', -1, /spatial option/)])
    expect(errorsOf([{ spawn: 'bullet', at: { x: '1' } }])).toEqual([e(0, 'at', -1, /\{ x, y \}/)])
    expect(errorsOf([{ spawn: 'bullet', at: { x: '1 +', y: '0' } }])).toEqual([e(0, 'at.x', 3)])
    expect(errorsOf([{ spawn: 'bullet', at: { x: '0', y: '"a" * 2' } }])).toEqual([e(0, 'at.y', 0, /number/)])
    expect(errorsOf([{ spawn: 'bullet', at: { x: '"left"', y: '0' } }])).toEqual([e(0, 'at.x', 0, /number/)])
    expect(errorsOf([{ spawn: 'bullet', set: { vx: '1' } }])).toEqual([e(0, 'set.vx', -1, /Component\.field/)])
    expect(errorsOf([{ spawn: 'bullet', set: { 'Nope.vx': '1' } }])).toEqual([e(0, 'set.Nope.vx', -1, /Unknown component "Nope"/)])
    expect(errorsOf([{ spawn: 'bullet', set: { 'FxBullet.__proto__': '1' } }])).toEqual([e(0, 'set.FxBullet.__proto__', -1, /not allowed/)])
    expect(errorsOf([{ spawn: 'bullet', set: { 'FxBullet.vx': 'FxBullet.vx +' } }])).toEqual([e(0, 'set.FxBullet.vx', 13)])
  })

  it('despawn, add, remove and their targets', () => {
    expect(errorsOf([{ despawn: 'it' }])).toEqual([e(0, 'despawn', -1, /"self" or "other"/)])
    expect(errorsOf([{ despawn: 'other' }])).toEqual([e(0, 'despawn', -1, /"other" binding/)])
    expect(errorsOf([{ add: 'Nope' }])).toEqual([e(0, 'add', -1, /Unknown component "Nope"/)])
    expect(errorsOf([{ add: 'FxTag', to: 'them' }])).toEqual([e(0, 'to', -1, /"self" or "other"/)])
    expect(errorsOf([{ add: 'FxTag', to: 'other' }])).toEqual([e(0, 'to', -1, /"other" binding/)])
    expect(errorsOf([{ add: 'FxTag', set: { 'FxPos.x': '1' } }])).toEqual([e(0, 'set.FxPos.x', -1, /FxTag/)])
    expect(errorsOf([{ add: 'FxTag', set: { n: '1 +' } }])).toEqual([e(0, 'set.n', 3)])
    expect(errorsOf([{ remove: 'Nope' }])).toEqual([e(0, 'remove', -1, /Unknown component "Nope"/)])
    expect(errorsOf([{ remove: 'FxTag', from: 'other' }])).toEqual([e(0, 'from', -1, /"other" binding/)])
    // The index is the effect's own.
    expect(errorsOf([{ despawn: 'self' }, { remove: 'Nope' }])).toEqual([e(1, 'remove', -1, /Nope/)])
  })

  it('world scope: self targets and evaluated-entity reads are errors', () => {
    const ws = { schedule: 'event', on: 'FxPing', query: [] } as Partial<RuleDef>
    expect(errorsOf([{ despawn: 'self' }], ws)).toEqual([e(0, 'despawn', -1, /world-scope/)])
    expect(errorsOf([{ add: 'FxTag' }], ws)).toEqual([e(0, 'to', -1, /world-scope/)])
    expect(errorsOf([{ remove: 'FxTag' }], ws)).toEqual([e(0, 'from', -1, /world-scope/)])
    expect(errorsOf([{ emit: 'FxPing', payload: { n: 'FxHp.hp' } }], ws)).toEqual([e(0, 'payload.n', 0, /no evaluated entity/)])
    expect(errorsOf([{ spawn: 'bullet', set: { 'FxTag.n': 'event.n' } }], ws)).toEqual([])
  })

  it('installRules reports effect errors under the rule name', () => {
    const errors = installRules(w, [], resolve, OPTIONS).update([{ ...base, effects: [{ spawn: 'rocket' }] }])
    expect(errors.get('r')).toEqual([e(0, 'spawn', -1, /rocket/)])
  })
})

const OPTIONS_C: Parameters<typeof compileRule>[2] = {
  prefabs,
  spatial: { component: 'FxPos' },
  resolveEvent: (name) => [Ping, Died, Seen, Fire, Hit].find((t) => t.name === name),
}
