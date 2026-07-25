import { describe, expect, it } from 'vitest'
import { createWorld, defineComponent, type ComponentType, type World } from '@domecs/core'
import { compileRule, installRules, type RuleDef } from '../src/rules.js'

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
