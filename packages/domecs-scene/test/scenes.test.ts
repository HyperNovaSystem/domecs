import { describe, expect, it } from 'vitest'
import { And, createWorld, defineComponent, defineEvent, entry, hashSnapshot } from '@domecs/core'
import { installRules, type RuleDef } from '@domecs/rules'
import type { ComponentType, Entity, World } from '@domecs/core'
import { Parent, ancestorsOf, installHierarchy, setParent } from '../src/index.js'
import {
  SceneMember,
  instantiateScene,
  sceneEntities,
  unloadScene,
  type InstantiateSceneOptions,
  type SceneData,
  type SceneEntityData,
} from '../src/index.js'

// Spec §7.3 (G14, O-13), plan E21: scenes as data. instantiateScene spawns
// in array order (deterministic ids), links parents by key, remaps refFields
// from keys to live ids and reports every problem instead of throwing.

const Pos = defineComponent<{ x: number; y: number }>('ScPos', { defaults: { x: 0, y: 0 } })
const Hp = defineComponent<{ hp: number; max: number }>('ScHp', { defaults: { hp: 10, max: 10 } })
const Target = defineComponent<{ entity: Entity | string | null }>('ScTarget', { defaults: { entity: null } })
const Bag = defineComponent<{ items: string[] }>('ScBag', { defaults: { items: [] } })
const Checked = defineComponent<{ n: number }>('ScChecked', {
  defaults: { n: 0 },
  validate: (v) => (v.n >= 0 ? true : 'n must be >= 0'),
})

const types: ComponentType<any>[] = [Pos, Hp, Target, Bag, Checked]
const resolve = (name: string): ComponentType<any> | undefined => types.find((t) => t.name === name)
const opts: InstantiateSceneOptions = { resolve }

const fresh = (): World => createWorld({ headless: true, seed: [1, 2, 3, 4] })

const level: SceneData = {
  name: 'level1',
  entities: [
    { key: 'root', components: { ScPos: { x: 1 } } },
    { key: 'hero', components: { ScPos: { x: 2, y: 3 }, ScHp: { hp: 7 } }, parent: 'root' },
    { key: 'sword', components: { ScBag: { items: ['a', 'b'] } }, parent: 'hero' },
    { key: 'orc', components: { ScHp: {}, ScTarget: { entity: 'hero' } } },
  ],
}

describe('instantiateScene (E21.1)', () => {
  it('test 1: ids are deterministic (array order; same data, same ids in two worlds)', () => {
    const a = fresh()
    const b = fresh()
    // The same prior state in both worlds.
    a.spawn([entry(Pos, { x: 9, y: 9 })])
    b.spawn([entry(Pos, { x: 9, y: 9 })])
    const ra = instantiateScene(a, level, opts)
    const rb = instantiateScene(b, level, opts)
    expect(ra.problems).toEqual([])
    expect([...ra.ids]).toEqual([...rb.ids])
    expect([...ra.ids.keys()]).toEqual(['root', 'hero', 'sword', 'orc'])
    const ids = [...ra.ids.values()]
    expect(ids).toEqual([...ids].sort((x, y) => x - y)) // spawned in array order
    expect(hashSnapshot(a.snapshot(), { includeChanges: true })).toBe(hashSnapshot(b.snapshot(), { includeChanges: true }))
  })

  it('test 1: each spawn carries SceneMember{scene, key} and defaults plus the given fields', () => {
    const w = fresh()
    const { ids } = instantiateScene(w, level, opts)
    const hero = ids.get('hero')!
    expect(w.getComponent(hero, SceneMember)).toEqual({ scene: 'level1', key: 'hero' })
    expect(w.getComponent(hero, Pos)).toEqual({ x: 2, y: 3 })
    expect(w.getComponent(hero, Hp)).toEqual({ hp: 7, max: 10 })
    expect(w.getComponent(ids.get('root')!, Pos)).toEqual({ x: 1, y: 0 })
    expect(w.getComponent(ids.get('orc')!, Hp)).toEqual({ hp: 10, max: 10 })
    expect(w.getComponent(ids.get('root')!, Parent)).toBeUndefined()
  })

  it('values are copies: two instantiations never share nested data with each other or with the data', () => {
    const w = fresh()
    const first = instantiateScene(w, level, opts).ids.get('sword')!
    const second = instantiateScene(w, level, opts).ids.get('sword')!
    const bag = w.getComponent(first, Bag)!
    bag.items.push('c')
    expect(w.getComponent(second, Bag)!.items).toEqual(['a', 'b'])
    expect((level.entities[2]!.components.ScBag as { items: string[] }).items).toEqual(['a', 'b'])
  })

  it('SceneMember is schema\'d and persistent', () => {
    const w = fresh()
    const d = w.describeComponent(SceneMember)
    expect(d.transient).toBe(false)
    expect(d.fieldsSource).toBe('schema')
    expect(Object.keys(d.fields)).toEqual(['scene', 'key'])
    expect(d.fields.scene!.kind).toBe('string')
    expect(d.fields.key!.kind).toBe('string')
  })

  it('test 2: parent keys become setParent links', () => {
    const w = fresh()
    const { ids, problems } = instantiateScene(w, level, opts)
    expect(problems).toEqual([])
    expect(w.getComponent(ids.get('hero')!, Parent)).toEqual({ entity: ids.get('root') })
    expect(ancestorsOf(w, ids.get('sword')!)).toEqual([ids.get('hero'), ids.get('root')])
    expect(w.getComponent(ids.get('orc')!, Parent)).toBeUndefined()
  })

  it('test 2: a parent defined later in the array still links (parents run after every spawn)', () => {
    const w = fresh()
    const { ids, problems } = instantiateScene(
      w,
      { name: 's', entities: [{ key: 'child', components: {}, parent: 'late' }, { key: 'late', components: {} }] },
      opts,
    )
    expect(problems).toEqual([])
    expect(w.getComponent(ids.get('child')!, Parent)).toEqual({ entity: ids.get('late') })
  })

  it('test 2: a cycle, a self-parent and a missing key are problems with paths, never throws', () => {
    const w = fresh()
    const data: SceneData = {
      name: 's',
      entities: [
        { key: 'x', components: {}, parent: 'y' },
        { key: 'y', components: {}, parent: 'x' },
        { key: 'z', components: {}, parent: 'z' },
        { key: 'm', components: {}, parent: 'nope' },
        { key: 'n', components: {}, parent: null },
      ],
    }
    let result!: ReturnType<typeof instantiateScene>
    expect(() => {
      result = instantiateScene(w, data, opts)
    }).not.toThrow()
    const { ids, problems } = result
    expect(ids.size).toBe(5)
    expect(problems.map((p) => p.path)).toEqual(['entities[1].parent', 'entities[2].parent', 'entities[3].parent'])
    expect(problems[0]!.message).toMatch(/cycle/)
    expect(problems[1]!.message).toMatch(/own parent/)
    expect(problems[2]!.message).toMatch(/"nope"/)
    // x got its parent; y, z, m stay roots.
    expect(w.getComponent(ids.get('x')!, Parent)).toEqual({ entity: ids.get('y') })
    for (const k of ['y', 'z', 'm', 'n']) expect(w.getComponent(ids.get(k)!, Parent)).toBeUndefined()
  })

  it('test 3: refFields remap string keys to live ids; an unknown key is a problem and the field is left unchanged', () => {
    const w = fresh()
    const data: SceneData = {
      name: 's',
      entities: [
        { key: 'a', components: { ScTarget: { entity: 'b' } } },
        { key: 'b', components: { ScTarget: { entity: 'zzz' } } },
        { key: 'c', components: { ScTarget: { entity: null } } },
        { key: 'd', components: { ScTarget: {} } },
        { key: 'e', components: { ScPos: {} } },
      ],
    }
    const { ids, problems } = instantiateScene(w, data, { resolve, refFields: [['ScTarget', 'entity']] })
    expect(w.getComponent(ids.get('a')!, Target)).toEqual({ entity: ids.get('b') })
    expect(w.getComponent(ids.get('b')!, Target)).toEqual({ entity: 'zzz' })
    expect(w.getComponent(ids.get('c')!, Target)).toEqual({ entity: null })
    expect(w.getComponent(ids.get('d')!, Target)).toEqual({ entity: null })
    expect(problems).toEqual([
      { path: 'entities[1].components.ScTarget.entity', message: expect.stringMatching(/"zzz"/) },
    ])
  })

  it('test 3: without refFields a key string is left as authored', () => {
    const w = fresh()
    const { ids, problems } = instantiateScene(w, level, opts)
    expect(problems).toEqual([])
    expect(w.getComponent(ids.get('orc')!, Target)).toEqual({ entity: 'hero' })
  })

  it('test 3: a remapped field is marked changed', () => {
    const w = fresh()
    const seen: Entity[] = []
    w.system('watch', { schedule: 'tick', query: [Target] }, (ctx) => {
      for (const e of ctx.entities) seen.push(e.id)
    })
    w.stepOnce()
    const { ids } = instantiateScene(w, level, { resolve, refFields: [['ScTarget', 'entity']] })
    expect(w.getComponent(ids.get('orc')!, Target)).toEqual({ entity: ids.get('hero') })
    w.stepOnce()
    expect(seen).toContain(ids.get('orc'))
  })

  it('test 4: an unknown component name is a problem; the component is skipped and the entity still spawns', () => {
    const w = fresh()
    const { ids, problems } = instantiateScene(
      w,
      { name: 's', entities: [{ key: 'a', components: { ScPos: { x: 4 }, Bogus: { q: 1 }, ScHp: {} } }] },
      opts,
    )
    expect(problems).toEqual([{ path: 'entities[0].components.Bogus', message: expect.stringMatching(/unknown component/) }])
    const a = ids.get('a')!
    expect(w.isAlive(a)).toBe(true)
    expect(w.archetype(a).map((t) => t.name).sort()).toEqual(['ScHp', 'ScPos', 'SceneMember'])
  })

  it('test 4: a duplicate key is a problem and the second entity spawns as key#2', () => {
    const w = fresh()
    const { ids, problems } = instantiateScene(
      w,
      {
        name: 's',
        entities: [
          { key: 'a', components: {} },
          { key: 'a', components: {} },
          { key: 'a', components: {} },
          { key: 'c', components: { ScTarget: { entity: 'a' } }, parent: 'a' },
        ],
      },
      { resolve, refFields: [['ScTarget', 'entity']] },
    )
    expect(problems.map((p) => p.path)).toEqual(['entities[1].key', 'entities[2].key'])
    expect(problems[0]!.message).toMatch(/duplicate key "a".*"a#2"/)
    expect([...ids.keys()]).toEqual(['a', 'a#2', 'a#3', 'c'])
    expect(w.getComponent(ids.get('a#2')!, SceneMember)).toEqual({ scene: 's', key: 'a#2' })
    // Keys in the data name the first holder.
    expect(w.getComponent(ids.get('c')!, Parent)).toEqual({ entity: ids.get('a') })
    expect(w.getComponent(ids.get('c')!, Target)).toEqual({ entity: ids.get('a') })
  })

  it('a suffix never takes an authored key, even one later in the array; references name the authored holder', () => {
    const w = fresh()
    const { ids, problems } = instantiateScene(
      w,
      {
        name: 's',
        entities: [
          { key: 'a', components: {} },
          { key: 'a', components: {} },
          { key: 'a#2', components: {} },
          { key: 'c', components: { ScTarget: { entity: 'a#2' } }, parent: 'a#2' },
        ],
      },
      { resolve, refFields: [['ScTarget', 'entity']] },
    )
    // Only the real duplicate is a problem; the authored "a#2" keeps its key.
    expect(problems).toEqual([{ path: 'entities[1].key', message: expect.stringMatching(/duplicate key "a".*"a#3"/) }])
    expect([...ids.keys()]).toEqual(['a', 'a#3', 'a#2', 'c'])
    const authored = ids.get('a#2')!
    expect(w.getComponent(authored, SceneMember)).toEqual({ scene: 's', key: 'a#2' })
    expect(w.getComponent(ids.get('c')!, Parent)).toEqual({ entity: authored })
    expect(w.getComponent(ids.get('c')!, Target)).toEqual({ entity: authored })
  })

  it('the #<index> fallback for a bad key never replaces another entry in ids', () => {
    const w = fresh()
    const data = {
      name: 's',
      entities: [
        { key: '#1', components: {} },
        { key: 5, components: {} },
        { key: 'c', components: {}, parent: '#1' },
        { key: 9, components: {} },
        { key: '#3#2', components: {} },
        { key: '#3', components: {} },
      ],
    } as unknown as SceneData
    const { ids, problems } = instantiateScene(w, data, opts)
    expect(ids.size).toBe(6)
    expect([...ids.keys()]).toEqual(['#1', '#1#2', 'c', '#3#3', '#3#2', '#3'])
    expect(problems.map((p) => p.path)).toEqual(['entities[1].key', 'entities[3].key'])
    expect(problems[0]!.message).toMatch(/spawned as "#1#2"/)
    expect(w.getComponent(ids.get('#1')!, SceneMember)).toEqual({ scene: 's', key: '#1' })
    // The authored "#1" is still the parent the data names.
    expect(w.getComponent(ids.get('c')!, Parent)).toEqual({ entity: ids.get('#1') })
  })

  it('a hole in the entities array is a problem and still spawns (every index spawns)', () => {
    const w = fresh()
    const entities: SceneEntityData[] = [{ key: 'a', components: {} }]
    entities[2] = { key: 'c', components: {} }
    const { ids, problems } = instantiateScene(w, { name: 's', entities }, opts)
    expect([...ids.keys()]).toEqual(['a', '#1', 'c'])
    expect(problems).toEqual([{ path: 'entities[1]', message: expect.stringMatching(/expected an object/) }])
  })

  it('a Parent component in the data is a problem and skipped; links come only from parent keys', () => {
    const w = fresh()
    w.use(installHierarchy())
    const stranger = w.spawn([entry(Pos, { x: 0, y: 0 })])
    const resolveWithParent = (n: string): ComponentType<any> | undefined => (n === 'Parent' ? Parent : resolve(n))
    const { ids, problems } = instantiateScene(
      w,
      {
        name: 's',
        entities: [
          { key: 'a', components: {} },
          // A key in Parent.entity would be stored as a string; a stale id
          // would link to whatever entity holds that id now.
          { key: 'b', components: { Parent: { entity: 'a' } } },
          { key: 'c', components: { Parent: { entity: stranger } }, parent: 'a' },
        ],
      },
      { resolve: resolveWithParent },
    )
    expect(problems).toEqual([
      { path: 'entities[1].components.Parent', message: expect.stringMatching(/parent/) },
      { path: 'entities[2].components.Parent', message: expect.stringMatching(/parent/) },
    ])
    expect(w.getComponent(ids.get('b')!, Parent)).toBeUndefined()
    expect(w.getComponent(ids.get('c')!, Parent)).toEqual({ entity: ids.get('a') })
  })

  it('a component whose validate rejects the fields is a problem and is skipped', () => {
    const w = fresh()
    const { ids, problems } = instantiateScene(
      w,
      { name: 's', entities: [{ key: 'a', components: { ScChecked: { n: -1 }, ScPos: {} } }] },
      opts,
    )
    expect(problems).toEqual([{ path: 'entities[0].components.ScChecked', message: expect.stringMatching(/n must be >= 0/) }])
    expect(w.has(ids.get('a')!, Checked)).toBe(false)
    expect(w.has(ids.get('a')!, Pos)).toBe(true)
  })

  it('malformed entity data is reported per path and every entity still spawns', () => {
    const w = fresh()
    const data = {
      name: 's',
      entities: [
        { key: 7, components: { ScPos: {} } },
        { key: 'b', components: 'nope' },
        { key: 'c', components: { ScPos: 5 } },
        { key: 'd', components: {}, parent: 3 },
        null,
        { key: 'f', components: { ScPos: {}, SceneMember: { scene: 'x', key: 'y' } } },
        { key: 'g', components: { ScHp: {}, ScHp2: {} } },
      ],
    } as unknown as SceneData
    const resolve2 = (n: string): ComponentType<any> | undefined =>
      n === 'SceneMember' ? SceneMember : n === 'ScHp2' ? Hp : resolve(n)
    const { ids, problems } = instantiateScene(w, data, { resolve: resolve2 })
    expect(ids.size).toBe(7)
    expect([...ids.keys()]).toEqual(['#0', 'b', 'c', 'd', '#4', 'f', 'g'])
    expect(problems.map((p) => p.path)).toEqual([
      'entities[0].key',
      'entities[1].components',
      'entities[2].components.ScPos',
      'entities[4]',
      'entities[5].components.SceneMember',
      'entities[6].components.ScHp2',
      'entities[3].parent',
    ])
    expect(w.getComponent(ids.get('#0')!, Pos)).toEqual({ x: 0, y: 0 })
    expect(w.getComponent(ids.get('f')!, SceneMember)).toEqual({ scene: 's', key: 'f' })
    expect(w.getComponent(ids.get('g')!, Hp)).toEqual({ hp: 10, max: 10 })
  })

  it('a type whose name another type already holds in the world is a problem, not a throw', () => {
    const w = fresh()
    w.spawn([entry(Pos, { x: 0, y: 0 })])
    const Impostor = defineComponent<{ x: number }>('ScPos', { defaults: { x: 0 } })
    const { ids, problems } = instantiateScene(
      w,
      { name: 's', entities: [{ key: 'a', components: { ScPos: {}, ScHp: {} } }] },
      { resolve: (n) => (n === 'ScPos' ? Impostor : resolve(n)) },
    )
    expect(problems).toEqual([{ path: 'entities[0].components.ScPos', message: expect.stringMatching(/another component type/) }])
    expect(w.has(ids.get('a')!, Hp)).toBe(true)
  })

  it('a resolver that throws or returns a non-type is a problem', () => {
    const w = fresh()
    const { ids, problems } = instantiateScene(
      w,
      { name: 's', entities: [{ key: 'a', components: { Boom: {}, Odd: {}, ScPos: {} } }] },
      {
        resolve: (n) => {
          if (n === 'Boom') throw new Error('kaboom')
          if (n === 'Odd') return { name: 'Odd' } as unknown as ComponentType<any>
          return resolve(n)
        },
      },
    )
    expect(problems.map((p) => p.path)).toEqual(['entities[0].components.Boom', 'entities[0].components.Odd'])
    expect(problems[0]!.message).toMatch(/kaboom/)
    expect(w.has(ids.get('a')!, Pos)).toBe(true)
  })

  it('bad arguments are programmer errors (TypeError)', () => {
    const w = fresh()
    expect(() => instantiateScene(w, { name: 3, entities: [] } as unknown as SceneData, opts)).toThrow(TypeError)
    expect(() => instantiateScene(w, { name: 's' } as unknown as SceneData, opts)).toThrow(TypeError)
    expect(() => instantiateScene(w, { name: 's', entities: [] }, {} as InstantiateSceneOptions)).toThrow(TypeError)
    expect(() =>
      instantiateScene(w, { name: 's', entities: [] }, { resolve, refFields: [['ScTarget']] as never }),
    ).toThrow(TypeError)
    expect(w.listEntities(And()).length).toBe(0)
  })

  it('works alongside installHierarchy and setParent', () => {
    const w = fresh()
    w.use(installHierarchy())
    const holder = w.spawn([entry(Pos, { x: 0, y: 0 })])
    const { ids } = instantiateScene(w, level, opts)
    expect(setParent(w, ids.get('root')!, holder)).toEqual({ ok: true })
    expect(ancestorsOf(w, ids.get('sword')!)).toEqual([ids.get('hero'), ids.get('root'), holder])
  })
})

const strict = (w: World): string => hashSnapshot(w.snapshot({ pendingEvents: true }), { includeChanges: true })

const levelB: SceneData = {
  name: 'level2',
  entities: [
    { key: 'gate', components: { ScPos: { x: 50 } } },
    { key: 'guard', components: { ScHp: { hp: 3 }, ScTarget: { entity: 'gate' } }, parent: 'gate' },
  ],
}

describe('unloadScene and sceneEntities (E21.2)', () => {
  it('test 5: unloadScene despawns exactly the scene\'s trees and returns the count', () => {
    const w = fresh()
    w.use(installHierarchy())
    const outsider = w.spawn([entry(Pos, { x: -1, y: -1 })])
    const a = instantiateScene(w, level, opts)
    const between = w.spawn([entry(Hp, { hp: 1, max: 1 })])
    const b = instantiateScene(w, levelB, { resolve, refFields: [['ScTarget', 'entity']] })
    // A non-member parented under a member goes with its tree; a member's
    // ancestor outside the scene stays.
    const bullet = w.spawn([entry(Pos, { x: 0, y: 0 })])
    expect(setParent(w, bullet, a.ids.get('sword')!)).toEqual({ ok: true })
    const holder = w.spawn([entry(Pos, { x: 0, y: 0 })])
    expect(setParent(w, a.ids.get('orc')!, holder)).toEqual({ ok: true })

    expect(sceneEntities(w, 'level1')).toEqual([...a.ids.values()])
    expect(sceneEntities(w, 'level2')).toEqual([...b.ids.values()])
    expect(sceneEntities(w, 'nope')).toEqual([])

    expect(unloadScene(w, 'level1')).toBe(5) // 4 members + the bullet
    for (const id of [...a.ids.values(), bullet]) expect(w.isAlive(id)).toBe(false)
    for (const id of [outsider, between, holder, ...b.ids.values()]) expect(w.isAlive(id)).toBe(true)
    expect(sceneEntities(w, 'level1')).toEqual([])
    expect(w.getComponent(b.ids.get('guard')!, Parent)).toEqual({ entity: b.ids.get('gate') })
    expect(unloadScene(w, 'level1')).toBe(0)
    expect(unloadScene(w, 'level2')).toBe(2)
    expect(w.listEntities(And()).sort((x, y) => x - y)).toEqual([outsider, between, holder])
  })

  it('test 5: sceneEntities lists members in ascending id, whatever their parenting', () => {
    const w = fresh()
    const { ids } = instantiateScene(
      w,
      { name: 's', entities: [{ key: 'leaf', components: {}, parent: 'top' }, { key: 'top', components: {} }] },
      opts,
    )
    expect(sceneEntities(w, 's')).toEqual([ids.get('leaf'), ids.get('top')])
    expect(unloadScene(w, 's')).toBe(2)
  })

  it('a scene instantiated twice is unloaded as one; members whose Parent graph is cyclic still go', () => {
    const w = fresh()
    instantiateScene(w, level, opts)
    instantiateScene(w, level, opts)
    expect(sceneEntities(w, 'level1')).toHaveLength(8)
    // Corrupt two members into a Parent cycle (no member root left for them).
    const { ids } = instantiateScene(w, { name: 'loop', entities: [{ key: 'p', components: {} }, { key: 'q', components: {} }] }, opts)
    const p = ids.get('p')!
    const q = ids.get('q')!
    w.addComponent(p, Parent, { entity: q })
    w.addComponent(q, Parent, { entity: p })
    expect(unloadScene(w, 'level1')).toBe(8)
    expect(unloadScene(w, 'loop')).toBe(2)
    expect(w.listEntities(And())).toEqual([])
  })

  it('test 6: instantiate, snapshot, restore into a fresh world: equal strict hash, and the scene still unloads', () => {
    const w = fresh()
    w.use(installHierarchy())
    w.spawn([entry(Pos, { x: 1, y: 1 })])
    instantiateScene(w, level, { resolve, refFields: [['ScTarget', 'entity']] })
    instantiateScene(w, levelB, { resolve, refFields: [['ScTarget', 'entity']] })
    w.stepOnce()
    const snap = w.snapshot({ pendingEvents: true })

    const r = fresh()
    r.use(installHierarchy())
    r.restore(snap)
    expect(strict(r)).toBe(strict(w))
    expect(sceneEntities(r, 'level1')).toEqual(sceneEntities(w, 'level1'))
    expect(sceneEntities(r, 'level2')).toEqual(sceneEntities(w, 'level2'))

    // Both worlds keep going identically: unload, re-instantiate, step.
    for (const world of [w, r]) {
      expect(unloadScene(world, 'level1')).toBe(4)
      instantiateScene(world, level, { resolve, refFields: [['ScTarget', 'entity']] })
      world.stepOnce()
    }
    expect(strict(r)).toBe(strict(w))
    expect(sceneEntities(r, 'level1')).toEqual(sceneEntities(w, 'level1'))
  })
})

// Spec §7.3 test 7, plan E21.3: "goto level" is an ordinary command handled
// by an event rule (§6.1) that records the requested scene; the host reads
// it after the step and swaps scenes with unloadScene + instantiateScene.
// No rule effect for scenes exists (out of scope in 2.3).

const Level = defineComponent<{ current: string; requested: string }>('ScLevel', {
  defaults: { current: '', requested: '' },
})
const Vel = defineComponent<{ vx: number }>('ScVel', { defaults: { vx: 0 } })
const GotoScene = defineEvent<{ scene: string }>('ScGotoScene', {
  schema: { fields: { scene: { kind: 'string', description: 'Name of the scene to load' } } },
  description: 'Ask the host to swap the current scene for another',
})
const sceneTypes: ComponentType<any>[] = [Pos, Hp, Target, Vel, Level]
const sceneResolve = (name: string): ComponentType<any> | undefined => sceneTypes.find((t) => t.name === name)
const catalog: Record<string, SceneData> = {
  meadow: {
    name: 'meadow',
    entities: [
      { key: 'hero', components: { ScPos: { x: 0 }, ScVel: { vx: 1 }, ScHp: { hp: 9 } } },
      { key: 'hat', components: { ScPos: {} }, parent: 'hero' },
      { key: 'wolf', components: { ScPos: { x: 9 }, ScVel: { vx: -1 }, ScTarget: { entity: 'hero' } } },
    ],
  },
  cave: {
    name: 'cave',
    entities: [
      { key: 'bat', components: { ScPos: { y: 4 }, ScVel: { vx: 2 }, ScTarget: { entity: 'torch' } } },
      { key: 'torch', components: { ScPos: { x: 1 } } },
    ],
  },
}

describe('goto level through an event rule (E21.3)', () => {
  const gotoRule: RuleDef = {
    name: 'gotoScene',
    schedule: 'event',
    on: 'ScGotoScene',
    priority: 1000,
    query: ['ScLevel'],
    actions: [{ set: 'ScLevel.requested', expr: 'event.scene' }],
  }

  const build = (): World => {
    const w = createWorld({ headless: true, seed: [3, 1, 4, 1] })
    w.use(installHierarchy())
    expect(w.register(GotoScene, ...sceneTypes).ok).toBe(true)
    w.system('sc:move', { schedule: 'fixed', query: [Pos, Vel] }, (ctx) => {
      for (const e of ctx.entities) {
        ctx.world.getComponent(e.id, Pos)!.x += ctx.world.getComponent(e.id, Vel)!.vx
        ctx.world.markChanged(e.id, Pos)
      }
    })
    const errors = installRules(w, [], sceneResolve).update([gotoRule])
    expect([...errors]).toEqual([])
    return w
  }

  /** The host's part, after each step: swap scenes when the rule recorded a request. */
  const host = (w: World): string[] => {
    const [level] = [...w.iterEntitiesWith(Level)]
    const state = level!.value
    if (state.requested === state.current) return []
    const data = catalog[state.requested]
    if (!data) {
      // Refuse: the request falls back to the current scene.
      const refused = `unknown scene "${state.requested}"`
      state.requested = state.current
      w.markChanged(level!.id, Level)
      return [refused]
    }
    if (state.current) unloadScene(w, state.current)
    const { problems } = instantiateScene(w, data, { resolve: sceneResolve, refFields: [['ScTarget', 'entity']] })
    state.current = state.requested
    w.markChanged(level!.id, Level)
    return problems.map((p) => p.message)
  }

  const start = (w: World): void => {
    w.spawn([entry(Level, { current: '', requested: 'meadow' })])
    expect(host(w)).toEqual([])
  }

  /** The acts of the run, by the tick before which they are emitted. */
  const script: Record<number, string> = { 3: 'cave', 7: 'meadow', 8: 'cave', 12: 'nowhere', 15: 'meadow' }
  const tick = (w: World, i: number): string[] => {
    const scene = script[i]
    if (scene) w.emit(GotoScene, { scene })
    w.step(w.time.fixedStep)
    return host(w)
  }

  it('test 7: the rule records the request, the host swaps, and forks restored mid-sequence stay equal', () => {
    const live = build()
    start(live)
    expect(sceneEntities(live, 'meadow')).toHaveLength(3)

    const forks: Array<{ at: number; world: World }> = []
    let lossy: { at: number; world: World } | undefined
    const seen: string[] = []
    /** A follower created at tick `at` already holds (or, lossy, dropped) that tick's act. */
    const follow = (f: { at: number; world: World }, i: number): void => {
      if (f.at === i) {
        f.world.step(f.world.time.fixedStep)
        host(f.world)
      } else tick(f.world, i)
    }
    for (let i = 0; i < 20; i++) {
      if (script[i]) {
        // Fork right after the act is emitted, before the step that delivers it.
        live.emit(GotoScene, { scene: script[i]! })
        expect(live.pendingEvents().some((e) => e.type === GotoScene)).toBe(true)
        const fork = build()
        fork.restore(live.snapshot({ pendingEvents: true }))
        expect(strict(fork)).toBe(strict(live))
        forks.push({ at: i, world: fork })
        if (!lossy) {
          lossy = { at: i, world: build() }
          lossy.world.restore(live.snapshot()) // control: the in-flight command is dropped
        }
        live.step(live.time.fixedStep)
        seen.push(...host(live))
      } else seen.push(...tick(live, i))
      for (const f of forks) follow(f, i)
      if (lossy) follow(lossy, i)
      for (const f of forks) expect(strict(f.world), `fork@${f.at} tick ${i}`).toBe(strict(live))
      const level = [...live.iterEntitiesWith(Level)][0]!.value
      if (i === 3) {
        // Delivered and handled in the step after the act: the cave is in.
        expect(level).toEqual({ current: 'cave', requested: 'cave' })
        expect(sceneEntities(live, 'meadow')).toEqual([])
        expect(sceneEntities(live, 'cave')).toHaveLength(2)
      }
    }
    expect(forks).toHaveLength(5)
    expect(seen).toEqual(['unknown scene "nowhere"'])
    const level = [...live.iterEntitiesWith(Level)][0]!.value
    expect(level).toEqual({ current: 'meadow', requested: 'meadow' })
    expect(sceneEntities(live, 'cave')).toEqual([])
    const ids = sceneEntities(live, 'meadow')
    expect(ids).toHaveLength(3)
    // The wolf's target was remapped to this instantiation's hero.
    const wolf = ids.find((id) => live.getComponent(id, SceneMember)!.key === 'wolf')!
    const hero = ids.find((id) => live.getComponent(id, SceneMember)!.key === 'hero')!
    expect(live.getComponent(wolf, Target)).toEqual({ entity: hero })
    // The lossy control never saw the first GotoScene, so it diverged.
    expect(strict(lossy!.world)).not.toBe(strict(live))
  })
})
