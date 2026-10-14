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
 * before the entity itself) rather than trusting query order. The walk is
 * iterative, so any chain depth works (O-64). If the `Parent` graph is ever
 * corrupted into a cycle, the entity where the walk meets the cycle is
 * composed with `parentWorld = null` for that tick rather than looping
 * forever.
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

          function write(id: Entity, parentWorld: T | null): T {
            const local = world.getComponent(id, Local)!
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

          // O-64: walk up to the nearest resolved ancestor, then compose back
          // down — a loop, not recursion, so chain depth is unbounded.
          function resolve(start: Entity): void {
            const chain: Entity[] = []
            const onChain = new Set<Entity>()
            let id: Entity | null = start
            while (id !== null && !computed.has(id) && !onChain.has(id)) {
              chain.push(id)
              onChain.add(id)
              const parentId: Entity | null = world.getComponent(id, Parent)?.entity ?? null
              id = parentId !== null && localSet.has(parentId) ? parentId : null
            }
            // Stopped at a resolved ancestor, a root, or a cycle back onto
            // the chain (whose top is then composed as a root).
            let parentWorld: T | null = id !== null && computed.has(id) ? computed.get(id)! : null
            for (let i = chain.length - 1; i >= 0; i--) parentWorld = write(chain[i]!, parentWorld)
          }

          for (const id of localSet) resolve(id)
        },
      )
      return {}
    },
  })
}
