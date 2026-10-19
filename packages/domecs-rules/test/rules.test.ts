import { describe, expect, it } from 'vitest'
import { Faulted, createWorld, defineComponent, defineEvent, entry, type ComponentType, type World } from '@domecs/core'
import { compileRule, installRules, type RuleDef, type RuleError } from '../src/rules.js'

const Health = defineComponent<{ hp: number }>('Health', { defaults: { hp: 10 } })
const Velocity = defineComponent<{ x: number; y: number }>('Velocity', { defaults: { x: 0, y: 0 } })
const Flag = defineComponent<{ on: boolean }>('Flag', { defaults: { on: false } })
const RandomVal = defineComponent<{ v: number }>('RandomVal', { defaults: { v: 0 } })

function resolveFrom(types: ComponentType<any>[]): (name: string) => ComponentType<any> | undefined {
  const byName = new Map(types.map((t) => [t.name, t]))
  return (name) => byName.get(name)
}

describe('compileRule', () => {
  const resolve = resolveFrom([Health, Velocity, Flag])

  it('compiles a well-formed rule with when + actions', () => {
    const def: RuleDef = {
      name: 'decay',
      schedule: 'tick',
      query: ['Health'],
      when: 'Health.hp > 0',
      actions: [{ set: 'Health.hp', expr: 'Health.hp - dt * 1' }],
    }
    const result = compileRule(def, resolve)
    expect(result.errors).toEqual([])
    expect(result.rule).not.toBeNull()
    expect(result.rule!.def).toBe(def)
  })

  it('compiles a rule with no when and multiple actions', () => {
    const def: RuleDef = {
      name: 'move',
      schedule: 'tick',
      query: ['Health', 'Velocity'],
      actions: [
        { set: 'Velocity.x', expr: 'Velocity.x + 1' },
        { set: 'Velocity.y', expr: 'Velocity.y - 1' },
      ],
    }
    const result = compileRule(def, resolve)
    expect(result.errors).toEqual([])
    expect(result.rule).not.toBeNull()
  })

  it('returns rule:null and a RuleError for an unknown component in query', () => {
    const def: RuleDef = {
      name: 'bad-query',
      schedule: 'tick',
      query: ['Nonexistent'],
      actions: [],
    }
    const result = compileRule(def, resolve)
    expect(result.rule).toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.rule).toBe('bad-query')
    expect(result.errors[0]!.message).toContain('Nonexistent')
  })

  it('returns rule:null and a RuleError for an unknown component referenced in when', () => {
    const def: RuleDef = {
      name: 'bad-when',
      schedule: 'tick',
      query: ['Health'],
      when: 'Nope.field > 0',
      actions: [],
    }
    const result = compileRule(def, resolve)
    expect(result.rule).toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.message).toContain('Nope')
  })

  it('returns rule:null and a RuleError for an unknown component in an action target', () => {
    const def: RuleDef = {
      name: 'bad-action-target',
      schedule: 'tick',
      query: ['Health'],
      actions: [{ set: 'Nope.field', expr: '1' }],
    }
    const result = compileRule(def, resolve)
    expect(result.rule).toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.message).toContain('Nope')
  })

  it('returns rule:null and a RuleError for an unknown component in an action expr', () => {
    const def: RuleDef = {
      name: 'bad-action-expr',
      schedule: 'tick',
      query: ['Health'],
      actions: [{ set: 'Health.hp', expr: 'Nope.field' }],
    }
    const result = compileRule(def, resolve)
    expect(result.rule).toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.message).toContain('Nope')
  })

  it('collects a syntax ParseError from when as a RuleError with the same position', () => {
    const def: RuleDef = {
      name: 'bad-syntax',
      schedule: 'tick',
      query: ['Health'],
      when: 'Health.hp > ',
      actions: [],
    }
    const result = compileRule(def, resolve)
    expect(result.rule).toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.position).toBe('Health.hp > '.length)
  })

  it('collects errors from multiple bad parts at once, never a partial rule', () => {
    const def: RuleDef = {
      name: 'multi-bad',
      schedule: 'tick',
      query: ['Nonexistent'],
      when: 'AlsoMissing.x > 0',
      actions: [{ set: 'StillMissing.y', expr: '1' }],
    }
    const result = compileRule(def, resolve)
    expect(result.rule).toBeNull()
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })

  it('rejects a malformed action "set" that is not Component.field', () => {
    const def: RuleDef = {
      name: 'bad-set-shape',
      schedule: 'tick',
      query: ['Health'],
      actions: [{ set: 'NoDotHere', expr: '1' }],
    }
    const result = compileRule(def, resolve)
    expect(result.rule).toBeNull()
    expect(result.errors).toHaveLength(1)
  })
})

describe('installRules — behavior against a real World', () => {
  const resolve = resolveFrom([Health, Velocity, Flag, RandomVal])

  it('applies when + actions each tick', () => {
    const world = createWorld({ seed: 1, headless: true })
    const e = world.spawn([[Health, { hp: 10 }]] as any)

    const defs: RuleDef[] = [
      {
        name: 'decay',
        schedule: 'tick',
        query: ['Health'],
        when: 'Health.hp > 0',
        actions: [{ set: 'Health.hp', expr: 'Health.hp - dt * 1' }],
      },
    ]
    const handle = installRules(world, defs, resolve)
    expect(handle.update).toBeInstanceOf(Function)

    world.step(1)
    expect(world.getComponent(e, Health)!.hp).toBe(9)
    world.step(1)
    expect(world.getComponent(e, Health)!.hp).toBe(8)
  })

  it('does not apply actions when `when` is falsy', () => {
    const world = createWorld({ seed: 1, headless: true })
    const e = world.spawn([[Health, { hp: 0 }]] as any)

    const defs: RuleDef[] = [
      {
        name: 'decay',
        schedule: 'tick',
        query: ['Health'],
        when: 'Health.hp > 0',
        actions: [{ set: 'Health.hp', expr: 'Health.hp - 1' }],
      },
    ]
    installRules(world, defs, resolve)
    world.step(1)
    expect(world.getComponent(e, Health)!.hp).toBe(0)
  })

  it('a disabled rule (enabled: false) never runs', () => {
    const world = createWorld({ seed: 1, headless: true })
    const e = world.spawn([[Health, { hp: 10 }]] as any)

    const defs: RuleDef[] = [
      {
        name: 'decay',
        schedule: 'tick',
        enabled: false,
        query: ['Health'],
        actions: [{ set: 'Health.hp', expr: 'Health.hp - 1' }],
      },
    ]
    installRules(world, defs, resolve)
    world.step(1)
    world.step(1)
    expect(world.getComponent(e, Health)!.hp).toBe(10)
  })

  it('one entity missing a field referenced by `when` does not crash the tick for others', () => {
    const world = createWorld({ seed: 1, headless: true })
    const withFlag = world.spawn([
      [Health, { hp: 10 }],
      [Flag, { on: true }],
    ] as any)
    const withoutFlag = world.spawn([[Health, { hp: 10 }]] as any)

    const defs: RuleDef[] = [
      {
        name: 'flagged-decay',
        schedule: 'tick',
        query: ['Health'],
        when: 'Flag.on == true',
        actions: [{ set: 'Health.hp', expr: 'Health.hp - 1' }],
      },
    ]
    installRules(world, defs, resolve)

    expect(() => world.step(1)).not.toThrow()

    // The entity that has Flag and satisfies `when` gets the action applied.
    expect(world.getComponent(withFlag, Health)!.hp).toBe(9)
    // The entity missing Flag entirely: resolveField -> undefined -> evaluate
    // throws -> caught -> entity skipped for this tick, not crashed.
    expect(world.getComponent(withoutFlag, Health)!.hp).toBe(10)
  })

  it('update() swaps the rule set and removes systems for rules no longer present', () => {
    const world = createWorld({ seed: 1, headless: true })
    const e = world.spawn([[Health, { hp: 10 }]] as any)

    const ruleA: RuleDef = {
      name: 'A',
      schedule: 'tick',
      query: ['Health'],
      actions: [{ set: 'Health.hp', expr: 'Health.hp - 1' }],
    }
    const handle = installRules(world, [ruleA], resolve)

    expect(world.getSystem('rule:A')).toBeDefined()
    world.step(1)
    expect(world.getComponent(e, Health)!.hp).toBe(9)

    const errors = handle.update([])
    expect(errors.size).toBe(0)
    expect(world.getSystem('rule:A')).toBeUndefined()

    world.step(1)
    // A no longer runs — hp stays at 9.
    expect(world.getComponent(e, Health)!.hp).toBe(9)
  })

  it('update() replaces rule B with rule C, leaving no stale system behind', () => {
    const world = createWorld({ seed: 1, headless: true })
    world.spawn([[Health, { hp: 10 }]] as any)

    const ruleB: RuleDef = {
      name: 'B',
      schedule: 'tick',
      query: ['Health'],
      actions: [{ set: 'Health.hp', expr: 'Health.hp - 1' }],
    }
    const handle = installRules(world, [ruleB], resolve)
    expect(world.getSystem('rule:B')).toBeDefined()

    const ruleC: RuleDef = {
      name: 'C',
      schedule: 'tick',
      query: ['Health'],
      actions: [{ set: 'Health.hp', expr: 'Health.hp - 2' }],
    }
    handle.update([ruleC])

    expect(world.getSystem('rule:B')).toBeUndefined()
    expect(world.getSystem('rule:C')).toBeDefined()
  })

  it('update() reports errors for defs that fail to compile and does not install them, while still installing the rest', () => {
    const world = createWorld({ seed: 1, headless: true })
    world.spawn([[Health, { hp: 10 }]] as any)

    const good: RuleDef = {
      name: 'good',
      schedule: 'tick',
      query: ['Health'],
      actions: [{ set: 'Health.hp', expr: 'Health.hp - 1' }],
    }
    const bad: RuleDef = {
      name: 'bad',
      schedule: 'tick',
      query: ['Nonexistent'],
      actions: [],
    }
    const handle = installRules(world, [good, bad], resolve)
    const errors = handle.update([good, bad])

    expect(errors.size).toBe(1)
    expect(errors.has('bad')).toBe(true)
    expect(errors.has('good')).toBe(false)
    expect(world.getSystem('rule:good')).toBeDefined()
    expect(world.getSystem('rule:bad')).toBeUndefined()
  })

  it('update() removes a previously-installed rule that now fails to compile', () => {
    const world = createWorld({ seed: 1, headless: true })
    world.spawn([[Health, { hp: 10 }]] as any)

    const defOk: RuleDef = {
      name: 'flexible',
      schedule: 'tick',
      query: ['Health'],
      actions: [{ set: 'Health.hp', expr: 'Health.hp - 1' }],
    }
    const handle = installRules(world, [defOk], resolve)
    expect(world.getSystem('rule:flexible')).toBeDefined()

    const defBroken: RuleDef = {
      name: 'flexible',
      schedule: 'tick',
      query: ['Nonexistent'],
      actions: [],
    }
    const errors = handle.update([defBroken])
    expect(errors.has('flexible')).toBe(true)
    expect(world.getSystem('rule:flexible')).toBeUndefined()
  })

  it('uninstall() removes every installed rule system', () => {
    const world = createWorld({ seed: 1, headless: true })
    world.spawn([[Health, { hp: 10 }]] as any)

    const defs: RuleDef[] = [
      { name: 'A', schedule: 'tick', query: ['Health'], actions: [{ set: 'Health.hp', expr: 'Health.hp - 1' }] },
      { name: 'B', schedule: 'tick', query: ['Health'], actions: [{ set: 'Health.hp', expr: 'Health.hp - 1' }] },
    ]
    const handle = installRules(world, defs, resolve)
    expect(world.getSystem('rule:A')).toBeDefined()
    expect(world.getSystem('rule:B')).toBeDefined()

    handle.uninstall()
    expect(world.getSystem('rule:A')).toBeUndefined()
    expect(world.getSystem('rule:B')).toBeUndefined()
  })
})

describe('installRules — determinism', () => {
  it('two worlds with the same seed produce bit-identical results for a rule using random()', () => {
    const resolve = resolveFrom([RandomVal])

    function buildAndRun(): number {
      const world: World = createWorld({ seed: 12345, headless: true })
      world.spawn([[RandomVal, { v: 0 }]] as any)
      const defs: RuleDef[] = [
        {
          name: 'roll',
          schedule: 'tick',
          query: ['RandomVal'],
          actions: [{ set: 'RandomVal.v', expr: 'RandomVal.v + random()' }],
        },
      ]
      installRules(world, defs, resolve)
      world.stepN(25, 1)
      const [e] = world.listEntities([RandomVal])
      return world.getComponent(e!, RandomVal)!.v
    }

    const a = buildAndRun()
    const b = buildAndRun()
    expect(a).toBe(b)
    // Sanity: random() actually did something (not stuck at the seeded default).
    expect(a).not.toBe(0)
  })
})

describe('RuleError.field — per-part attribution (§4.6)', () => {
  const resolve = resolveFrom([Health, Velocity, Flag])
  const base = (over: Partial<RuleDef>): RuleDef => ({
    name: 'r',
    schedule: 'tick',
    query: ['Health'],
    actions: [{ set: 'Health.hp', expr: 'Health.hp' }],
    ...over,
  })
  const ok = { set: 'Health.hp', expr: 'Health.hp' }

  // One def per error class → the single error it produces.
  const cases: Array<[string, RuleDef, RuleError['field'], number]> = [
    ['bad schedule', base({ schedule: 'frame' as 'tick' }), 'schedule', -1],
    ['non-finite priority', base({ priority: Number.NaN }), 'priority', -1],
    ['unknown query component', base({ query: ['Health', 'Nope'] }), { query: 1 }, -1],
    ['when parse error', base({ when: 'Health.hp >' }), 'when', 11],
    ['when unknown component', base({ when: 'Health.hp > Nope.x' }), 'when', 12],
    ['when forbidden field', base({ when: 'Health.__proto__ > 0' }), 'when', 0],
    ['when type error', base({ when: 'Health.hp > "a"' }), 'when', 12],
    ['malformed set', base({ actions: [ok, { set: 'Health', expr: '1' }] }), { action: 1, part: 'set' }, -1],
    ['unknown set component', base({ actions: [ok, { set: 'Nope.x', expr: '1' }] }), { action: 1, part: 'set' }, -1],
    ['forbidden set field', base({ actions: [ok, { set: 'Health.constructor', expr: '1' }] }), { action: 1, part: 'set' }, -1],
    ['expr parse error', base({ actions: [ok, { set: 'Health.hp', expr: '1 +' }] }), { action: 1, part: 'expr' }, 3],
    ['expr unknown component', base({ actions: [ok, { set: 'Health.hp', expr: '1 + Nope.x' }] }), { action: 1, part: 'expr' }, 4],
    ['expr forbidden field', base({ actions: [ok, { set: 'Health.hp', expr: 'Health.prototype' }] }), { action: 1, part: 'expr' }, 0],
    ['expr type error', base({ actions: [ok, { set: 'Health.hp', expr: '2 * "a"' }] }), { action: 1, part: 'expr' }, 4],
  ]

  it.each(cases)('%s', (_label, def, field, position) => {
    const result = compileRule(def, resolve)
    expect(result.rule).toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.field).toEqual(field)
    expect(result.errors[0]!.position).toBe(position)
  })

  it('attributes a duplicate name to "name" through update()', () => {
    const world = createWorld({ headless: true })
    const errors = installRules(world, [], resolve).update([base({}), base({})])
    expect(errors.get('r')).toEqual([
      { rule: 'r', position: -1, message: expect.stringContaining('Duplicate'), field: 'name' },
    ])
  })

  it('maps type errors to their own action index, after other errors are clear', () => {
    // Type checking runs only once parse/resolve errors are gone, so a def
    // with a type error in a later action reports exactly that action.
    const result = compileRule(
      base({
        when: '1 > "a"',
        actions: [ok, ok, { set: 'Health.hp', expr: '2 * "a"' }],
      }),
      resolve,
    )
    expect(result.errors.map((e) => [e.field, e.position])).toEqual([
      ['when', 4],
      [{ action: 2, part: 'expr' }, 4],
    ])
  })

  it('appends the duplicate-name error after the first def\'s own compile errors', () => {
    const world = createWorld({ headless: true })
    const bad = base({ schedule: 'x' as 'tick' })
    const errors = installRules(world, [], resolve).update([bad, base({})])
    expect(errors.get('r')!.map((e) => e.field)).toEqual(['schedule', 'name'])
  })

  it('keeps one field per error when several parts fail together', () => {
    const result = compileRule(
      base({
        schedule: 'x' as 'tick',
        query: ['Nope'],
        when: 'Nope.a > 0',
        actions: [{ set: 'Nope.b', expr: 'Nope.c' }],
      }),
      resolve,
    )
    expect(result.errors.map((e) => e.field)).toEqual([
      'schedule',
      { query: 0 },
      'when',
      { action: 0, part: 'set' },
      { action: 0, part: 'expr' },
    ])
  })
})

// Spec §6.1 (G8, O-84), plan E14.1: event-triggered rules.
describe('E14.1 event rules', () => {
  const EvPos = defineComponent<{ x: number; y: number }>('EvPos', { defaults: { x: 0, y: 0 } })
  const EvTag = defineComponent<Record<string, never>>('EvTag', { defaults: {} })
  const EvShield = defineComponent<Record<string, never>>('EvShield', { defaults: {} })
  const Move = defineEvent<{ target?: number; dx?: number }>('EvMove', {
    schema: { fields: { target: { kind: 'number' }, dx: { kind: 'number' } } },
  })
  const Push = defineEvent<{ dx: number }>('EvPush') // schema-less
  const Hit = defineEvent<{ a: number; b: number }>('EvHit', {
    schema: { fields: { a: { kind: 'number' }, b: { kind: 'number' } } },
  })
  const resolveEv = resolveFrom([EvPos, EvTag, EvShield, Health])

  function evWorld(): World {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    expect(w.register(Move, Push, Hit).ok).toBe(true)
    return w
  }
  const moveRule: RuleDef = {
    name: 'move',
    schedule: 'event',
    on: 'EvMove',
    self: 'event.target',
    query: ['EvPos'],
    actions: [{ set: 'EvPos.x', expr: 'EvPos.x + event.dx' }],
  }
  function install(w: World, defs: RuleDef[]): Map<string, RuleError[]> {
    const handle = installRules(w, [], resolveEv)
    return handle.update(defs)
  }
  const systemic = (w: World): Array<{ source: string; kind: string; message: string }> => {
    const seen: Array<{ source: string; kind: string; message: string }> = []
    w.signals.faultRaised.subscribe((f) =>
      seen.push({ source: f.source, kind: f.entry.kind, message: String((f.entry.detail as { message?: unknown })?.message) }),
    )
    return seen
  }

  it('test 1: act(Move, {target, dx}) with self: event.target moves only that entity, no code systems', () => {
    const w = evWorld()
    expect(install(w, [moveRule])).toEqual(new Map())
    const a = w.spawn([entry(EvPos, { x: 0, y: 0 })])
    const b = w.spawn([entry(EvPos, { x: 10, y: 0 })])
    const r = w.action(Move, { target: b, dx: 3 })
    expect(r.accepted).toBe(true)
    expect(w.getComponent(a, EvPos)!.x).toBe(0)
    expect(w.getComponent(b, EvPos)!.x).toBe(13)
    // The trigger is listed as a command the world accepts (O-51), and the
    // system maps back to its rule (§4.5).
    const manifest = w.describe()
    expect(manifest.events.map((e) => e.name)).toContain('EvMove')
    expect(manifest.systems.find((s) => s.name === 'rule:move')).toMatchObject({ schedule: 'event' })
  })

  it('every payload of the tick runs, in emission order', () => {
    const w = evWorld()
    install(w, [{ ...moveRule, actions: [{ set: 'EvPos.x', expr: 'EvPos.x * 10 + event.dx' }] }])
    const a = w.spawn([entry(EvPos, { x: 0, y: 0 })])
    w.emit(Move, { target: a, dx: 1 })
    w.emit(Move, { target: a, dx: 2 })
    w.stepOnce()
    expect(w.getComponent(a, EvPos)!.x).toBe(12)
    // No event, no run.
    w.stepOnce()
    expect(w.getComponent(a, EvPos)!.x).toBe(12)
  })

  it('a dead, unmatched or excluded self is a silent no-op', () => {
    const w = evWorld()
    const faults = systemic(w)
    install(w, [{ ...moveRule, without: ['EvShield'] }])
    const dead = w.spawn([entry(EvPos, { x: 0, y: 0 })])
    w.despawn(dead)
    const bare = w.spawn([entry(Health, { hp: 1 })])
    const shielded = w.spawn([entry(EvPos, { x: 0, y: 0 }), entry(EvShield, {})])
    for (const target of [dead, bare, shielded, 9999, -1]) {
      expect(w.action(Move, { target, dx: 5 }).accepted).toBe(true)
    }
    expect(w.getComponent(shielded, EvPos)!.x).toBe(0)
    expect(w.has(bare, Faulted)).toBe(false)
    expect(w.has(shielded, Faulted)).toBe(false)
    expect(faults).toEqual([])
  })

  it('a self binding that gives no id is a systemic fault (not a throw)', () => {
    const w = evWorld()
    const faults = systemic(w)
    const handle = installRules(w, [moveRule], resolveEv)
    const a = w.spawn([entry(EvPos, { x: 0, y: 0 })])
    w.action(Move, { dx: 1 }) // no target: no value
    w.action(Move, { target: 1.5, dx: 1 }) // not an integer
    expect(faults.map((f) => [f.source, f.kind])).toEqual([
      ['rule:move', 'rule_eval_failed'],
      ['rule:move', 'rule_eval_failed'],
    ])
    expect(faults[0]!.message).toMatch(/event\.target/)
    expect(faults[1]!.message).toMatch(/integer/)
    // `?? -1` turns a missing target into a silent skip.
    expect(handle.update([{ ...moveRule, self: 'event.target ?? -1' }])).toEqual(new Map())
    w.action(Move, { dx: 1 })
    expect(faults).toHaveLength(2)
    expect(w.getComponent(a, EvPos)!.x).toBe(0)
  })

  it('an action that fails faults the self entity, as in polling rules', () => {
    const w = evWorld()
    install(w, [{ ...moveRule, actions: [{ set: 'EvPos.x', expr: 'EvPos.x + Health.hp' }] }])
    const a = w.spawn([entry(EvPos, { x: 0, y: 0 })])
    w.action(Move, { target: a, dx: 1 })
    expect(w.getComponent(a, Faulted)!.faults[0]).toMatchObject({ kind: 'rule_eval_failed', source: 'rule:move' })
  })

  it('test 2: broadcast runs for each matching entity in ascending id, per payload', () => {
    const w = evWorld()
    install(w, [{
      name: 'push',
      schedule: 'event',
      on: 'EvPush',
      query: ['EvPos'],
      without: ['EvShield'],
      when: 'EvPos.y == 0',
      actions: [{ set: 'EvPos.x', expr: 'EvPos.x * 10 + event.dx' }],
    }])
    const a = w.spawn([entry(EvPos, { x: 0, y: 0 })])
    const b = w.spawn([entry(EvPos, { x: 0, y: 1 })]) // when fails
    const c = w.spawn([entry(EvPos, { x: 0, y: 0 }), entry(EvShield, {})]) // excluded
    const d = w.spawn([entry(EvPos, { x: 1, y: 0 })])
    w.emit(Push, { dx: 1 })
    w.emit(Push, { dx: 2 })
    w.stepOnce()
    expect([a, b, c, d].map((id) => w.getComponent(id, EvPos)!.x)).toEqual([12, 0, 0, 112])
  })

  it('test 2: a world-scope rule (no self, empty query) runs once per payload; set is a compile error', () => {
    const w = evWorld()
    const ok = compileRule({ name: 'w', schedule: 'event', on: 'EvPush', query: [], when: 'event.dx > 0', actions: [] }, resolveEv, {
      resolveEvent: (n) => w.lookupEvent(n),
    })
    expect(ok.errors).toEqual([])
    const bad = compileRule(
      { name: 'w', schedule: 'event', on: 'EvPush', query: [], actions: [{ set: 'EvPos.x', expr: '1' }] },
      resolveEv,
      { resolveEvent: (n) => w.lookupEvent(n) },
    )
    expect(bad.rule).toBeNull()
    expect(bad.errors).toEqual([
      { rule: 'w', position: -1, message: expect.stringMatching(/world-scope.*no entity to set/), field: { action: 0, part: 'set' } },
    ])
    // A world-scope rule's failure has no entity: a systemic fault.
    const faults = systemic(w)
    install(w, [{ name: 'w', schedule: 'event', on: 'EvPush', query: [], when: 'event.nope > 0', actions: [] }])
    w.emit(Push, { dx: 1 })
    w.emit(Push, { dx: 1 })
    w.stepOnce()
    expect(faults.map((f) => f.source)).toEqual(['rule:w', 'rule:w'])
  })

  it('other: reads the bound entity; a dead other is no value', () => {
    const w = evWorld()
    const copy: RuleDef = {
      name: 'copy',
      schedule: 'event',
      on: 'EvHit',
      self: 'event.a',
      other: 'event.b',
      query: ['EvPos'],
      actions: [
        { set: 'EvPos.x', expr: 'other.EvPos.x ?? -1' },
        { set: 'EvPos.y', expr: '(has(other, EvTag) ?? false) ? 1 : 0' },
      ],
    }
    install(w, [copy])
    const a = w.spawn([entry(EvPos, { x: 0, y: 0 })])
    const b = w.spawn([entry(EvPos, { x: 7, y: 0 }), entry(EvTag, {})])
    w.action(Hit, { a, b })
    expect(w.getComponent(a, EvPos)).toEqual({ x: 7, y: 1 })
    w.despawn(b)
    w.action(Hit, { a, b })
    expect(w.getComponent(a, EvPos)).toEqual({ x: -1, y: 0 })
    // A missing `other` field is no value too.
    w.emit(Hit, { a } as { a: number; b: number })
    w.stepOnce()
    expect(w.getComponent(a, EvPos)!.x).toBe(-1)
  })

  it('event rules may draw from their own stream', () => {
    const w = evWorld()
    install(w, [{ ...moveRule, rng: 'own', actions: [{ set: 'EvPos.x', expr: 'random()' }] }])
    const a = w.spawn([entry(EvPos, { x: 0, y: 0 })])
    w.action(Move, { target: a, dx: 0 })
    const x = w.getComponent(a, EvPos)!.x
    expect(x).toBeGreaterThanOrEqual(0)
    expect(x).toBeLessThan(1)
    expect(w.describe().systems.find((s) => s.name === 'rule:move')).toMatchObject({ rng: 'own' })
  })

  describe('compile checks with field attribution', () => {
    const w = evWorld()
    const opts = { resolveEvent: (n: string) => w.lookupEvent(n) }
    // `undefined` drops a field of moveRule.
    type Patch = { [K in keyof RuleDef]?: RuleDef[K] | undefined }
    const errorsOf = (over: Patch): RuleError[] =>
      compileRule({ ...moveRule, ...over } as RuleDef, resolveEv, opts).errors

    it('on: required for event rules, must resolve, only for event rules', () => {
      expect(errorsOf({ on: undefined })).toEqual([
        { rule: 'move', position: -1, message: expect.stringMatching(/needs "on"/), field: 'on' },
      ])
      expect(errorsOf({ on: 'Nope' })).toEqual([
        { rule: 'move', position: -1, message: expect.stringMatching(/Unknown event "Nope"/), field: 'on' },
      ])
      // Without a resolver nothing resolves.
      expect(compileRule(moveRule, resolveEv).errors).toEqual([
        { rule: 'move', position: -1, message: expect.stringMatching(/Unknown event "EvMove"/), field: 'on' },
      ])
      const tick: Patch = { schedule: 'tick', self: undefined, actions: [] }
      expect(errorsOf({ ...tick })).toEqual([
        { rule: 'move', position: -1, message: expect.stringMatching(/only for event rules/), field: 'on' },
      ])
      expect(errorsOf({ ...tick, on: undefined, self: 'event.target' }).map((e) => e.field)).toEqual(['self'])
      expect(errorsOf({ ...tick, on: undefined, other: 'event.b' }).map((e) => e.field)).toEqual(['other'])
      expect(errorsOf({ schedule: 'later' as RuleDef['schedule'] })[0]).toMatchObject({
        field: 'schedule',
        message: expect.stringMatching(/"event"/),
      })
    })

    it('event.f outside event rules is an error at its position', () => {
      const r = compileRule(
        { name: 't', schedule: 'tick', query: ['EvPos'], when: 'EvPos.x < event.dx', actions: [{ set: 'EvPos.x', expr: '1 + event.dx' }] },
        resolveEv,
        opts,
      )
      expect(r.errors).toEqual([
        { rule: 't', position: 10, message: expect.stringMatching(/only event rules/), field: 'when' },
        { rule: 't', position: 4, message: expect.stringMatching(/only event rules/), field: { action: 0, part: 'expr' } },
      ])
    })

    it('with a schema, event.f must be a declared field; schema-less events take any field', () => {
      expect(errorsOf({ when: 'event.dy > 0' })).toEqual([
        { rule: 'move', position: 0, message: expect.stringMatching(/EvMove.*"dy".*target, dx/), field: 'when' },
      ])
      expect(errorsOf({ when: 'event.__proto__ > 0' })[0]).toMatchObject({ position: 0, field: 'when' })
      expect(errorsOf({ on: 'EvPush', self: undefined, when: 'event.anything > 0', actions: [] })).toEqual([])
    })

    it('other: only with an other binding, only in event rules', () => {
      expect(errorsOf({ when: 'other.EvPos.x > 0' })).toEqual([
        { rule: 'move', position: 0, message: expect.stringMatching(/"other" binding/), field: 'when' },
      ])
      const r = compileRule(
        { name: 't', schedule: 'tick', query: ['EvPos'], actions: [{ set: 'EvPos.x', expr: 'distanceTo(other)' }] },
        resolveEv,
        { ...opts, spatial: { component: 'EvPos' } },
      )
      expect(r.errors).toEqual([
        { rule: 't', position: 11, message: expect.stringMatching(/only event rules/), field: { action: 0, part: 'expr' } },
      ])
    })

    it('self/other bindings: parse and resolve errors, no evaluated entity, no other', () => {
      expect(errorsOf({ self: 'event.' })).toEqual([
        { rule: 'move', position: 6, message: expect.any(String), field: 'self' },
      ])
      expect(errorsOf({ self: 'EvPos.x' })).toEqual([
        { rule: 'move', position: 0, message: expect.stringMatching(/no evaluated entity/), field: 'self' },
      ])
      expect(errorsOf({ self: 'first(Nope).id' })).toEqual([
        { rule: 'move', position: 0, message: expect.stringMatching(/Unknown component "Nope"/), field: 'self' },
      ])
      expect(errorsOf({ other: 'other.id' })).toEqual([
        { rule: 'move', position: 0, message: expect.stringMatching(/other/), field: 'other' },
      ])
      expect(errorsOf({ other: 'nearest(EvPos).id' })[0]).toMatchObject({ position: 0, field: 'other' })
      expect(errorsOf({ self: '"a" * 2' })[0]).toMatchObject({ position: 0, field: 'self' })
      // Clean bindings may read the payload, other entities and aggregates.
      expect(errorsOf({ self: 'entity(event.target).id', other: 'first(EvTag).id ?? -1' })).toEqual([])
    })

    it('world scope: reads of the evaluated entity are errors at their position', () => {
      const r = compileRule(
        { name: 'w', schedule: 'event', on: 'EvPush', query: [], when: 'EvPos.x > 0 || has(EvTag)', actions: [] },
        resolveEv,
        opts,
      )
      expect(r.errors).toEqual([
        { rule: 'w', position: 0, message: expect.stringMatching(/no evaluated entity/), field: 'when' },
        { rule: 'w', position: 15, message: expect.stringMatching(/no evaluated entity/), field: 'when' },
      ])
      expect(
        compileRule({ name: 'w', schedule: 'event', on: 'EvPush', query: [], without: ['EvTag'], actions: [] }, resolveEv, opts).errors,
      ).toEqual([{ rule: 'w', position: -1, message: expect.stringMatching(/world-scope/), field: { without: 0 } }])
    })

    it('installRules resolves `on` through world.lookupEvent by default, or options.resolveEvent', () => {
      const w2 = createWorld({ headless: true })
      const errors = installRules(w2, [moveRule], resolveEv).update([moveRule])
      expect(errors.get('move')?.[0]).toMatchObject({ field: 'on' })
      const w3 = createWorld({ headless: true })
      expect(installRules(w3, [], resolveEv, { resolveEvent: (n) => (n === 'EvMove' ? Move : undefined) }).update([moveRule])).toEqual(new Map())
      const a = w3.spawn([entry(EvPos, { x: 0, y: 0 })])
      w3.action(Move, { target: a, dx: 2 })
      expect(w3.getComponent(a, EvPos)!.x).toBe(2)
    })
  })
})
