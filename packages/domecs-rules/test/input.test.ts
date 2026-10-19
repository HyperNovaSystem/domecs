import { describe, expect, it } from 'vitest'
import {
  Faulted,
  createWorld,
  defineComponent,
  entry,
  hashSnapshot,
  type ComponentType,
  type InputSnapshot,
  type World,
} from '@domecs/core'
import { parseExpression } from '../src/parser.js'
import { evaluate, RuleEvalError, type EvalEnv } from '../src/evaluator.js'
import { compileRule, installRules, type RuleDef } from '../src/rules.js'
import { compileWorldExpression } from '../src/world-expression.js'
import { walkComponentRefs } from '../src/ast.js'

// Spec §5.4 (G16, O-86), plan E12.1: rules read `world.input` through
// key / pressed / released / mod and pointer.x|y|buttons|wheel.

const Out = defineComponent<{ a: number; b: number; c: number; d: number; e: number }>('InOut', {
  defaults: { a: 0, b: 0, c: 0, d: 0, e: 0 },
})
const Flags = defineComponent<{ held: boolean; down: boolean; up: boolean; ctrl: boolean }>('InFlags', {
  defaults: { held: false, down: false, up: false, ctrl: false },
})
const Bind = defineComponent<{ up: string; n: number }>('InBind', { defaults: { up: 'w', n: 1 } })
const Body = defineComponent<{ x: number; vx: number; jumps: number }>('InBody', {
  defaults: { x: 0, vx: 0, jumps: 0 },
})

const OUT0 = { a: 0, b: 0, c: 0, d: 0, e: 0 }
const FLAGS0 = { held: false, down: false, up: false, ctrl: false }

const TYPES: ComponentType<any>[] = [Out, Flags, Bind, Body]
const resolve = (name: string): ComponentType<any> | undefined => TYPES.find((t) => t.name === name)

function world(): World {
  return createWorld({ headless: true, seed: [5, 6, 7, 8] })
}

interface InputParts {
  keys?: string[]
  pressed?: string[]
  released?: string[]
  mods?: Partial<InputSnapshot['mods']>
  pointer?: Partial<Pick<InputSnapshot['pointer'], 'x' | 'y' | 'buttons' | 'wheel'>>
}

function input(parts: InputParts = {}): InputSnapshot {
  return {
    keys: new Set(parts.keys ?? []),
    keyDelta: { pressed: new Set(parts.pressed ?? []), released: new Set(parts.released ?? []) },
    mods: { ctrl: false, alt: false, shift: false, meta: false, ...parts.mods },
    pointer: { x: 0, y: 0, buttons: 0, delta: { x: 0, y: 0 }, wheel: 0, entered: [], ...parts.pointer },
    gamepads: [],
    focus: { activeTag: '', consumesKeys: false },
  }
}

function ast(source: string) {
  const r = parseExpression(source)
  if ('errors' in r) throw new Error(JSON.stringify(r.errors))
  return r.ast
}

function parseErr(source: string) {
  const r = parseExpression(source)
  if (!('errors' in r)) throw new Error(`expected a parse error for ${source}`)
  return r.errors[0]!
}

describe('input forms: grammar (§5.4)', () => {
  it('parses key/pressed/released/mod calls and pointer fields with positions', () => {
    expect(ast('key("w")')).toEqual({ kind: 'input', op: 'key', arg: { kind: 'string', value: 'w', pos: 4 }, pos: 0 })
    expect(ast('1 + pressed("a")')).toMatchObject({ right: { kind: 'input', op: 'pressed', pos: 4 } })
    expect(ast('released(InBind.up)')).toEqual({
      kind: 'input', op: 'released', arg: { kind: 'field', component: 'InBind', field: 'up', pos: 9 }, pos: 0,
    })
    expect(ast('mod("shift")')).toMatchObject({ kind: 'input', op: 'mod', pos: 0 })
    for (const field of ['x', 'y', 'buttons', 'wheel'] as const) {
      expect(ast(`2 * pointer.${field}`)).toMatchObject({ right: { kind: 'pointer', field, pos: 4 } })
    }
  })

  it('reports arity, unknown pointer fields and a bare pointer', () => {
    expect(parseErr('key()')).toMatchObject({ position: 0, message: expect.stringMatching(/key.*1 argument/) })
    expect(parseErr('pressed("a", "b")')).toMatchObject({ position: 0, message: expect.stringMatching(/1 argument/) })
    expect(parseErr('1 + pointer.z')).toMatchObject({ position: 4, message: expect.stringMatching(/x, y, buttons.*wheel/) })
    expect(parseErr('pointer')).toMatchObject({ position: 0, message: expect.stringMatching(/pointer\.x/) })
    // Still a reserved word as a component name.
    expect(parseErr('count(pointer)')).toMatchObject({ position: 6, message: expect.stringMatching(/reserved word/) })
    expect(parseErr('pointer.x.y')).toMatchObject({ position: 9 })
  })

  it('key, pressed, released and mod are not reserved: only a call starts an input read', () => {
    expect(ast('key.x')).toEqual({ kind: 'field', component: 'key', field: 'x', pos: 0 })
    expect(ast('mod.on')).toEqual({ kind: 'field', component: 'mod', field: 'on', pos: 0 })
  })

  it('walkComponentRefs visits component reads inside the key argument', () => {
    const seen: string[] = []
    walkComponentRefs(ast('key(InBind.up) && pointer.x > 0'), (c, f) => seen.push(`${c}.${f}`))
    expect(seen).toEqual(['InBind.up'])
  })
})

describe('input forms: evaluator (§5.4)', () => {
  const base: EvalEnv = { resolveField: () => undefined, dt: 0, time: 0, rand: { uniform: () => 0 } }
  const env: EvalEnv = {
    ...base,
    input: {
      key: (n) => n === 'w',
      pressed: (n) => n === 'p',
      released: (n) => n === 'r',
      mod: (n) => n === 'alt',
      pointer: { x: 3, y: -4, buttons: 1, wheel: -2 },
    },
  }

  it('reads held, edge, modifier and pointer state', () => {
    expect(evaluate(ast('key("w")'), env)).toBe(true)
    expect(evaluate(ast('key("p")'), env)).toBe(false)
    expect(evaluate(ast('pressed("p") && released("r")'), env)).toBe(true)
    expect(evaluate(ast('mod("alt") && !mod("ctrl")'), env)).toBe(true)
    expect(evaluate(ast('pointer.x + pointer.y * 10 + pointer.buttons * 100 + pointer.wheel * 1000'), env)).toBe(-2000 + 100 - 40 + 3)
  })

  it('a missing input hook is "not available"; a non-string or unknown modifier is a type error', () => {
    expect(() => evaluate(ast('key("w")'), base)).toThrow(/not available/)
    expect(() => evaluate(ast('pointer.x'), base)).toThrow(/not available/)
    const nonString = { ...env, resolveField: () => 1 }
    expect(() => evaluate(ast('key(InBind.n)'), nonString)).toThrow(RuleEvalError)
    expect(() => evaluate(ast('key(InBind.n)'), nonString)).toThrow(/string/)
    const name = { ...env, resolveField: () => 'constructor' }
    expect(() => evaluate(ast('mod(InBind.up)'), name)).toThrow(/ctrl.*alt.*shift.*meta/)
  })
})

describe('input in rules (§5.4)', () => {
  it('held and edge reads follow setInput', () => {
    const w = world()
    const id = w.spawn([entry(Flags, FLAGS0), entry(Out, OUT0), entry(Bind, { up: 'ArrowUp', n: 1 })])
    const rules: RuleDef[] = [
      {
        name: 'flags', schedule: 'tick', query: ['InFlags', 'InBind'],
        actions: [
          { set: 'InFlags.held', expr: 'key(InBind.up)' },
          { set: 'InFlags.down', expr: 'pressed("ArrowUp")' },
          { set: 'InFlags.up', expr: 'released("ArrowUp")' },
          { set: 'InFlags.ctrl', expr: 'mod("ctrl")' },
        ],
      },
      {
        name: 'pointer', schedule: 'tick', query: ['InOut'],
        actions: [
          { set: 'InOut.a', expr: 'pointer.x' },
          { set: 'InOut.b', expr: 'pointer.y' },
          { set: 'InOut.c', expr: 'pointer.buttons' },
          { set: 'InOut.d', expr: 'pointer.wheel' },
          { set: 'InOut.e', expr: 'InOut.e + (pressed("Space") ? 1 : 0)' },
        ],
      },
    ]
    const errors = installRules(w, [], resolve).update(rules)
    expect([...errors]).toEqual([])
    const flags = () => ({ ...w.getComponent(id, Flags)! })
    const out = () => ({ ...w.getComponent(id, Out)! })

    w.stepOnce()
    expect(flags()).toEqual({ held: false, down: false, up: false, ctrl: false })

    w.setInput(input({ keys: ['ArrowUp', 'Space'], pressed: ['ArrowUp', 'Space'], mods: { ctrl: true }, pointer: { x: 12, y: 34, buttons: 2, wheel: 3 } }))
    w.stepOnce()
    expect(flags()).toEqual({ held: true, down: true, up: false, ctrl: true })
    expect(out()).toEqual({ a: 12, b: 34, c: 2, d: 3, e: 1 })

    w.setInput(input({ keys: ['ArrowUp'], released: ['Space'] }))
    w.stepOnce()
    expect(flags()).toEqual({ held: true, down: false, up: false, ctrl: false })
    expect(out()).toEqual({ a: 0, b: 0, c: 0, d: 0, e: 1 })

    w.setInput(input({ released: ['ArrowUp'] }))
    w.stepOnce()
    expect(flags()).toEqual({ held: false, down: false, up: true, ctrl: false })
  })

  it('an edge read (pressed, released, pointer.wheel) in a fixed rule is a compile error at the form', () => {
    const def = (when: string, expr: string): RuleDef => ({
      name: 'f', schedule: 'fixed', query: ['InOut'], when, actions: [{ set: 'InOut.a', expr }],
    })
    let r = compileRule(def('pressed("a")', '1'), resolve)
    expect(r.rule).toBeNull()
    expect(r.errors).toEqual([
      { rule: 'f', field: 'when', position: 0, message: expect.stringMatching(/pressed\(\).*fixed.*key\(\)/) },
    ])
    r = compileRule(def('true', '1 + (released("a") ? 1 : 0)'), resolve)
    expect(r.errors).toEqual([
      { rule: 'f', field: { action: 0, part: 'expr' }, position: 5, message: expect.stringMatching(/released\(\)/) },
    ])
    r = compileRule(def('true', 'pointer.wheel'), resolve)
    expect(r.errors).toEqual([
      { rule: 'f', field: { action: 0, part: 'expr' }, position: 0, message: expect.stringMatching(/pointer\.wheel/) },
    ])
    // Held state, modifiers and pointer position are fine in a fixed rule.
    expect(compileRule(def('key("a") && mod("shift")', 'pointer.x + pointer.y + pointer.buttons'), resolve).errors).toEqual([])
    // And edge reads are fine in a tick rule.
    expect(compileRule({ ...def('pressed("a")', 'pointer.wheel'), schedule: 'tick' }, resolve).errors).toEqual([])
  })

  it('certain type errors: a non-string key name, an unknown modifier', () => {
    const def = (expr: string): RuleDef => ({ name: 't', schedule: 'tick', query: ['InOut'], actions: [{ set: 'InOut.a', expr }] })
    expect(compileRule(def('key(1) ? 1 : 0'), resolve).errors).toEqual([
      { rule: 't', field: { action: 0, part: 'expr' }, position: 4, message: expect.stringMatching(/string.*key\(\)/) },
    ])
    expect(compileRule(def('mod("hyper") ? 1 : 0'), resolve).errors).toEqual([
      { rule: 't', field: { action: 0, part: 'expr' }, position: 4, message: expect.stringMatching(/ctrl.*alt.*shift.*meta/) },
    ])
    expect(compileRule(def('key("a") + 1'), resolve).errors).toEqual([
      { rule: 't', field: { action: 0, part: 'expr' }, position: 0, message: expect.stringMatching(/number.*boolean/) },
    ])
  })

  it('a non-string key name at run time faults the entity', () => {
    const w = world()
    const id = w.spawn([entry(Out, OUT0), entry(Bind, { up: 'w', n: 7 })])
    installRules(w, [{ name: 'k', schedule: 'tick', query: ['InOut', 'InBind'], actions: [{ set: 'InOut.a', expr: 'key(InBind.n) ? 1 : 2' }] }], resolve)
    w.stepOnce()
    expect(w.getComponent(id, Out)!.a).toBe(0)
    const fault = w.getComponent(id, Faulted)!.faults[0]!
    expect(fault).toMatchObject({ kind: 'rule_eval_failed', source: 'rule:k' })
    expect(JSON.stringify(fault.detail)).toMatch(/string for key\(\)/)
  })

  // Verify pass: a host that rebuilds InputSnapshots from JSON (an act log)
  // can hand setInput arrays or missing parts. That must be a fault on the
  // entity, like a non-number pointer field — never a TypeError thrown out
  // of the step.
  it('a malformed input snapshot faults the entity instead of throwing out of the step', () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ['key("a")', { ...input(), keys: ['a'] }, /input\.keys is not a Set/],
      ['pressed("a")', { ...input(), keyDelta: { pressed: ['a'], released: [] } }, /input\.keyDelta\.pressed is not a Set/],
      ['released("a")', { ...input(), keyDelta: undefined }, /input\.keyDelta\.released is not a Set/],
      ['mod("ctrl")', { ...input(), mods: undefined }, /input\.mods is not an object/],
      ['pointer.x > 0', { ...input(), pointer: undefined }, /input\.pointer is not an object/],
      ['key("a")', {}, /input\.keys is not a Set/],
      ['mod("shift")', undefined, /input\.mods is not an object/],
      ['pointer.wheel', null, /input\.pointer is not an object/],
    ]
    for (const [expr, snap, message] of cases) {
      const w = world()
      const id = w.spawn([entry(Out, OUT0)])
      installRules(w, [{ name: 'm', schedule: 'tick', query: ['InOut'], actions: [{ set: 'InOut.a', expr: `${expr} ? 1 : 2` }] }], resolve)
      w.setInput(snap as InputSnapshot)
      expect(() => w.stepOnce(), expr).not.toThrow()
      expect(w.getComponent(id, Out)!.a, expr).toBe(0)
      const fault = w.getComponent(id, Faulted)?.faults[0]
      expect(fault, expr).toMatchObject({ kind: 'rule_eval_failed', source: 'rule:m' })
      expect(JSON.stringify(fault!.detail), expr).toMatch(message)
    }
  })

  it('a malformed pointer from any EvalEnv host is a type error, not a TypeError', () => {
    const env = {
      resolveField: () => undefined, dt: 0, time: 0, rand: { uniform: () => 0 },
      input: { key: () => false, pressed: () => false, released: () => false, mod: () => false, pointer: undefined },
    } as unknown as EvalEnv
    expect(() => evaluate(ast('pointer.x'), env)).toThrow(RuleEvalError)
  })
})

describe('input in world expressions (§5.4)', () => {
  it('every input form is a compile error at its position', () => {
    for (const [source, pos] of [
      ['key("a") ? 1 : 0', 0],
      ['1 + (pressed("a") ? 1 : 0)', 5],
      ['released("a")', 0],
      ['mod("ctrl")', 0],
      ['tick + pointer.x', 7],
      ['pointer.wheel', 0],
    ] as const) {
      const r = compileWorldExpression(source, resolve)
      expect(r.expression, source).toBeNull()
      expect(r.errors, source).toEqual([{ rule: '<expr>', position: pos, message: expect.stringMatching(/input/) }])
    }
  })
})

describe('input determinism: live vs fork (§5.4 test 3)', () => {
  const RULES: RuleDef[] = [
    {
      name: 'steer', schedule: 'tick', rng: 'own', query: ['InBody'],
      actions: [
        { set: 'InBody.vx', expr: '(key("ArrowRight") ? 1 : 0) - (key("ArrowLeft") ? 1 : 0) + (mod("shift") ? random() : 0)' },
        { set: 'InBody.jumps', expr: 'InBody.jumps + (pressed("Space") ? 1 : 0) - (released("Space") ? 0.5 : 0)' },
      ],
    },
    {
      name: 'move', schedule: 'fixed', query: ['InBody'],
      actions: [{ set: 'InBody.x', expr: 'InBody.x + InBody.vx * dt + (key("KeyB") ? pointer.x * 0.01 : 0)' }],
    },
  ]
  const DT = [1, 1.5, 0.5, 2, 0.25, 1]

  function sequence(n: number): InputSnapshot[] {
    let s = 0x2545f491
    const next = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    const names = ['ArrowLeft', 'ArrowRight', 'Space', 'KeyB']
    const held = new Set<string>()
    const out: InputSnapshot[] = []
    for (let i = 0; i < n; i++) {
      const pressed: string[] = []
      const released: string[] = []
      for (const k of names) {
        if (next() < 0.2) {
          if (held.has(k)) {
            held.delete(k)
            released.push(k)
          } else {
            held.add(k)
            pressed.push(k)
          }
        }
      }
      out.push(input({ keys: [...held], pressed, released, mods: { shift: next() < 0.3 }, pointer: { x: Math.floor(next() * 400) } }))
    }
    return out
  }

  function build(): World {
    const w = world()
    for (let i = 0; i < 4; i++) w.spawn([entry(Body, { x: i, vx: 0, jumps: 0 })])
    const errors = installRules(w, [], resolve, { rng: 'own' }).update(RULES)
    expect([...errors]).toEqual([])
    return w
  }

  const strict = (w: World): string => hashSnapshot(w.snapshot({ pendingEvents: true }), { includeChanges: true })

  it('the same setInput sequence on live and on a fork restored mid-sequence gives equal strict hashes', () => {
    const inputs = sequence(120)
    const live = build()
    const fixed = live.time.fixedStep
    const apply = (w: World, i: number): void => {
      w.setInput(inputs[i]!)
      w.step(DT[i % DT.length]! * fixed)
    }
    const FORK_AT = 47
    for (let i = 0; i < FORK_AT; i++) apply(live, i)
    // Not vacuous: input moved the bodies and counted presses.
    const before = live.getComponent(live.listEntities([Body])[0]!, Body)!
    expect(before.x).not.toBe(0)
    expect(before.jumps).not.toBe(0)

    const fork = build()
    fork.restore(live.snapshot({ pendingEvents: true }))
    expect(strict(fork)).toBe(strict(live))
    for (let i = FORK_AT; i < inputs.length; i++) {
      apply(live, i)
      apply(fork, i)
      expect(strict(fork), `tick ${i}`).toBe(strict(live))
    }
    // A different input sequence diverges (the hashes really see input).
    const other = build()
    for (let i = 0; i < inputs.length; i++) {
      other.setInput(inputs[(i + 1) % inputs.length]!)
      other.step(DT[i % DT.length]! * fixed)
    }
    expect(strict(other)).not.toBe(strict(live))
  })
})
