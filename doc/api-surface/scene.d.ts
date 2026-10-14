// file: compose-transforms.d.ts
import { type ComponentType, type Plugin } from '@domecs/core';
export interface ComposeTransformsOptions {
    /** Plugin and system name. Default `domecs-scene:compose-transforms:<Local>><World_>`. */
    readonly name?: string;
    /**
     * System priority (lower runs first; default 0). Systems that move
     * `Local` should run before it and readers of `World_` after it, or they
     * see last tick's values.
     */
    readonly priority?: number;
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
 * `World_` is written and marked changed only when a field's value moved
 * (a field holding an object always counts as moved), so change-gated
 * readers are not woken every tick; an entity that loses `Local` loses
 * `World_`. Disposing the plugin removes its systems (O-65).
 */
export declare function composeTransforms<T>(Local: ComponentType<T>, World_: ComponentType<T>, compose: (parentWorld: T | null, local: T) => T, options?: ComposeTransformsOptions): Plugin;

// file: despawn-orphan-plugin.d.ts
import { type Plugin } from '@domecs/core';
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
export declare function installHierarchy(): Plugin;

// file: hierarchy.d.ts
import { type Entity, type World } from '@domecs/core';
/**
 * Parent-pointer component (SPEC M4). `entity: null` means "no parent" /
 * root. Ordinary (non-transient) component data — it participates in
 * `world.snapshot()` / `world.restore()` like any other component, so a
 * hierarchy survives save/load for free.
 */
export declare const Parent: import("@domecs/core").ComponentType<{
    entity: Entity | null;
}, string>;
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
export declare function setParent(world: World, child: Entity, parent: Entity | null): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/** Every live entity whose `Parent.entity` is exactly `entity`. Recomputed
 * on every call — no cache (see M4 design note: `WorldSignals` has no
 * per-component "changed" event, only add/remove, so a signal-driven cache
 * would silently miss in-place `Parent` mutations from `setParent`). */
export declare function childrenOf(world: World, entity: Entity): Entity[];
/**
 * Walk up `entity`'s `Parent` chain, **not including `entity` itself**.
 * Order: nearest ancestor (immediate parent) first, root last — i.e.
 * `[parent, grandparent, ..., root]`.
 *
 * Terminates even over a corrupted/cyclic `Parent` graph: a `visited` set
 * stops the walk the moment it would revisit an entity, so this can never
 * infinite-loop regardless of how the cycle got there.
 */
export declare function ancestorsOf(world: World, entity: Entity): Entity[];
/**
 * Every live entity with no `Parent` component, or a `Parent` whose
 * `.entity` is `null`. `And()` with zero children is vacuously true for
 * every archetype (SPEC: `Array.prototype.every` on `[]`), so
 * `listEntities(And())` is the engine's "every live entity" selector —
 * including bare entities with no components at all.
 */
export declare function rootsOf(world: World): Entity[];
/**
 * Entities a {@link despawnTree} call is removing, per world, so the
 * despawn-orphan plugin skips them instead of scanning every `Parent` for
 * each one (O-64).
 */
export declare const cascading: WeakMap<World, ReadonlySet<number>>;
/** Worlds with the despawn-orphan plugin installed (see despawnTree). */
export declare const orphanPolicy: WeakSet<World>;
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
export declare function despawnTree(world: World, entity: Entity): void;

// file: index.d.ts
export { Parent, setParent, childrenOf, ancestorsOf, rootsOf, despawnTree, } from './hierarchy.js';
export { installHierarchy } from './despawn-orphan-plugin.js';
export { composeTransforms } from './compose-transforms.js';
export type { ComposeTransformsOptions } from './compose-transforms.js';
