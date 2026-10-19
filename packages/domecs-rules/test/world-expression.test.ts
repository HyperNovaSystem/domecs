import { describe, expect, it } from 'vitest'
import {
  createWorld,
  defineComponent,
  dmath,
  entry,
  hashSnapshot,
  type ComponentType,
  type World,
} from '@domecs/core'
import * as v8 from 'node:v8'
import * as vm from 'node:vm'
import { compileWorldExpression, type WorldExpression } from '../src/world-expression.js'
import { installRules, type RuleError } from '../src/index.js'

// Spec §5.3 (G13, O-83), plan E11.1: expressions with no evaluated entity,
// for metrics, probes and outcomes. Read-only: they never mutate the world,
// draw randomness or move change windows.

const Pos = defineComponent<{ x: number; y: number }>('WxPos', { defaults: { x: 0, y: 0 } })
const Player = defineComponent<Record<string, never>>('WxPlayer', { defaults: {} })
const Enemy = defineComponent<Record<string, never>>('WxEnemy', { defaults: {} })
const Coin = defineComponent<Record<string, never>>('WxCoin', { defaults: {} })
const Hp = defineComponent<{ hp: number }>('WxHp', { defaults: { hp: 10 } })
const Name = defineComponent<{ label: string }>('WxName', { defaults: { label: '' } })
const Loose = defineComponent<{ v?: unknown }>('WxLoose')
// Known to `resolve` but never added to any world in these tests.
const Ghost = defineComponent<{ g: number }>('WxGhost', { defaults: { g: 1 } })

const TYPES: ComponentType<any>[] = [Pos, Player, Enemy, Coin, Hp, Name, Loose, Ghost]
const resolve = (name: string): ComponentType<any> | undefined => TYPES.find((t) => t.name === name)
const SPATIAL = { spatial: { component: 'WxPos', cellSize: 8 } } as const

function world(): World {
  return createWorld({ headless: true, seed: [1, 2, 3, 4] })
}

function compile(source: string, options: Parameters<typeof compileWorldExpression>[2] = SPATIAL): WorldExpression {
  const r = compileWorldExpression(source, resolve, options)
  if (r.expression === null) throw new Error(`compile failed: ${JSON.stringify(r.errors)}`)
  return r.expression
}

function errorsOf(source: string, options: Parameters<typeof compileWorldExpression>[2] = SPATIAL): RuleError[] {
  const r = compileWorldExpression(source, resolve, options)
  expect(r.expression).toBeNull()
  return r.errors
}

function value(w: World, source: string): unknown {
  const r = compile(source).evaluate(w)
  if (!r.ok) throw new Error(`evaluate failed: ${r.error.message}`)
  return r.value
}

/** mulberry32 for test inputs. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000
  }
}

interface Arena {
  w: World
  player: number
  enemies: Array<{ id: number; x: number; y: number; hp: number }>
}

/** A player at (3, -2) and 60 enemies scattered over [-100, 100)² with integer coordinates (ties). */
function arena(seed = 7): Arena {
  const w = world()
  const r = rng(seed)
  const enemies: Arena['enemies'] = []
  for (let i = 0; i < 30; i++) {
    const x = Math.floor(r() * 200) - 100
    const y = Math.floor(r() * 200) - 100
    const hp = Math.floor(r() * 50)
    enemies.push({ id: w.spawn([entry(Enemy, {}), entry(Pos, { x, y }), entry(Hp, { hp })]), x, y, hp })
  }
  const player = w.spawn([entry(Player, {}), entry(Pos, { x: 3, y: -2 }), entry(Hp, { hp: 99 })])
  for (let i = 0; i < 30; i++) {
    const x = Math.floor(r() * 200) - 100
    const y = Math.floor(r() * 200) - 100
    const hp = Math.floor(r() * 50)
    enemies.push({ id: w.spawn([entry(Enemy, {}), entry(Pos, { x, y }), entry(Hp, { hp })]), x, y, hp })
  }
  return { w, player, enemies }
}

describe('E11.1 compile: forms with no entity are rejected with positions', () => {
  const cases: Array<[string, number, RegExp]> = [
    ['WxHp.hp + 1', 0, /no entity in a world expression/i],
    ['1 + WxHp.hp', 4, /no entity in a world expression/i],
    ['1 + self.WxHp.hp', 4, /self/],
    ['self.id', 0, /self/],
    ['has(WxEnemy)', 0, /has\(/],
    ['has(self, WxEnemy)', 4, /self/],
    ['distanceTo(first(WxPlayer))', 0, /distanceTo/],
    ['countWithin(WxEnemy, 40)', 0, /countWithin/],
    ['countWithin(WxEnemy, 40, self)', 25, /self/],
    ['nearest(WxEnemy).id', 0, /nearest/],
    ['first(WxPlayer).WxPos.x + dt', 26, /dt/],
    ['random() < 0.5', 0, /random\(\)/],
    ['2 * random()', 4, /random\(\)/],
    ['entity(first(WxPlayer).id).WxHp.hp ?? WxHp.hp', 38, /no entity/i],
    // 2.3 (§6.1): payload reads and `other` exist only in event rules.
    ['1 + event.dx', 4, /event rule/],
    ['other.WxHp.hp', 0, /other/],
    ['has(other, WxHp)', 4, /other/],
  ]
  for (const [source, position, message] of cases) {
    it(`${source} → error at ${position}`, () => {
      const errors = errorsOf(source)
      expect(errors).toHaveLength(1)
      expect(errors[0]!.position).toBe(position)
      expect(errors[0]!.message).toMatch(message)
      expect(errors[0]!.rule).toBe('<expr>')
    })
  }

  it('reports every rejected form, in source order', () => {
    const errors = errorsOf('dt + random() + WxHp.hp')
    expect(errors.map((e) => e.position)).toEqual([0, 5, 16])
  })

  it('the bare-field message points at first(S)', () => {
    expect(errorsOf('WxHp.hp')[0]!.message).toMatch(/first\(S\)/)
  })

  it('parse errors keep their position', () => {
    const errors = errorsOf('1 +')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.position).toBe(3)
  })

  it('unknown components are errors at the referencing token', () => {
    const errors = errorsOf('count(WxNope) + 1')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.position).toBe(0)
    expect(errors[0]!.message).toMatch(/Unknown component "WxNope"/)
    expect(errorsOf('first(WxPlayer).WxNope.x')[0]!.message).toMatch(/WxNope/)
  })

  it('countWithin with a centre needs the spatial option', () => {
    const errors = errorsOf('countWithin(WxEnemy, 40, first(WxPlayer))', {})
    expect(errors).toHaveLength(1)
    expect(errors[0]!.position).toBe(0)
    expect(errors[0]!.message).toMatch(/spatial/)
    expect(errorsOf('countWithin(WxEnemy, 40, first(WxPlayer))', { spatial: { component: 'WxNope' } })[0]!.message).toMatch(
      /WxNope/,
    )
  })

  it('certain type errors and forbidden fields are rejected', () => {
    expect(errorsOf('"a" + 1')[0]!.position).toBe(0)
    expect(errorsOf('first(WxPlayer).WxPos.__proto__')[0]!.message).toMatch(/not allowed/)
  })

  it('a clean expression keeps its source and AST', () => {
    const r = compileWorldExpression('count(WxEnemy) + tick', resolve)
    expect(r.errors).toEqual([])
    expect(r.expression!.source).toBe('count(WxEnemy) + tick')
    expect(r.expression!.ast.kind).toBe('binary')
  })
})

describe('E11.1 evaluate: values match JS oracles', () => {
  it('countWithin(Enemy, r, first(Player)) equals a brute-force count', () => {
    const { w, enemies } = arena()
    for (const r of [0, 1, 5, 17, 40, 41.5, 99, 300, -1]) {
      const got = value(w, `countWithin(WxEnemy, ${r < 0 ? `-${-r}` : r}, first(WxPlayer))`)
      // Same distance test as the grid: squared distance against r².
      const exact = enemies.filter((e) => r >= 0 && (e.x - 3) ** 2 + (e.y + 2) ** 2 <= r * r).length
      expect(got).toBe(exact)
    }
  })

  it('the centre is excluded from its own countWithin', () => {
    const { w, enemies } = arena()
    const first = enemies.reduce((a, b) => (a.id < b.id ? a : b))
    const exact = enemies.filter((e) => e.id !== first.id && (e.x - first.x) ** 2 + (e.y - first.y) ** 2 <= 30 * 30).length
    expect(value(w, 'countWithin(WxEnemy, 30, first(WxEnemy))')).toBe(exact)
  })

  it('aggregates, selectors and has', () => {
    const { w, player, enemies } = arena()
    const hps = enemies.map((e) => e.hp)
    const sum = hps.reduce((a, b) => a + b, 0)
    expect(value(w, 'count(WxEnemy)')).toBe(60)
    expect(value(w, 'exists(WxEnemy)')).toBe(true)
    expect(value(w, 'exists(WxCoin)')).toBe(false)
    expect(value(w, 'sum(WxEnemy, WxHp.hp)')).toBe(enemies.reduce((a, e) => a + e.hp, 0))
    expect(value(w, 'avg(WxEnemy, WxHp.hp)')).toBe(
      [...enemies].sort((a, b) => a.id - b.id).reduce((a, e) => a + e.hp, 0) / 60,
    )
    expect(value(w, 'minOf(WxEnemy, WxHp.hp)')).toBe(Math.min(...hps))
    expect(value(w, 'maxOf(WxEnemy, WxHp.hp)')).toBe(Math.max(...hps))
    expect(value(w, 'sum(WxHp, WxHp.hp)')).toBe(sum + 99)
    expect(value(w, 'first(WxPlayer).WxPos.x')).toBe(3)
    expect(value(w, 'first(WxPlayer).id')).toBe(player)
    const lowest = Math.min(...enemies.map((e) => e.id))
    expect(value(w, 'first(WxEnemy).id')).toBe(lowest)
    expect(value(w, `entity(${enemies[5]!.id}).WxHp.hp`)).toBe(enemies[5]!.hp)
    expect(value(w, 'has(first(WxPlayer), WxHp)')).toBe(true)
    expect(value(w, 'has(first(WxPlayer), WxEnemy)')).toBe(false)
    expect(value(w, 'count(WxGhost)')).toBe(0)
  })

  it('math matches dmath / Math bit for bit', () => {
    const { w } = arena()
    const e = w.listEntities([Enemy])[0]!
    const p = w.getComponent(e, Pos)!
    expect(Object.is(value(w, 'atan2(first(WxEnemy).WxPos.y, first(WxEnemy).WxPos.x)'), dmath.atan2(p.y, p.x))).toBe(true)
    expect(Object.is(value(w, 'hypot(first(WxEnemy).WxPos.y, 3)'), dmath.hypot(p.y, 3))).toBe(true)
    expect(Object.is(value(w, 'sin(first(WxPlayer).WxPos.x)'), dmath.sin(3))).toBe(true)
    expect(value(w, 'distance(0, 0, first(WxPlayer).WxPos.x, first(WxPlayer).WxPos.y)')).toBe(Math.sqrt(13))
  })

  it('time is world.time.elapsed and tick is world.time.tick', () => {
    const w = world()
    for (let i = 0; i < 5; i++) w.step(w.time.fixedStep)
    w.stepOnce()
    expect(value(w, 'time')).toBe(w.time.elapsed)
    expect(value(w, 'tick')).toBe(w.time.tick)
    expect(value(w, 'tick > 0')).toBe(true)
  })

  it('string and boolean results', () => {
    const w = world()
    w.spawn([entry(Player, {}), entry(Name, { label: 'ada' })])
    expect(value(w, 'first(WxPlayer).WxName.label')).toBe('ada')
    expect(value(w, 'first(WxPlayer).WxName.label == "ada" && exists(WxPlayer)')).toBe(true)
  })

  it('reads see the world as it is at each call', () => {
    const w = world()
    const e = w.spawn([entry(Enemy, {}), entry(Hp, { hp: 1 })])
    const expr = compile('sum(WxEnemy, WxHp.hp)')
    expect(expr.evaluate(w)).toEqual({ ok: true, value: 1 })
    w.getComponent(e, Hp)!.hp = 5
    w.markChanged(e, Hp)
    w.spawn([entry(Enemy, {}), entry(Hp, { hp: 2 })])
    expect(expr.evaluate(w)).toEqual({ ok: true, value: 7 })
    w.despawn(e)
    expect(expr.evaluate(w)).toEqual({ ok: true, value: 2 })
  })

  it('one expression evaluates against several worlds', () => {
    const a = arena(1)
    const b = arena(2)
    const expr = compile('countWithin(WxEnemy, 50, first(WxPlayer))')
    const oracle = (x: Arena): number => x.enemies.filter((e) => (e.x - 3) ** 2 + (e.y + 2) ** 2 <= 2500).length
    expect(expr.evaluate(a.w)).toEqual({ ok: true, value: oracle(a) })
    expect(expr.evaluate(b.w)).toEqual({ ok: true, value: oracle(b) })
  })
})

describe('E11.1 determinism: evaluation never changes the world', () => {
  it('the strict hash is unchanged after 1000 evaluations, and the future is the same', () => {
    const make = (): World => {
      const { w } = arena()
      installRules(
        w,
        [
          {
            name: 'jitter',
            schedule: 'tick',
            rng: 'own',
            query: ['WxEnemy', 'WxPos'],
            actions: [{ set: 'WxPos.x', expr: 'WxPos.x + random() - 0.5' }],
          },
          { name: 'shared', schedule: 'tick', query: ['WxPlayer', 'WxPos'], actions: [{ set: 'WxPos.y', expr: 'WxPos.y + random()' }] },
        ],
        resolve,
      )
      w.stepOnce()
      return w
    }
    const measured = make()
    const twin = make()
    const strict = (w: World): string => hashSnapshot(w.snapshot({}), { includeChanges: true })
    const before = strict(measured)
    expect(before).toBe(strict(twin))
    const metrics = [
      'countWithin(WxEnemy, 40, first(WxPlayer))',
      'sum(WxEnemy, WxHp.hp) / max(1, count(WxEnemy))',
      'first(WxPlayer).WxPos.y ?? 0',
      'avg(WxCoin, WxHp.hp) ?? -1',
      'has(first(WxPlayer), WxGhost) || count(WxGhost) > 0 || exists(WxLoose)',
      'entity(9999).WxHp.hp ?? tick + time',
    ].map((s) => compile(s))
    for (let i = 0; i < 1000; i++) for (const m of metrics) m.evaluate(measured)
    expect(strict(measured)).toBe(before)
    // Types the world had never seen stay unknown to it.
    expect(measured.lookupComponent('WxGhost')).toBeUndefined()
    expect(measured.lookupComponent('WxLoose')).toBeUndefined()
    for (let i = 0; i < 10; i++) {
      measured.stepOnce()
      twin.stepOnce()
    }
    expect(strict(measured)).toBe(strict(twin))
  })
})

describe('E11.1 ?? and no-value errors', () => {
  it('?? catches no value', () => {
    const { w } = arena()
    expect(value(w, 'first(WxCoin).WxHp.hp ?? -1')).toBe(-1)
    expect(value(w, 'avg(WxCoin, WxHp.hp) ?? 0')).toBe(0)
    expect(value(w, 'entity(123456).WxHp.hp ?? 7')).toBe(7)
    expect(value(w, 'first(WxPlayer).WxHp.hp ?? 0')).toBe(99)
    expect(value(w, 'countWithin(WxEnemy, 10, first(WxCoin)) ?? -2')).toBe(-2)
  })

  it('no value without ?? is a rule_eval_failed error', () => {
    const { w } = arena()
    const r = compile('first(WxCoin).WxHp.hp + 1').evaluate(w)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('rule_eval_failed')
    expect(r.error.rule).toBe('<expr>')
    expect(r.error.message).toMatch(/first\(WxCoin\)/)
  })

  it('?? does not catch type errors', () => {
    const w = world()
    w.spawn([entry(Player, {}), entry(Name, { label: 'x' })])
    const r = compile('(first(WxPlayer).WxName.label + 1) ?? 0').evaluate(w)
    expect(r.ok).toBe(false)
  })
})

describe('E11.1 errors are data: no throws for bad input', () => {
  it('compile never throws on arbitrary strings', () => {
    const r = rng(42)
    const alphabet = ['WxHp', 'WxPos', '.', 'hp', 'x', 'first(', 'count(', 'self', 'dt', 'random()', '(', ')', ',', '+', '??',
      '1', '"s"', 'has(', 'nearest(', 'countWithin(', 'distanceTo(', 'entity(', ' ', '!', '?', ':', 'WxEnemy', 'id', 'tick', 'sum(']
    for (let i = 0; i < 2000; i++) {
      let s = ''
      const n = Math.floor(r() * 12)
      for (let j = 0; j < n; j++) s += alphabet[Math.floor(r() * alphabet.length)]
      const out = compileWorldExpression(s, resolve, SPATIAL)
      if (out.expression === null) {
        expect(out.errors.length).toBeGreaterThan(0)
        for (const e of out.errors) expect(typeof e.position).toBe('number')
      } else {
        const v = out.expression.evaluate(arena(i % 3).w)
        expect(typeof v.ok).toBe('boolean')
      }
    }
  })

  it('non-string sources and over-long sources are errors', () => {
    expect(compileWorldExpression(undefined as unknown as string, resolve).expression).toBeNull()
    expect(compileWorldExpression(42 as unknown as string, resolve).expression).toBeNull()
    expect(compileWorldExpression('1+'.repeat(20_000) + '1', resolve).expression).toBeNull()
  })

  it('odd field values give errors, not throws or non-primitive results', () => {
    const w = world()
    w.spawn([entry(Player, {}), entry(Loose, { v: { nested: 1 } })])
    w.spawn([entry(Coin, {}), entry(Loose, { v: 10n })])
    w.spawn([entry(Enemy, {}), entry(Loose, { v: Symbol('s') })])
    for (const s of [
      'first(WxPlayer).WxLoose.v',
      'first(WxPlayer).WxLoose.v + 1',
      'first(WxCoin).WxLoose.v * 2',
      'first(WxEnemy).WxLoose.v',
      '-first(WxEnemy).WxLoose.v',
      'sum(WxLoose, WxLoose.v)',
      'first(WxPlayer).WxLoose.v ?? 0',
    ]) {
      const r = compile(s).evaluate(w)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.kind).toBe('rule_eval_failed')
    }
  })

  it('a world holding a different component under the same name gives an error', () => {
    const w = world()
    const Other = defineComponent<{ hp: number }>('WxHp', { defaults: { hp: 3 } })
    w.spawn([entry(Other, { hp: 3 })])
    const before = hashSnapshot(w.snapshot({}), { includeChanges: true })
    const r = compile('sum(WxHp, WxHp.hp)').evaluate(w)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/different/)
    expect(hashSnapshot(w.snapshot({}), { includeChanges: true })).toBe(before)
  })

  it('non-finite positions have no position', () => {
    const w = world()
    w.spawn([entry(Player, {}), entry(Pos, { x: Number.NaN, y: 0 })])
    w.spawn([entry(Enemy, {}), entry(Pos, { x: 0, y: 0 })])
    expect(value(w, 'countWithin(WxEnemy, 10, first(WxPlayer)) ?? -1')).toBe(-1)
  })
})

describe('E11 verify: read-only beyond the hash, and nothing retained', () => {
  it('a type the world registered but no entity holds is not given a store (describe is unchanged)', () => {
    // After a restore the registry keeps every type, but stores exist only
    // for types some restored entity holds. A core read (`has`,
    // `getComponent`) of a store-less type would create an empty store,
    // which describe().componentCounts shows.
    const w = world()
    w.spawn([entry(Player, {}), entry(Pos, { x: 0, y: 0 })])
    const gone = w.spawn([entry(Enemy, {}), entry(Hp, { hp: 1 }), entry(Name, { label: 'x' })])
    w.despawn(gone)
    w.restore(w.snapshot({}))
    expect(w.lookupComponent('WxHp')).toBe(Hp)
    const counts = (): string => JSON.stringify(w.describe().componentCounts)
    const before = counts()
    const strict = hashSnapshot(w.snapshot({}), { includeChanges: true })
    for (const s of [
      'has(first(WxPlayer), WxHp)',
      'first(WxPlayer).WxHp.hp ?? 1',
      'first(WxPlayer).WxName.label ?? ""',
      'count(WxEnemy) + sum(WxEnemy, WxHp.hp)',
    ]) {
      expect(compile(s).evaluate(w).ok).toBe(true)
    }
    expect(value(w, 'has(first(WxPlayer), WxHp)')).toBe(false)
    expect(counts()).toBe(before)
    expect(hashSnapshot(w.snapshot({}), { includeChanges: true })).toBe(strict)
  })

  it('the spatial component, registered but held by no entity, is not given a store either', () => {
    const w = world()
    w.spawn([entry(Player, {}), entry(Hp, { hp: 1 })])
    w.despawn(w.spawn([entry(Pos, { x: 0, y: 0 })]))
    w.restore(w.snapshot({}))
    const before = JSON.stringify(w.describe().componentCounts)
    expect(value(w, 'countWithin(WxHp, 5, first(WxPlayer)) ?? -1')).toBe(-1)
    expect(JSON.stringify(w.describe().componentCounts)).toBe(before)
  })

  it('a snapshot restored into a fresh world measures the same as its source', () => {
    // The fresh world has never registered the types: its stores hold the
    // restored data by name until something attaches a type object.
    const { w } = arena()
    const fresh = world()
    fresh.restore(w.snapshot({}))
    expect(fresh.lookupComponent('WxEnemy')).toBeUndefined()
    for (const s of [
      'count(WxEnemy)',
      'sum(WxEnemy, WxHp.hp)',
      'first(WxPlayer).WxHp.hp',
      'has(first(WxPlayer), WxPos)',
      'countWithin(WxEnemy, 40, first(WxPlayer))',
      'count(WxGhost)',
    ]) {
      expect(compile(s).evaluate(fresh)).toEqual(compile(s).evaluate(w))
    }
    expect(hashSnapshot(fresh.snapshot({}), { includeChanges: true })).toBe(hashSnapshot(w.snapshot({}), { includeChanges: true }))
    // A type no entity holds is still not registered by a read.
    expect(fresh.lookupComponent('WxGhost')).toBeUndefined()
  })

  it('an expression does not keep the last world it measured alive', async () => {
    v8.setFlagsFromString('--expose_gc')
    const gc = vm.runInNewContext('gc') as () => void
    const metrics = ['count(WxEnemy)', 'sum(WxEnemy, WxHp.hp)', 'countWithin(WxEnemy, 40, first(WxPlayer))'].map((s) => compile(s))
    const refs: Array<WeakRef<World>> = []
    ;(() => {
      const { w } = arena()
      for (const m of metrics) expect(m.evaluate(w).ok).toBe(true)
      refs.push(new WeakRef(w))
    })()
    for (let i = 0; i < 6 && refs[0]!.deref() !== undefined; i++) {
      await new Promise((r) => setTimeout(r, 5))
      gc()
    }
    expect(refs[0]!.deref()).toBeUndefined()
  })

  it('a non-finite result is an error value; non-finite intermediates are fine', () => {
    const w = world()
    w.spawn([entry(Player, {}), entry(Hp, { hp: 0 })])
    for (const s of ['1 / 0', '-1 / 0', '0 / 0', 'sqrt(-1)', 'count(WxEnemy) / count(WxEnemy)', '1 / first(WxPlayer).WxHp.hp']) {
      const r = compile(s).evaluate(w)
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error.kind).toBe('rule_eval_failed')
        expect(r.error.message).toMatch(/finite/)
      }
    }
    expect(value(w, '1 / 0 > 5')).toBe(true)
    expect(value(w, 'count(WxEnemy) > 0 ? 1 / count(WxEnemy) : 0')).toBe(0)
  })
})
