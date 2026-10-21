import {
  defineComponent,
  type ComponentType,
  type Entity,
  type World,
} from '@domecs/core'
import { Parent, despawnTree, setParent } from './hierarchy.js'

/**
 * Marks an entity spawned by {@link instantiateScene}: the scene's `name`
 * and the entity's key within it (after duplicate suffixing). An ordinary,
 * persistent component with a declared schema, so scene membership survives
 * `snapshot`/`restore`, saves and replay, and keeps snapshot pruning from
 * dropping an otherwise bare scene entity. Written by `instantiateScene`;
 * treat it as read-only.
 */
export const SceneMember: ComponentType<{ scene: string; key: string }, 'SceneMember'> = defineComponent<
  { scene: string; key: string },
  'SceneMember'
>('SceneMember', {
  defaults: { scene: '', key: '' },
  schema: {
    fields: {
      scene: { kind: 'string', readonly: true, description: 'Name of the scene that spawned the entity' },
      key: { kind: 'string', readonly: true, description: "The entity's key within the scene (duplicates suffixed #2, #3, ...)" },
    },
  },
})

/** One entity of a {@link SceneData}. */
export interface SceneEntityData {
  /** Unique within the scene; `parent` and `refFields` values name entities by it. */
  readonly key: string
  /** Component name → fields; each value is the component's defaults plus these fields. */
  readonly components: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  /** The key of the parent entity within the same scene; absent or `null` for a root. */
  readonly parent?: string | null
}

/** A scene as plain data: a name and its entities in spawn order. */
export interface SceneData {
  readonly name: string
  readonly entities: readonly SceneEntityData[]
}

/**
 * Something {@link instantiateScene} could not apply. `path` points into the
 * data, e.g. `entities[3].components.Target.entity` or `entities[1].parent`.
 */
export interface SceneProblem {
  readonly path: string
  readonly message: string
}

/** Options for {@link instantiateScene}. */
export interface InstantiateSceneOptions {
  /** Component name → type (e.g. `world.lookupComponent`, or a catalog); `undefined` for an unknown name. */
  readonly resolve: (name: string) => ComponentType<any> | undefined
  /** Fields holding scene keys that must become live entity ids, e.g. [['Target','entity']]. */
  readonly refFields?: ReadonlyArray<readonly [component: string, field: string]>
}

/** Result of {@link instantiateScene}. */
export interface InstantiateSceneResult {
  /** Final key → live id, in data order (a duplicate key appears suffixed, e.g. `'a#2'`). */
  readonly ids: ReadonlyMap<string, Entity>
  /** Every problem, in the order found (spawn, then parents, then `refFields`). Empty on success. */
  readonly problems: readonly SceneProblem[]
}

/**
 * Spawn a scene into `world`. Never throws for bad scene data; every
 * problem is returned with its path (a bad `data` shape or `options` is a
 * programmer error: `TypeError`).
 *
 * 1. **Spawn** in array order, so equal data on equal worlds gives equal
 *    ids. Each entity gets `SceneMember { scene: data.name, key }` and its
 *    components, each the component's defaults plus the given fields (a
 *    plain-data copy; built with the component's `create`). An unknown
 *    component name, a component the resolver cannot give, fields that are
 *    not an object or that `validate` rejects, a name another component type
 *    holds in this world, a second component of the same type, and
 *    `SceneMember` or `Parent` given as a component (links come only from
 *    `parent` keys) are problems: that component is skipped and the entity
 *    still spawns. A duplicate key is a problem, and the entity spawns as
 *    `key#2` (`#3`, …); an entry that is not an object (a hole included) or
 *    whose key is not a string is a problem and the entity spawns as
 *    `#<index>`. A generated key never takes a key authored anywhere in the
 *    data (it moves on to the next free suffix).
 * 2. **Parents** by key, in array order, through `setParent` (so a parent may
 *    come later in the array). A key the scene does not have, a self-parent
 *    and a link that would close a cycle are problems; the entity stays a
 *    root.
 * 3. **`refFields`**: in each listed component field holding a string, the
 *    key becomes the live id (the field is marked changed). An unknown key
 *    is a problem and the field is left unchanged. Values that are not
 *    strings (`null`, numbers) are left as they are.
 *
 * A world where another component type holds the name `SceneMember` (or
 * `Parent`, when an entity has a `parent` key) spawns nothing: the result
 * has no ids and one problem with path `''`.
 *
 * Keys in the data name the first entity holding them; the suffixed keys
 * exist only in `ids` and `SceneMember`. Instantiating a scene name twice
 * gives two sets of members that {@link unloadScene} removes together.
 */
export function instantiateScene(
  world: World,
  data: SceneData,
  options: InstantiateSceneOptions,
): InstantiateSceneResult {
  if (data === null || typeof data !== 'object' || typeof data.name !== 'string') {
    throw new TypeError('instantiateScene: data.name must be a string')
  }
  if (!Array.isArray(data.entities)) {
    throw new TypeError('instantiateScene: data.entities must be an array')
  }
  if (options === null || typeof options !== 'object' || typeof options.resolve !== 'function') {
    throw new TypeError('instantiateScene: options.resolve must be a function')
  }
  const refFields = options.refFields ?? []
  if (
    !Array.isArray(refFields) ||
    !refFields.every(
      (r) => Array.isArray(r) && r.length === 2 && typeof r[0] === 'string' && typeof r[1] === 'string',
    )
  ) {
    throw new TypeError('instantiateScene: options.refFields must be an array of [component, field] string pairs')
  }

  const problems: SceneProblem[] = []
  const ids = new Map<string, Entity>()

  // Every member carries SceneMember, and parent keys link through Parent: a
  // world where another type holds either name cannot take the scene. Checked
  // before anything spawns (spawn would throw part-way through an entity).
  const linksParents = data.entities.some((e) => isRecord(e) && e.parent !== undefined && e.parent !== null)
  const fixed = linksParents ? world.register(SceneMember, Parent) : world.register(SceneMember)
  if (!fixed.ok) {
    problems.push({
      path: '',
      message: `another component type already holds the name "${fixed.error.name}" in this world; nothing spawned`,
    })
    return { ids, problems }
  }
  const spawned: Array<{ id: Entity; raw: unknown; components: Map<string, ComponentType<any>> }> = []

  // Every authored string key, so a generated key (a duplicate's suffix or a
  // bad key's `#<index>`) never takes one, even one later in the array: a
  // key in `parent`/`refFields` then always names its first authored holder.
  const authored = new Set<string>()
  for (let i = 0; i < data.entities.length; i++) {
    const raw: unknown = data.entities[i]
    if (isRecord(raw) && typeof raw.key === 'string') authored.add(raw.key)
  }
  const unused = (base: string): string => {
    let n = 2
    while (ids.has(`${base}#${n}`) || authored.has(`${base}#${n}`)) n++
    return `${base}#${n}`
  }

  // 1. Spawn in array order (every index, holes included).
  for (let i = 0; i < data.entities.length; i++) {
    const raw: unknown = data.entities[i]
    const at = `entities[${i}]`
    const entity = isRecord(raw) ? raw : undefined
    if (!entity) problems.push({ path: at, message: 'expected an object with key and components' })

    let key: string
    if (entity && typeof entity.key === 'string') {
      key = entity.key
      if (ids.has(key)) {
        const suffixed = unused(key)
        problems.push({ path: `${at}.key`, message: `duplicate key "${key}"; spawned as "${suffixed}"` })
        key = suffixed
      }
    } else {
      const base = `#${i}`
      key = ids.has(base) || authored.has(base) ? unused(base) : base
      if (entity) problems.push({ path: `${at}.key`, message: `key must be a string; spawned as "${key}"` })
    }

    const bag: Array<readonly [ComponentType<any>, unknown]> = [[SceneMember, { scene: data.name, key }]]
    const byName = new Map<string, ComponentType<any>>()
    const used = new Set<ComponentType<any>>([SceneMember])
    const components = entity?.components
    if (entity && !isRecord(components)) {
      problems.push({ path: `${at}.components`, message: 'expected an object of component name → fields' })
    } else if (components) {
      for (const name of Object.keys(components)) {
        const path = `${at}.components.${name}`
        const fields = components[name]
        const built = buildComponent(world, options.resolve, name, fields, used)
        if (typeof built === 'string') {
          problems.push({ path, message: built })
          continue
        }
        used.add(built.type)
        byName.set(name, built.type)
        bag.push([built.type, built.value])
      }
    }
    const id = world.spawn(bag)
    ids.set(key, id)
    spawned.push({ id, raw: entity, components: byName })
  }

  // 2. Parents by key.
  spawned.forEach(({ id, raw }, i) => {
    if (!isRecord(raw) || raw.parent === undefined || raw.parent === null) return
    const path = `entities[${i}].parent`
    if (typeof raw.parent !== 'string') {
      problems.push({ path, message: 'parent must be a key (string) or null' })
      return
    }
    const parent = ids.get(raw.parent)
    if (parent === undefined) {
      problems.push({ path, message: `no entity with key "${raw.parent}" in scene "${data.name}"` })
      return
    }
    const linked = setParent(world, id, parent)
    if (!linked.ok) {
      problems.push({
        path,
        message:
          parent === id
            ? `entity "${raw.parent}" cannot be its own parent`
            : `parenting under "${raw.parent}" would create a cycle`,
      })
    }
  })

  // 3. refFields: keys → live ids.
  if (refFields.length > 0) {
    spawned.forEach(({ id, components }, i) => {
      for (const [name, field] of refFields) {
        const type = components.get(name)
        if (!type) continue
        const value = world.getComponent(id, type) as Record<string, unknown> | undefined
        if (!value || !Object.hasOwn(value, field)) continue
        const ref = value[field]
        if (typeof ref !== 'string') continue
        const target = ids.get(ref)
        if (target === undefined) {
          problems.push({
            path: `entities[${i}].components.${name}.${field}`,
            message: `no entity with key "${ref}" in scene "${data.name}"; field left unchanged`,
          })
          continue
        }
        value[field] = target
        world.markChanged(id, type)
      }
    })
  }

  return { ids, problems }
}

/**
 * Despawn every entity of scene `name`: `despawnTree` over its member roots
 * (members whose parent is not a member of the scene), in ascending id
 * order, so descendants that are not members (a bullet parented under a
 * scene entity) go too and a member's ancestors outside the scene stay.
 * Members still alive afterwards (a corrupted `Parent` cycle) are
 * tree-despawned in ascending id order. Returns the number of entities
 * removed. Unknown or empty scene: 0.
 */
export function unloadScene(world: World, name: string): number {
  const members = sceneEntities(world, name)
  if (members.length === 0) return 0
  const isMember = new Set(members)
  const children = childIndex(world)
  const roots = members.filter((m) => {
    const p = world.getComponent(m, Parent)?.entity ?? null
    return p === null || !isMember.has(p)
  })
  // Everything the trees hold, to count what this call removed.
  const reach = new Set<Entity>()
  const stack = [...members]
  while (stack.length > 0) {
    const e = stack.pop()!
    if (reach.has(e)) continue
    reach.add(e)
    for (const c of children.get(e) ?? []) stack.push(c)
  }
  for (const r of roots) if (world.isAlive(r)) despawnTree(world, r)
  for (const m of members) if (world.isAlive(m)) despawnTree(world, m)
  let removed = 0
  for (const e of reach) if (!world.isAlive(e)) removed++
  return removed
}

/** The live members of scene `name` (entities whose `SceneMember.scene` is `name`), in ascending id order. */
export function sceneEntities(world: World, name: string): Entity[] {
  const out: Entity[] = []
  for (const { id, value } of world.iterEntitiesWith(SceneMember)) {
    if (value.scene === name) out.push(id)
  }
  return out.sort((a, b) => a - b)
}

// --- internals -------------------------------------------------------------

function childIndex(world: World): Map<Entity, Entity[]> {
  const children = new Map<Entity, Entity[]>()
  for (const { id, value } of world.iterEntitiesWith(Parent)) {
    if (value.entity === null) continue
    const list = children.get(value.entity)
    if (list) list.push(id)
    else children.set(value.entity, [id])
  }
  return children
}

function buildComponent(
  world: World,
  resolve: InstantiateSceneOptions['resolve'],
  name: string,
  fields: unknown,
  used: ReadonlySet<ComponentType<any>>,
): string | { type: ComponentType<any>; value: unknown } {
  let type: ComponentType<any> | undefined
  try {
    type = resolve(name)
  } catch (e) {
    return `resolving component "${name}" failed: ${errorText(e)}`
  }
  if (type === undefined) return `unknown component "${name}"; skipped`
  if (type === SceneMember) return 'SceneMember is set by instantiateScene; skipped'
  if (type === Parent) return 'Parent is set from the entity\'s "parent" key; skipped'
  if (!isRecord(fields)) return `fields of "${name}" must be an object; skipped`
  if (used.has(type)) return `component "${type.name}" is already set on this entity; skipped`
  // register checks that this is a component type and that no other type
  // holds its name in this world (spawn would throw on either).
  let registered
  try {
    registered = world.register(type)
  } catch {
    return `resolve("${name}") did not return a component type; skipped`
  }
  if (!registered.ok) {
    return `another component type already holds the name "${type.name}" in this world; skipped`
  }
  const copy = clonePlain(fields, new Map()) as Record<string, unknown>
  try {
    return { type, value: type.create(copy) }
  } catch (e) {
    return `${errorText(e)}; skipped`
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Clone arrays and plain objects (null-prototype ones included)
 * recursively, cycles preserved; anything else is kept by reference
 * (component values are plain data by contract).
 */
function clonePlain(value: unknown, seen: Map<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value
  const known = seen.get(value)
  if (known !== undefined) return known
  if (Array.isArray(value)) {
    const copy: unknown[] = []
    seen.set(value, copy)
    for (const item of value) copy.push(clonePlain(item, seen))
    return copy
  }
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const copy: Record<string, unknown> = proto === null ? Object.create(null) : {}
  seen.set(value, copy)
  for (const key of Object.keys(value)) {
    const item = clonePlain((value as Record<string, unknown>)[key], seen)
    // An own `__proto__` key stays a key, never a prototype change.
    if (key === '__proto__') Object.defineProperty(copy, key, { value: item, writable: true, enumerable: true, configurable: true })
    else copy[key] = item
  }
  return copy
}
