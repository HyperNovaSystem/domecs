import { internal } from './component.js'
import { createRng, type Rng, type RngState } from './rng.js'
import { createTime, quantizeMs, type TimeState } from './time.js'
import type { ComponentBag, ComponentType, Entity } from './types.js'
import {
  normalize,
  treeHas,
  type EntityView,
  type QueryDef,
  type QueryNode,
  type QueryResult,
} from './query.js'

export interface World {
  readonly rand: Rng
  readonly time: Readonly<TimeState>
  spawn(components?: ComponentBag): Entity
  despawn(entity: Entity): void
  has(entity: Entity, type: ComponentType<unknown>): boolean
  addComponent<T>(entity: Entity, type: ComponentType<T>, value: T): void
  removeComponent(entity: Entity, type: ComponentType<unknown>): void
  getComponent<T>(entity: Entity, type: ComponentType<T>): T | undefined
  markChanged<T>(entity: Entity, type: ComponentType<T>): void
  componentTypes(): ComponentType<unknown>[]
  archetype(entity: Entity): ComponentType<unknown>[]
  query(def: QueryDef): QueryResult
  step(dt?: number): void
}

export interface WorldOptions {
  seed?: number | RngState
  headless?: boolean
  fixedStep?: number
  idle?: boolean
}

interface ArchetypeBucket {
  readonly key: string
  readonly types: Set<string>
  readonly entities: Set<Entity>
}

interface CompiledQuery {
  id: number
  node: QueryNode
  hasTickFilter: boolean
  hasRemoved: boolean
  matchingArchetypes: Set<ArchetypeBucket>
  structuralMembers: Set<Entity>
  onAddFns: Set<(v: EntityView) => void>
  onRemoveFns: Set<(v: EntityView) => void>
}

export function createWorld(options: WorldOptions = {}): World {
  const seed = options.seed ?? 0
  const rand = createRng(seed)
  const fixedStep = options.fixedStep ?? 1 / 60
  const time = createTime(fixedStep)

  let nextId: Entity = 0
  const alive = new Set<Entity>()
  // componentName -> Map<Entity, value>
  const stores = new Map<string, Map<Entity, unknown>>()
  // componentName -> ComponentType registered in this world
  const typeRegistry = new Map<string, ComponentType<unknown>>()

  // archetype index
  const archetypes = new Map<string, ArchetypeBucket>()
  const entityArchetype = new Map<Entity, ArchetypeBucket>()

  // per-tick change sets (reset in step())
  const tickAdded = new Map<string, Set<Entity>>()
  const tickRemoved = new Map<string, Set<Entity>>()
  const tickChanged = new Map<string, Set<Entity>>()

  // queries
  const queries: CompiledQuery[] = []
  let nextQueryId = 0

  const EMPTY_ARCH_KEY = ''
  const emptyArch = ensureArchetype(new Set<string>())

  function archetypeKeyFor(types: Set<string>): string {
    if (types.size === 0) return EMPTY_ARCH_KEY
    return Array.from(types).sort().join('|')
  }

  function ensureArchetype(types: Set<string>): ArchetypeBucket {
    const key = archetypeKeyFor(types)
    let bucket = archetypes.get(key)
    if (bucket) return bucket
    bucket = { key, types, entities: new Set() }
    archetypes.set(key, bucket)
    for (const q of queries) evaluateQueryAgainstArchetype(q, bucket)
    return bucket
  }

  function moveEntity(entity: Entity, nextTypes: Set<string>): void {
    const prev = entityArchetype.get(entity)
    const next = ensureArchetype(nextTypes)
    if (prev === next) return
    if (prev) prev.entities.delete(entity)
    next.entities.add(entity)
    entityArchetype.set(entity, next)

    for (const q of queries) {
      const wasIn = prev ? q.matchingArchetypes.has(prev) : false
      const nowIn = q.matchingArchetypes.has(next)
      if (wasIn && !nowIn) {
        q.structuralMembers.delete(entity)
        if (q.onRemoveFns.size > 0) {
          const view = makeView(entity)
          for (const fn of q.onRemoveFns) fn(view)
        }
      } else if (!wasIn && nowIn) {
        q.structuralMembers.add(entity)
        if (q.onAddFns.size > 0) {
          const view = makeView(entity)
          for (const fn of q.onAddFns) fn(view)
        }
      }
    }
  }

  function evalStructural(node: QueryNode, types: Set<string>): boolean {
    switch (node.kind) {
      case 'has': return types.has(node.type.name)
      case 'not': return !types.has(node.type.name)
      case 'or': return node.children.some((c) => evalStructural(c, types))
      case 'and': return node.children.every((c) => evalStructural(c, types))
      case 'added': return types.has(node.type.name)
      case 'changed': return types.has(node.type.name)
      case 'removed': return true
      case 'where': return types.has(node.type.name)
    }
  }

  function evalEntity(node: QueryNode, entity: Entity): boolean {
    switch (node.kind) {
      case 'has': return hasType(entity, node.type.name)
      case 'not': return !hasType(entity, node.type.name)
      case 'or': return node.children.some((c) => evalEntity(c, entity))
      case 'and': return node.children.every((c) => evalEntity(c, entity))
      case 'added': return (tickAdded.get(node.type.name)?.has(entity)) ?? false
      case 'changed': return (tickChanged.get(node.type.name)?.has(entity)) ?? false
      case 'removed': return (tickRemoved.get(node.type.name)?.has(entity)) ?? false
      case 'where': {
        const v = stores.get(node.type.name)?.get(entity)
        if (v === undefined) return false
        return node.predicate(v)
      }
    }
  }

  function hasType(entity: Entity, name: string): boolean {
    const s = stores.get(name)
    return s ? s.has(entity) : false
  }

  function evaluateQueryAgainstArchetype(
    q: CompiledQuery,
    arch: ArchetypeBucket,
  ): void {
    if (evalStructural(q.node, arch.types)) {
      q.matchingArchetypes.add(arch)
    }
  }

  function makeView(entity: Entity): EntityView {
    const view: Record<string, unknown> = { id: entity }
    for (const [name, store] of stores) {
      const v = store.get(entity)
      if (v !== undefined) view[name] = v
    }
    return view as EntityView
  }

  function recordTick(map: Map<string, Set<Entity>>, name: string, entity: Entity): void {
    let s = map.get(name)
    if (!s) {
      s = new Set()
      map.set(name, s)
    }
    s.add(entity)
  }

  function storeFor<T>(type: ComponentType<T>): Map<Entity, T> {
    let s = stores.get(type.name)
    if (!s) {
      s = new Map()
      stores.set(type.name, s)
      typeRegistry.set(type.name, type as ComponentType<unknown>)
    } else if (!typeRegistry.has(type.name)) {
      typeRegistry.set(type.name, type as ComponentType<unknown>)
    } else if (typeRegistry.get(type.name) !== type) {
      throw new Error(
        `domecs: two distinct ComponentType objects share the name "${type.name}"`,
      )
    }
    return s as Map<Entity, T>
  }

  function iterateBag(
    bag: ComponentBag,
  ): Iterable<readonly [ComponentType<unknown>, unknown]> {
    if (bag instanceof Map) return bag
    return bag as ReadonlyArray<readonly [ComponentType<unknown>, unknown]>
  }

  function assertAlive(entity: Entity): void {
    if (!alive.has(entity)) {
      throw new Error(`domecs: entity ${entity} is not alive`)
    }
  }

  function currentTypes(entity: Entity): Set<string> {
    const arch = entityArchetype.get(entity)
    return arch ? new Set(arch.types) : new Set()
  }

  const world: World = {
    get rand() {
      return rand
    },
    get time() {
      return time
    },
    spawn(components?: ComponentBag): Entity {
      const id = nextId++
      alive.add(id)
      // new entity enters empty archetype
      emptyArch.entities.add(id)
      entityArchetype.set(id, emptyArch)
      for (const q of queries) {
        if (q.matchingArchetypes.has(emptyArch)) {
          q.structuralMembers.add(id)
          if (q.onAddFns.size > 0) {
            const view = makeView(id)
            for (const fn of q.onAddFns) fn(view)
          }
        }
      }
      if (components) {
        for (const [type, value] of iterateBag(components)) {
          world.addComponent(id, type, value)
        }
      }
      return id
    },

    despawn(entity: Entity): void {
      if (!alive.has(entity)) return
      const arch = entityArchetype.get(entity)
      if (arch) {
        for (const name of arch.types) {
          recordTick(tickRemoved, name, entity)
          stores.get(name)?.delete(entity)
        }
        // fire onRemove hooks for queries this entity was in
        for (const q of queries) {
          if (q.matchingArchetypes.has(arch)) {
            q.structuralMembers.delete(entity)
            if (q.onRemoveFns.size > 0) {
              const view: EntityView = { id: entity }
              for (const fn of q.onRemoveFns) fn(view)
            }
          }
        }
        arch.entities.delete(entity)
      }
      entityArchetype.delete(entity)
      alive.delete(entity)
    },

    has(entity: Entity, type: ComponentType<unknown>): boolean {
      return hasType(entity, type.name)
    },

    addComponent<T>(entity: Entity, type: ComponentType<T>, value: T): void {
      assertAlive(entity)
      const store = storeFor(type)
      if (store.has(entity)) {
        throw new Error(
          `domecs: entity ${entity} already has component "${type.name}"`,
        )
      }
      const merged = internal(type).__defaults
        ? ({ ...(internal(type).__defaults as object), ...(value as object) } as T)
        : value
      store.set(entity, merged)
      recordTick(tickAdded, type.name, entity)
      const nextTypes = currentTypes(entity)
      nextTypes.add(type.name)
      moveEntity(entity, nextTypes)
    },

    removeComponent(entity: Entity, type: ComponentType<unknown>): void {
      const s = stores.get(type.name)
      if (!s || !s.has(entity)) return
      s.delete(entity)
      recordTick(tickRemoved, type.name, entity)
      const nextTypes = currentTypes(entity)
      nextTypes.delete(type.name)
      moveEntity(entity, nextTypes)
    },

    getComponent<T>(entity: Entity, type: ComponentType<T>): T | undefined {
      const s = stores.get(type.name)
      if (!s) return undefined
      return s.get(entity) as T | undefined
    },

    markChanged<T>(entity: Entity, type: ComponentType<T>): void {
      // register type into registry even if caller only marks
      storeFor(type)
      recordTick(tickChanged, type.name, entity)
    },

    componentTypes(): ComponentType<unknown>[] {
      return Array.from(typeRegistry.values())
    },

    archetype(entity: Entity): ComponentType<unknown>[] {
      const arch = entityArchetype.get(entity)
      if (!arch) return []
      const out: ComponentType<unknown>[] = []
      for (const name of arch.types) {
        const t = typeRegistry.get(name)
        if (t) out.push(t)
      }
      return out
    },

    query(def: QueryDef): QueryResult {
      const node = normalize(def)
      const hasTickFilter = treeHas(
        node,
        new Set<QueryNode['kind']>(['added', 'changed', 'removed', 'where']),
      )
      const hasRemoved = treeHas(node, new Set<QueryNode['kind']>(['removed']))
      const q: CompiledQuery = {
        id: nextQueryId++,
        node,
        hasTickFilter,
        hasRemoved,
        matchingArchetypes: new Set(),
        structuralMembers: new Set(),
        onAddFns: new Set(),
        onRemoveFns: new Set(),
      }
      queries.push(q)
      // seed against all existing archetypes
      for (const arch of archetypes.values()) {
        evaluateQueryAgainstArchetype(q, arch)
        if (q.matchingArchetypes.has(arch)) {
          for (const e of arch.entities) q.structuralMembers.add(e)
        }
      }

      const needsEntityFilter = hasTickFilter
      const collectCandidates = (): Iterable<Entity> => {
        if (!hasRemoved) return q.structuralMembers
        // Removed: include entities that were removed this tick, which may
        // no longer sit in any structurally matching archetype.
        const set = new Set<Entity>(q.structuralMembers)
        for (const name of collectRemovedTypeNames(node)) {
          const s = tickRemoved.get(name)
          if (s) for (const e of s) set.add(e)
        }
        return set
      }

      const result: QueryResult = {
        get entities() {
          const candidates = collectCandidates()
          const out: EntityView[] = []
          for (const e of candidates) {
            if (needsEntityFilter && !evalEntity(node, e)) continue
            out.push(makeView(e))
          }
          return out
        },
        get size() {
          if (!needsEntityFilter && !hasRemoved) return q.structuralMembers.size
          let count = 0
          for (const e of collectCandidates()) {
            if (needsEntityFilter && !evalEntity(node, e)) continue
            count++
          }
          return count
        },
        onAdd(fn) {
          q.onAddFns.add(fn)
          return () => q.onAddFns.delete(fn)
        },
        onRemove(fn) {
          q.onRemoveFns.add(fn)
          return () => q.onRemoveFns.delete(fn)
        },
      }
      return result
    },

    step(dt?: number): void {
      // SPEC §4 step 0 — reset per-tick change-detection.
      tickAdded.clear()
      tickRemoved.clear()
      tickChanged.clear()
      const d = dt ?? 0
      time.delta = d
      time.scaledDelta = quantizeMs(d * time.scale)
      time.elapsed += time.scaledDelta
      time.tick += 1
    },
  }

  return world
}

function collectRemovedTypeNames(node: QueryNode, out: Set<string> = new Set()): Set<string> {
  if (node.kind === 'removed') out.add(node.type.name)
  if (node.kind === 'or' || node.kind === 'and') {
    for (const c of node.children) collectRemovedTypeNames(c, out)
  }
  return out
}
