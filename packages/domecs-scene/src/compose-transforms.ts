import { definePlugin, type ComponentType, type Entity, type Plugin } from '@domecs/core'
import { Parent } from './hierarchy.js'

/**
 * Plugin factory: installs a `'tick'` system that keeps a `World_` component
 * derived from a `Local` component, composed down the `Parent` hierarchy so a
 * parent's `World_` is always computed before any child's.
 *
 * `compose(parentWorld, local)` receives `parentWorld = null` when the
 * entity is effectively a hierarchy root for this purpose — no `Parent`
 * component, a `Parent.entity === null`, or a `Parent` pointing at an
 * entity that does not itself carry `Local`.
 *
 * Ordering: the query's own iteration order does not respect hierarchy, so
 * each entity's `World_` is resolved via a memoized walk up its own
 * `Parent` chain (visiting each entity's nearest `Local`-bearing ancestor
 * before the entity itself) rather than trusting query order. A `visiting`
 * guard prevents infinite recursion if the `Parent` graph is ever
 * corrupted into a cycle (composes the culprit with `parentWorld = null`
 * for that tick rather than looping forever).
 */
export function composeTransforms<T>(
  Local: ComponentType<T>,
  World_: ComponentType<T>,
  compose: (parentWorld: T | null, local: T) => T,
): Plugin {
  return definePlugin({
    name: 'domecs-scene:compose-transforms',
    install(world) {
      world.system(
        'domecs-scene:compose-transforms',
        { schedule: 'tick', query: [Local] },
        (ctx) => {
          const localSet = new Set<Entity>()
          for (const e of ctx.entities) localSet.add(e.id)

          const computed = new Map<Entity, T>()
          const visiting = new Set<Entity>()

          function resolve(id: Entity): T {
            const cached = computed.get(id)
            if (cached !== undefined) return cached

            const local = world.getComponent(id, Local)!
            visiting.add(id)
            const parentComp = world.getComponent(id, Parent)
            const parentId = parentComp?.entity ?? null
            let parentWorld: T | null = null
            if (parentId !== null && localSet.has(parentId) && !visiting.has(parentId)) {
              parentWorld = resolve(parentId)
            }
            visiting.delete(id)

            const worldValue = compose(parentWorld, local)
            if (world.has(id, World_)) {
              const existing = world.getComponent(id, World_) as unknown as Record<
                string,
                unknown
              >
              Object.assign(existing, worldValue as unknown as Record<string, unknown>)
              world.markChanged(id, World_)
            } else {
              world.addComponent(id, World_, worldValue)
            }
            computed.set(id, worldValue)
            return worldValue
          }

          for (const id of localSet) resolve(id)
        },
      )
      return {}
    },
  })
}
