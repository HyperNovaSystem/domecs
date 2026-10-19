import { describe, expect, it } from 'vitest'
import { And, createWorld, defineComponent, entry, hashSnapshot } from '@domecs/core'
import type { ComponentType, Entity, World } from '@domecs/core'
import { Parent, ancestorsOf, installHierarchy, setParent } from '../src/index.js'
import {
  SceneMember,
  instantiateScene,
  sceneEntities,
  unloadScene,
  type InstantiateSceneOptions,
  type SceneData,
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
