import { definePlugin, type Plugin } from '@domecs/core'
import { Parent } from './hierarchy.js'

/**
 * Orphan policy for a **plain** `world.despawn()` call: whenever any entity
 * is despawned, every still-live entity whose `Parent.entity` pointed at it
 * is reparented to `null` (promoted to root) rather than left dangling.
 *
 * This is deliberately scoped to `world.despawn()` only. `despawnTree`
 * despawns descendants itself (deepest first — see its doc comment), so by
 * the time this handler's `entityDespawned` fires for an ancestor within
 * that cascade, every descendant of that ancestor *within the same
 * despawnTree call* has already been despawned and dropped out of the
 * `Parent` store; `iterEntitiesWith(Parent)` below only ever yields
 * currently-live entities, so this handler naturally finds nothing to
 * mutate for them. The extra `world.has` check is a defensive belt in case
 * a future caller despawns a subtree top-down instead.
 */
export function installHierarchy(): Plugin {
  return definePlugin({
    name: 'domecs-scene:hierarchy',
    install(world) {
      const unsubscribe = world.signals.entityDespawned.subscribe((despawnedId) => {
        try {
          for (const { id, value } of world.iterEntitiesWith(Parent)) {
            if (value.entity !== despawnedId) continue
            if (!world.has(id, Parent)) continue // defensive; see doc above
            value.entity = null
            world.markChanged(id, Parent)
          }
        } catch {
          // Signal handlers must never throw (SPEC: a throwing subscriber
          // must not break the despawn/tick that triggered it).
        }
      })
      return {
        teardown() {
          unsubscribe()
        },
      }
    },
  })
}
