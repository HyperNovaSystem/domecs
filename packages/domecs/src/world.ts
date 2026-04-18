import { internal } from './component.js'
import { createEventBus, type EventBus, type EventType, type EventView } from './events.js'
import { emptyInput, type InputSnapshot } from './input.js'
import { createPluginRegistry, type Capability, type Plugin } from './plugin.js'
import { createRng, type Rng, type RngState } from './rng.js'
import {
  createScheduler,
  type CompiledSystem,
  type Scheduler,
  type System,
  type SystemContext,
  type SystemDef,
  type SystemHandle,
} from './scheduler.js'
import { createSignal, type EmittableSignal, type Signal } from './signals.js'
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

export interface WorldSignals {
  entitySpawned: Signal<Entity>
  entityDespawned: Signal<Entity>
  componentAdded: Signal<{ entity: Entity; type: ComponentType<unknown> }>
  componentRemoved: Signal<{ entity: Entity; type: ComponentType<unknown> }>
  tickStart: Signal<Readonly<TimeState>>
  tickEnd: Signal<Readonly<TimeState>>
}

export interface World {
  readonly rand: Rng
  readonly time: Readonly<TimeState>
  readonly signals: WorldSignals
  readonly events: EventView
  readonly input: InputSnapshot
  spawn(components?: ComponentBag): Entity
  despawn(entity: Entity): void
  has(entity: Entity, type: ComponentType<unknown>): boolean
  addComponent<T>(entity: Entity, type: ComponentType<T>, value: T): void
  removeComponent(entity: Entity, type: ComponentType<unknown>): void
  getComponent<T>(entity: Entity, type: ComponentType<T>): T | undefined
  markChanged<T>(entity: Entity, type: ComponentType<T>): void
  emit<T>(type: EventType<T>, payload: T): void
  on<T>(type: EventType<T>, fn: (e: T) => void): () => void
  system(name: string, def: SystemDef, fn: System): SystemHandle
  setScale(scale: number): void
  pause(): void
  resume(): void
  componentTypes(): ComponentType<unknown>[]
  archetype(entity: Entity): ComponentType<unknown>[]
  query(def: QueryDef): QueryResult
  step(dt?: number): void
  stepN(n: number, dt?: number): void
  turn<T>(type: EventType<T>, payload: T, dt?: number): void
  use(plugin: Plugin, options?: unknown): () => void
  capability<K extends string>(name: K): Capability<K>
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
  const bus: EventBus = createEventBus()
  let preResumeScale = 1
  let input: InputSnapshot = emptyInput()

  const sigEntitySpawned: EmittableSignal<Entity> = createSignal()
  const sigEntityDespawned: EmittableSignal<Entity> = createSignal()
  const sigComponentAdded: EmittableSignal<{ entity: Entity; type: ComponentType<unknown> }> =
    createSignal()
  const sigComponentRemoved: EmittableSignal<{ entity: Entity; type: ComponentType<unknown> }> =
    createSignal()
  const sigTickStart: EmittableSignal<Readonly<TimeState>> = createSignal()
  const sigTickEnd: EmittableSignal<Readonly<TimeState>> = createSignal()

  const signals: WorldSignals = {
    entitySpawned: sigEntitySpawned,
    entityDespawned: sigEntityDespawned,
    componentAdded: sigComponentAdded,
    componentRemoved: sigComponentRemoved,
    tickStart: sigTickStart,
    tickEnd: sigTickEnd,
  }

  let scheduler!: Scheduler
  let plugins!: ReturnType<typeof createPluginRegistry>
  let fixedStepCounter = 0
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

  function isEnabled(s: CompiledSystem): boolean {
    if (!s.enabled) return false
    if (s.def.enabled && s.def.enabled() === false) return false
    return true
  }

  function eventMatches(s: CompiledSystem, view: EventView): boolean {
    const triggers = s.def.triggers
    if (!triggers || triggers.length === 0) return true
    for (const t of triggers) {
      if (view.of(t).length > 0) return true
    }
    return false
  }

  function runSystem(s: CompiledSystem, view: EventView): void {
    const ctx: SystemContext = {
      entities: s.query ? s.query.entities : [],
      time,
      input,
      events: view,
      world,
      rand,
      state: s.state,
    }
    s.fn(ctx)
  }

  const world: World = {
    get rand() {
      return rand
    },
    get time() {
      return time
    },
    get signals() {
      return signals
    },
    get events() {
      return bus.view()
    },
    get input() {
      return input
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
      sigEntitySpawned.emit(id)
      return id
    },

    despawn(entity: Entity): void {
      if (!alive.has(entity)) return
      const arch = entityArchetype.get(entity)
      if (arch) {
        // SPEC §2.10: componentRemoved fires before the bag is released.
        if (sigComponentRemoved.size > 0) {
          for (const name of arch.types) {
            const t = typeRegistry.get(name)
            if (t) sigComponentRemoved.emit({ entity, type: t })
          }
        }
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
      sigEntityDespawned.emit(entity)
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
      sigComponentAdded.emit({ entity, type: type as ComponentType<unknown> })
    },

    removeComponent(entity: Entity, type: ComponentType<unknown>): void {
      const s = stores.get(type.name)
      if (!s || !s.has(entity)) return
      // SPEC §2.10: componentRemoved fires before the store drops the value.
      sigComponentRemoved.emit({ entity, type })
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

    emit<T>(type: EventType<T>, payload: T): void {
      bus.emit(type, payload)
    },

    on<T>(type: EventType<T>, fn: (e: T) => void): () => void {
      return bus.on(type, fn)
    },

    setScale(scale: number): void {
      time.scale = scale
    },

    pause(): void {
      if (time.scale !== 0) preResumeScale = time.scale
      time.scale = 0
    },

    resume(): void {
      if (time.scale === 0) time.scale = preResumeScale
    },

    system(name, def, fn): SystemHandle {
      return scheduler.register(name, def, fn)
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

      // SPEC §9.4 — plugin onTickStart fires at step 0.
      plugins.callTickStart(world)

      // SPEC §4 step 1 — flush event buffer from last tick into readable view.
      const eventView = bus.flush()
      if (sigTickStart.size > 0) sigTickStart.emit(time)

      // SPEC §4 step 2 — input collection (stub in headless).

      // SPEC §4 step 3 — fixed systems against shared accumulator (SPEC §3).
      if (time.scale !== 0) {
        time.fixedAccumulator += time.scaledDelta
        while (time.fixedAccumulator + 1e-12 >= time.fixedStep) {
          time.fixedAccumulator -= time.fixedStep
          fixedStepCounter += 1
          for (const s of scheduler.systemsByMode('fixed')) {
            if (!isEnabled(s)) continue
            if (fixedStepCounter % s.fixedDivisor !== 0) continue
            runSystem(s, eventView)
          }
        }
      }

      // SPEC §3 — `once` systems fire on first tick of world.
      for (const s of scheduler.systemsByMode('once')) {
        if (s.ranOnce || !isEnabled(s)) continue
        runSystem(s, eventView)
        s.ranOnce = true
      }

      // SPEC §4 step 4 — tick systems.
      if (time.scale !== 0) {
        for (const s of scheduler.systemsByMode('tick')) {
          if (!isEnabled(s)) continue
          runSystem(s, eventView)
        }
      }

      // SPEC §4 step 5 — event systems for events in this tick's view.
      for (const s of scheduler.systemsByMode('event')) {
        if (!isEnabled(s)) continue
        if (!eventMatches(s, eventView)) continue
        runSystem(s, eventView)
      }

      // SPEC §4 step 6 — reactive systems; one coalesced call if reactsTo has entities.
      for (const s of scheduler.systemsByMode('reactive')) {
        if (!isEnabled(s) || !s.reactsTo) continue
        if (s.reactsTo.size === 0) continue
        runSystem(s, eventView)
      }

      // SPEC §4 step 7 — renderer diff/commit handled by dom plugin (not core).
      plugins.callRender(world)

      // SPEC §9.4 — plugin onTickEnd fires at step 8.
      plugins.callTickEnd(world)
      if (sigTickEnd.size > 0) sigTickEnd.emit(time)
    },

    stepN(n: number, dt?: number): void {
      for (let i = 0; i < n; i++) world.step(dt)
    },

    turn<T>(type: EventType<T>, payload: T, dt?: number): void {
      // SPEC §3 turn-based mode: emit action, advance one tick.
      // Because events flush at next step's step 1, we emit first then step.
      bus.emit(type, payload)
      world.step(dt)
    },

    use(plugin: Plugin, options?: unknown): () => void {
      return plugins.use(plugin, options)
    },

    capability<K extends string>(name: K): Capability<K> {
      return plugins.capability(name)
    },
  }

  scheduler = createScheduler(world.query.bind(world), fixedStep)
  plugins = createPluginRegistry(world)

  return world
}

function collectRemovedTypeNames(node: QueryNode, out: Set<string> = new Set()): Set<string> {
  if (node.kind === 'removed') out.add(node.type.name)
  if (node.kind === 'or' || node.kind === 'and') {
    for (const c of node.children) collectRemovedTypeNames(c, out)
  }
  return out
}
