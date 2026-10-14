import { definePlugin, type ComponentType, type Entity, type Plugin } from '@domecs/core'
import { Parent } from './hierarchy.js'

export interface ComposeTransformsOptions {
  /** Plugin and system name. Default `domecs-scene:compose-transforms:<Local>><World_>`. */
  readonly name?: string
  /**
   * System priority (lower runs first; default 0). Systems that move
   * `Local` should run before it and readers of `World_` after it, or they
   * see last tick's values.
   */
  readonly priority?: number
}

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
 *
 * `World_` is written and marked changed only when a field's value moved,
 * so change-gated readers are not woken every tick; an entity that loses
 * `Local` loses the `World_` this plugin added. Disposing the plugin removes
 * its system (O-65).
 */
export function composeTransforms<T>(
  Local: ComponentType<T>,
  World_: ComponentType<T>,
  compose: (parentWorld: T | null, local: T) => T,
  options: ComposeTransformsOptions = {},
): Plugin {
  // O-65: named per component pair, so two instances can coexist.
  const name = options.name ?? `domecs-scene:compose-transforms:${Local.name}>${World_.name}`
  return definePlugin({
    name,
    install(world) {
      // Entities whose World_ this plugin added; it is removed again when
      // they lose Local (O-65).
      const owned = new Set<Entity>()
      const handle = world.system(
        name,
        { schedule: 'tick', query: [Local], priority: options.priority ?? 0 },
        (ctx) => {
          const localSet = new Set<Entity>()
          for (const e of ctx.entities) localSet.add(e.id)

          for (const id of owned) {
            if (localSet.has(id)) continue
            owned.delete(id)
            if (world.isAlive(id) && world.has(id, World_)) world.removeComponent(id, World_)
          }

          const computed = new Map<Entity, T>()

          function write(id: Entity, parentWorld: T | null): T {
            const local = world.getComponent(id, Local)!
            const worldValue = compose(parentWorld, local)
            const existing = world.getComponent(id, World_)
            if (existing === undefined) {
              world.addComponent(id, World_, worldValue)
              owned.add(id)
            } else if (!sameFields(existing, worldValue)) {
              // O-65: only a value that moved is marked, so change-gated
              // views of World_ do not repaint every tick.
              Object.assign(existing as object, worldValue)
              world.markChanged(id, World_)
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
      return {
        teardown() {
          handle.remove()
        },
      }
    },
  })
}

/** Whether every own field of `next` already holds the same value in `prev`. */
function sameFields(prev: unknown, next: unknown): boolean {
  const a = prev as Record<string, unknown>
  const b = next as Record<string, unknown>
  for (const key of Object.keys(b)) {
    if (!Object.is(a[key], b[key])) return false
  }
  return true
}
