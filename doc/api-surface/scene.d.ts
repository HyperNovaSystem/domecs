// file: build-id.d.ts
/**
 * Build identity (ED-15). `'dev'` in source and in a plain workspace build;
 * `scripts/pack-for-studio.mjs` rewrites the built `dist/build-id.js` to
 * `'<version>+g<sha>[-dirty]'` before packing, and a published build
 * carries the plain version. Hosts stamp it next to their runtime identity
 * so two packs of the same version stay distinguishable.
 */
export declare const BUILD_ID: string;

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

// file: contacts.d.ts
import { type ComponentType, type Entity, type EventType, type Plugin, type ResourceType } from '@domecs/core';
/** The phase of a {@link Contact}: it started, continues, or stopped this run. */
export type ContactPhase = 'begin' | 'stay' | 'end';
/** Payload of a {@link Contact} event. */
export interface ContactPayload {
    /** The entity carrying the pair's first tag (the lower id for a same-tag pair). */
    readonly a: Entity;
    /** The entity carrying the pair's second tag. */
    readonly b: Entity;
    readonly phase: ContactPhase;
}
/**
 * Emitted by {@link installContacts} when two colliders start (`'begin'`),
 * keep (`'stay'`, opt-in) or stop (`'end'`) overlapping. Declares a schema,
 * so rules can read `event.a`, `event.b` and `event.phase`; `installContacts`
 * registers it, so `on: 'Contact'` resolves through `world.lookupEvent`.
 * Delivered the tick after the contacts system ran (bus semantics).
 */
export declare const Contact: EventType<ContactPayload>;
/** Value of {@link ContactState}. */
export interface ContactStateValue {
    /** The overlapping pairs as of the last run, sorted by (a, b), without duplicates. */
    pairs: Array<[Entity, Entity]>;
}
/**
 * The overlapping pairs the contacts system saw on its last run, sorted by
 * (a, b). An ordinary (snapshotted) resource, so a restored world continues
 * `begin`/`end` exactly where the source left off. Written by the contacts
 * system only; treat it as read-only.
 */
export declare const ContactState: ResourceType<ContactStateValue, 'ContactState'>;
/** Options for {@link installContacts}. */
export interface ContactsOptions {
    /** The position component and its coordinate fields (default `'x'` / `'y'`). */
    readonly position: {
        readonly component: ComponentType<any>;
        readonly x?: string;
        readonly y?: string;
    };
    /**
     * Radius per entity: a fixed number (finite, ≥ 0) or a component field,
     * read live each run. With a field, an entity lacking the component, or
     * whose value is not a finite number ≥ 0, is not a collider.
     */
    readonly radius: number | {
        readonly component: ComponentType<any>;
        readonly field: string;
    };
    /** Tag pairs to test (at least one), e.g. `[[Player, Enemy], [Player, Pickup]]`. */
    readonly pairs: ReadonlyArray<readonly [ComponentType<any>, ComponentType<any>]>;
    /** Emit `'stay'` each run while a pair overlaps (default false). */
    readonly stay?: boolean;
    /** Default `'fixed'` (runs per fixed step; `stepOnce` never runs it). */
    readonly schedule?: 'fixed' | 'tick';
    /** Default 150: the contacts band (SPEC §3), after transform composition at 100. */
    readonly priority?: number;
    /** Grid cell size, a performance setting only. Default 2 × a fixed radius (> 0), else 64. */
    readonly cellSize?: number;
    /** Plugin and system name. Default `'domecs-scene:contacts'`. */
    readonly name?: string;
}
/**
 * Plugin factory: overlap events for rules (spec §6.2). Each run of its
 * system (`schedule`, default `'fixed'`, at `priority` 150) indexes every
 * entity that holds the position component, at least one tag of `pairs` and
 * a valid radius in a spatial grid, finds the pairs with
 * `dx * dx + dy * dy <= (ra + rb) * (ra + rb)`, and diffs them against
 * {@link ContactState}.
 *
 * A pair `[a, b]` means `a` holds the pair's first tag and `b` its second;
 * for a same-tag pair `a < b`. An entity holding both tags of a pair can
 * appear on either side (both directions are pairs); a pair found through
 * two tag pairs counts once. Events are emitted as `end`, then `begin`, then
 * (with `stay`) `stay`, each sorted by (a, b), and rules see them the next
 * tick (`on: 'Contact', self: 'event.a', other: 'event.b'`). A despawned
 * entity, or one that lost its tag, radius or a finite position, ends its
 * pairs once on the next run. Results never depend on `cellSize`.
 *
 * Installs {@link Contact} and {@link ContactState} with `world.register`
 * (install fails when another type holds either name). One contacts plugin
 * per world: a second `use` throws (capability `domecs-scene:contacts`).
 * Throws `RangeError`/`TypeError` here for invalid options. Disposing removes
 * the system; `ContactState` keeps its last value.
 */
export declare function installContacts(options: ContactsOptions): Plugin;

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
export { createSpatialHash } from './spatial-hash.js';
export type { SpatialHashOptions, SpatialIndex } from './spatial-hash.js';
export { BUILD_ID } from './build-id.js';
export { Contact, ContactState, installContacts } from './contacts.js';
export type { ContactPayload, ContactPhase, ContactStateValue, ContactsOptions } from './contacts.js';
export { SceneMember, instantiateScene, sceneEntities, unloadScene } from './scenes.js';
export type { InstantiateSceneOptions, InstantiateSceneResult, SceneData, SceneEntityData, SceneProblem, } from './scenes.js';

// file: scenes.d.ts
import { type ComponentType, type Entity, type World } from '@domecs/core';
/**
 * Marks an entity spawned by {@link instantiateScene}: the scene's `name`
 * and the entity's key within it (after duplicate suffixing). An ordinary,
 * persistent component with a declared schema, so scene membership survives
 * `snapshot`/`restore`, saves and replay, and keeps snapshot pruning from
 * dropping an otherwise bare scene entity. Written by `instantiateScene`;
 * treat it as read-only.
 */
export declare const SceneMember: ComponentType<{
    scene: string;
    key: string;
}, 'SceneMember'>;
/** One entity of a {@link SceneData}. */
export interface SceneEntityData {
    /** Unique within the scene; `parent` and `refFields` values name entities by it. */
    readonly key: string;
    /** Component name → fields; each value is the component's defaults plus these fields. */
    readonly components: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    /** The key of the parent entity within the same scene; absent or `null` for a root. */
    readonly parent?: string | null;
}
/** A scene as plain data: a name and its entities in spawn order. */
export interface SceneData {
    readonly name: string;
    readonly entities: readonly SceneEntityData[];
}
/**
 * Something {@link instantiateScene} could not apply. `path` points into the
 * data, e.g. `entities[3].components.Target.entity` or `entities[1].parent`.
 */
export interface SceneProblem {
    readonly path: string;
    readonly message: string;
}
/** Options for {@link instantiateScene}. */
export interface InstantiateSceneOptions {
    /** Component name → type (e.g. `world.lookupComponent`, or a catalog); `undefined` for an unknown name. */
    readonly resolve: (name: string) => ComponentType<any> | undefined;
    /** Fields holding scene keys that must become live entity ids, e.g. [['Target','entity']]. */
    readonly refFields?: ReadonlyArray<readonly [component: string, field: string]>;
}
/** Result of {@link instantiateScene}. */
export interface InstantiateSceneResult {
    /** Final key → live id, in data order (a duplicate key appears suffixed, e.g. `'a#2'`). */
    readonly ids: ReadonlyMap<string, Entity>;
    /** Every problem, in the order found (spawn, then parents, then `refFields`). Empty on success. */
    readonly problems: readonly SceneProblem[];
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
 *    holds in this world, and a second component of the same type are
 *    problems: that component is skipped and the entity still spawns. A
 *    duplicate key is a problem, and the entity spawns as `key#2` (`#3`, …);
 *    a key that is not a string is a problem and the entity spawns as
 *    `#<index>`.
 * 2. **Parents** by key, in array order, through `setParent` (so a parent may
 *    come later in the array). A key the scene does not have, a self-parent
 *    and a link that would close a cycle are problems; the entity stays a
 *    root.
 * 3. **`refFields`**: in each listed component field holding a string, the
 *    key becomes the live id (the field is marked changed). An unknown key
 *    is a problem and the field is left unchanged. Values that are not
 *    strings (`null`, numbers) are left as they are.
 *
 * Keys in the data name the first entity holding them; the suffixed keys
 * exist only in `ids` and `SceneMember`. Instantiating a scene name twice
 * gives two sets of members that {@link unloadScene} removes together.
 */
export declare function instantiateScene(world: World, data: SceneData, options: InstantiateSceneOptions): InstantiateSceneResult;
/**
 * Despawn every entity of scene `name`: `despawnTree` over its member roots
 * (members whose parent is not a member of the scene), in ascending id
 * order, so descendants that are not members (a bullet parented under a
 * scene entity) go too and a member's ancestors outside the scene stay.
 * Members still alive afterwards (a corrupted `Parent` cycle) are
 * tree-despawned in ascending id order. Returns the number of entities
 * removed. Unknown or empty scene: 0.
 */
export declare function unloadScene(world: World, name: string): number;
/** The live members of scene `name` (entities whose `SceneMember.scene` is `name`), in ascending id order. */
export declare function sceneEntities(world: World, name: string): Entity[];

// file: spatial-hash.d.ts
import type { ComponentType, Entity, World } from '@domecs/core';
/** Options for {@link createSpatialHash}. */
export interface SpatialHashOptions {
    /** The component holding each entity's position. */
    readonly component: ComponentType<any>;
    /** Field holding the x coordinate (default `'x'`). */
    readonly x?: string;
    /** Field holding the y coordinate (default `'y'`). */
    readonly y?: string;
    /** Grid cell size: a pure performance setting, never changes results. */
    readonly cellSize: number;
}
/**
 * A world-bound spatial index over one position component (spec §5.1).
 *
 * Positions are those read at the last {@link SpatialIndex.refresh} (the
 * index also refreshes once when it is created). Tag filters are evaluated
 * live at query time with `world.has`: an entity must hold every listed
 * component. Results are sorted by id and, like the core grid's, never
 * depend on `cellSize`. The index is derived state and never enters a
 * snapshot.
 */
export interface SpatialIndex {
    /** Rebuild from the component's current values (O(n)). */
    refresh(): void;
    /** Ids within distance `r` of (x, y) holding every `filter` component, ascending id. */
    within(x: number, y: number, r: number, filter?: readonly ComponentType<any>[]): Entity[];
    /** The nearest id passing `filter` and other than `exclude`; ties → lowest id. */
    nearest(x: number, y: number, options?: {
        maxDistance?: number;
        filter?: readonly ComponentType<any>[];
        exclude?: Entity;
    }): Entity | undefined;
    /**
     * Pairs within distance `r` whose first element holds `a` and second holds
     * `b`. For `a !== b` every such ordered pair is listed (an entity holding
     * both tags can appear on either side); for `a === b` the first id is
     * the lower. Sorted by (first, second).
     */
    pairs(r: number, a: ComponentType<any>, b: ComponentType<any>): Array<[Entity, Entity]>;
    /** Drop the index. Any later call throws. Idempotent. */
    dispose(): void;
}
/**
 * Create a {@link SpatialIndex} over `options.component` and index the
 * world's current positions. A position whose field is not a finite number
 * is not indexed. Throws `RangeError` for a `cellSize` that is not a finite
 * number > 0.
 */
export declare function createSpatialHash(world: World, options: SpatialHashOptions): SpatialIndex;
