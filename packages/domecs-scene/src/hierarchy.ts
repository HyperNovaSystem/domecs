import { And, defineComponent, type Entity, type World } from '@domecs/core'

/**
 * Parent-pointer component (SPEC M4). `entity: null` means "no parent" /
 * root. Ordinary (non-transient) component data — it participates in
 * `world.snapshot()` / `world.restore()` like any other component, so a
 * hierarchy survives save/load for free.
 */
export const Parent = defineComponent<{ entity: Entity | null }>('Parent', {
  defaults: { entity: null },
})

/**
 * Set (or clear, with `parent: null`) `child`'s parent. Never throws.
 *
 * Rejects with `{ ok: false, reason }` — leaving every component untouched —
 * when:
 * - `parent` is not alive — despawned or never spawned (O-61), or
 * - `parent === child` (an entity cannot be its own parent), or
 * - `parent` is a descendant of `child` (parenting `child` under `parent`
 *   would close a cycle: walk `parent`'s own ancestor chain via the `Parent`
 *   component; if it reaches `child`, this is a cycle).
 *
 * Otherwise sets `child`'s `Parent.entity` to `parent` (adding the
 * component on first use, mutating + `markChanged` afterward) and returns
 * `{ ok: true }`.
 */
export function setParent(
  world: World,
  child: Entity,
  parent: Entity | null,
): { ok: true } | { ok: false; reason: string } {
  if (parent !== null) {
    if (!world.isAlive(parent)) {
      return { ok: false, reason: `setParent: parent entity ${parent} is not alive` }
    }
    if (parent === child) {
      return { ok: false, reason: `setParent: entity ${child} cannot be its own parent` }
    }
    if (ancestorsOf(world, parent).includes(child)) {
      return {
        ok: false,
        reason:
          `setParent: entity ${parent} is already a descendant of ${child}; ` +
          `parenting ${child} under ${parent} would create a cycle`,
      }
    }
  }
  try {
    const existing = world.getComponent(child, Parent)
    if (existing) {
      existing.entity = parent
      world.markChanged(child, Parent)
    } else {
      world.addComponent(child, Parent, { entity: parent })
    }
  } catch (e) {
    // Defensive: never throw (e.g. `child` not alive raises from
    // addComponent's assertAlive). Surface as a rejection instead.
    return {
      ok: false,
      reason: `setParent: could not set Parent on entity ${child}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    }
  }
  return { ok: true }
}

/** Every live entity whose `Parent.entity` is exactly `entity`. Recomputed
 * on every call — no cache (see M4 design note: `WorldSignals` has no
 * per-component "changed" event, only add/remove, so a signal-driven cache
 * would silently miss in-place `Parent` mutations from `setParent`). */
export function childrenOf(world: World, entity: Entity): Entity[] {
  const out: Entity[] = []
  for (const { id, value } of world.iterEntitiesWith(Parent)) {
    if (value.entity === entity) out.push(id)
  }
  return out
}

/**
 * Walk up `entity`'s `Parent` chain, **not including `entity` itself**.
 * Order: nearest ancestor (immediate parent) first, root last — i.e.
 * `[parent, grandparent, ..., root]`.
 *
 * Terminates even over a corrupted/cyclic `Parent` graph: a `visited` set
 * stops the walk the moment it would revisit an entity, so this can never
 * infinite-loop regardless of how the cycle got there.
 */
export function ancestorsOf(world: World, entity: Entity): Entity[] {
  const out: Entity[] = []
  const visited = new Set<Entity>([entity])
  let current: Entity = entity
  for (;;) {
    const p = world.getComponent(current, Parent)
    const next = p?.entity ?? null
    if (next === null || visited.has(next)) break
    visited.add(next)
    out.push(next)
    current = next
  }
  return out
}

/**
 * Every live entity with no `Parent` component, or a `Parent` whose
 * `.entity` is `null`. `And()` with zero children is vacuously true for
 * every archetype (SPEC: `Array.prototype.every` on `[]`), so
 * `listEntities(And())` is the engine's "every live entity" selector —
 * including bare entities with no components at all.
 */
export function rootsOf(world: World): Entity[] {
  const out: Entity[] = []
  for (const id of world.listEntities(And())) {
    const p = world.getComponent(id, Parent)
    if (!p || p.entity === null) out.push(id)
  }
  return out
}

/**
 * Entities a {@link despawnTree} call is removing, per world, so the
 * despawn-orphan plugin skips them instead of scanning every `Parent` for
 * each one (O-64).
 */
export const cascading = new WeakMap<World, ReadonlySet<Entity>>()

/**
 * Despawn `entity` and every descendant. Degenerates to a plain despawn for
 * a childless entity. Descendants are despawned before their ancestors (a
 * reversed pre-order walk), which matters beyond correctness-of-removal: it
 * ensures `installHierarchy`'s despawn-orphan handler never observes a
 * still-live child of an entity this call is deliberately removing — by the
 * time an ancestor's despawn fires, every one of its descendants in this
 * subtree is already gone.
 *
 * Linear in the number of `Parent` holders: children are indexed in one pass
 * rather than looked up per node (O-64). Terminates over a cyclic `Parent`
 * graph — each entity is visited once.
 */
export function despawnTree(world: World, entity: Entity): void {
  const children = new Map<Entity, Entity[]>()
  for (const { id, value } of world.iterEntitiesWith(Parent)) {
    if (value.entity === null) continue
    const list = children.get(value.entity)
    if (list) list.push(id)
    else children.set(value.entity, [id])
  }
  const preOrder: Entity[] = []
  const visited = new Set<Entity>()
  const stack: Entity[] = [entity]
  while (stack.length > 0) {
    const e = stack.pop()!
    if (visited.has(e)) continue
    visited.add(e)
    preOrder.push(e)
    for (const child of children.get(e) ?? []) stack.push(child)
  }
  const outer = cascading.get(world)
  cascading.set(world, visited)
  try {
    for (let i = preOrder.length - 1; i >= 0; i--) {
      const e = preOrder[i]!
      // A despawn subscriber may already have removed a descendant.
      if (e === entity || world.isAlive(e)) world.despawn(e)
    }
  } finally {
    if (outer) cascading.set(world, outer)
    else cascading.delete(world)
  }
}
