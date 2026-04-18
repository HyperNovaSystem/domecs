import { internal } from './component.js'
import type { ComponentBag, ComponentType, Entity } from './types.js'

export interface World {
  spawn(components?: ComponentBag): Entity
  despawn(entity: Entity): void
  has(entity: Entity, type: ComponentType<unknown>): boolean
  addComponent<T>(entity: Entity, type: ComponentType<T>, value: T): void
  removeComponent(entity: Entity, type: ComponentType<unknown>): void
  getComponent<T>(entity: Entity, type: ComponentType<T>): T | undefined
  componentTypes(): ComponentType<unknown>[]
  archetype(entity: Entity): ComponentType<unknown>[]
}

export interface WorldOptions {
  seed?: number | [number, number, number, number]
  headless?: boolean
  fixedStep?: number
  idle?: boolean
}

export function createWorld(_options: WorldOptions = {}): World {
  let nextId: Entity = 0
  const alive = new Set<Entity>()
  // componentName -> Map<Entity, value>
  const stores = new Map<string, Map<Entity, unknown>>()
  // componentName -> ComponentType (registry of seen types in this world)
  const typeRegistry = new Map<string, ComponentType<unknown>>()

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
        `domecs: two distinct ComponentType objects share the name "${type.name}"; names must be unique per world`,
      )
    }
    return s as Map<Entity, T>
  }

  function iterateBag(bag: ComponentBag): Iterable<readonly [ComponentType<unknown>, unknown]> {
    if (bag instanceof Map) return bag
    return bag as ReadonlyArray<readonly [ComponentType<unknown>, unknown]>
  }

  function assertAlive(entity: Entity): void {
    if (!alive.has(entity)) {
      throw new Error(`domecs: entity ${entity} is not alive`)
    }
  }

  const world: World = {
    spawn(components?: ComponentBag): Entity {
      const id = nextId++
      alive.add(id)
      if (components) {
        for (const [type, value] of iterateBag(components)) {
          world.addComponent(id, type, value)
        }
      }
      return id
    },

    despawn(entity: Entity): void {
      if (!alive.has(entity)) return
      alive.delete(entity)
      for (const store of stores.values()) store.delete(entity)
    },

    has(entity: Entity, type: ComponentType<unknown>): boolean {
      const s = stores.get(type.name)
      return s ? s.has(entity) : false
    },

    addComponent<T>(entity: Entity, type: ComponentType<T>, value: T): void {
      assertAlive(entity)
      const store = storeFor(type)
      if (store.has(entity)) {
        throw new Error(
          `domecs: entity ${entity} already has component "${type.name}"`,
        )
      }
      const v = internal(type).__defaults
        ? ({ ...(internal(type).__defaults as object), ...(value as object) } as T)
        : value
      store.set(entity, v)
    },

    removeComponent(entity: Entity, type: ComponentType<unknown>): void {
      const s = stores.get(type.name)
      if (!s) return
      s.delete(entity)
    },

    getComponent<T>(entity: Entity, type: ComponentType<T>): T | undefined {
      const s = stores.get(type.name)
      if (!s) return undefined
      return s.get(entity) as T | undefined
    },

    componentTypes(): ComponentType<unknown>[] {
      return Array.from(typeRegistry.values())
    },

    archetype(entity: Entity): ComponentType<unknown>[] {
      const out: ComponentType<unknown>[] = []
      for (const [name, store] of stores) {
        if (store.has(entity)) {
          const t = typeRegistry.get(name)
          if (t) out.push(t)
        }
      }
      return out
    },
  }

  return world
}
