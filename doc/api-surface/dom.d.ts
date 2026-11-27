// file: build-id.d.ts
/**
 * Build identity (ED-15). `'dev'` in source and in a plain workspace build;
 * `scripts/pack-for-studio.mjs` rewrites the built `dist/build-id.js` to
 * `'<version>+g<sha>[-dirty]'` before packing, and `pnpm publish:npm`
 * stamps the plain version (`scripts/stamp-build-id.mjs`), so a published
 * build carries it. Hosts stamp it next to their runtime identity
 * so two packs of the same version stay distinguishable.
 */
export declare const BUILD_ID: string;

// file: entity.d.ts
import type { Entity } from '@domecs/core';
/**
 * H-9: the attribute `mountDOM` stamps on every element a view mounts,
 * holding the entity id, so a DOM event can be routed back to its entity.
 */
export declare const ENTITY_ATTRIBUTE = "data-entity";
/**
 * The entity whose mounted element is `target` or holds it — the innermost
 * one, for nested views (H-8) — or `undefined` outside any. Takes an event's
 * `target` as it comes (a text node is read through its parent element).
 */
export declare function entityOf(target: EventTarget | Node | null | undefined): Entity | undefined;

// file: index.d.ts
export { defineView, definePanel } from './view.js';
export { mountDOM } from './mount.js';
export { paint, watchPresses } from './paint.js';
export { entityOf, ENTITY_ATTRIBUTE } from './entity.js';
export type { ViewDef, ViewParent, ParentRef, ChangedOn, PanelDef } from './view.js';
export type { MountOptions, MountHandle, MountError, ViewStats, PanelStats } from './mount.js';
export { BUILD_ID } from './build-id.js';

// file: mount.d.ts
import type { Entity, World } from '@domecs/core';
import { type Result } from '@domecs/core';
import type { PanelDef, ViewDef } from './view.js';
export interface MountOptions {
    readonly slots: Readonly<Record<string, HTMLElement>>;
    readonly views: ReadonlyArray<ViewDef<any>>;
    /**
     * Panels (H-7): markup derived from the world, patched into a slot of
     * their own. See {@link PanelDef}.
     */
    readonly panels?: ReadonlyArray<PanelDef>;
    /**
     * Stamp every mounted element with `data-entity="<id>"` so `entityOf` and
     * `MountHandle.on` can route DOM events back to entities (H-9). Default
     * `true`.
     */
    readonly stamp?: boolean;
}
/** One view's work since mount (P-4, O-5), from {@link MountHandle.stats}. */
export interface ViewStats {
    readonly view: ViewDef<any>;
    readonly slot: string;
    /** Elements mounted now. */
    readonly mounted: number;
    readonly creates: number;
    readonly updates: number;
    readonly destroys: number;
    /** Wall-clock milliseconds the view's last commit took. */
    readonly lastCommitMs: number;
}
/** One panel's work since mount (P-4). */
export interface PanelStats {
    readonly slot: string;
    readonly renders: number;
    /** Renders whose markup differed, so the DOM was written. */
    readonly paints: number;
    readonly lastCommitMs: number;
}
export interface MountHandle {
    teardown(): void;
    /**
     * What each view and panel of this mount has done since it was mounted
     * (P-4, O-5): creates, updates and destroys per view, renders and paints
     * per panel, and how long the last commit took — to find the view that is
     * half the frame.
     */
    stats(): {
        readonly views: ViewStats[];
        readonly panels: PanelStats[];
    };
    /**
     * The element `view` (one of this mount's views) has mounted for `entity`,
     * or `undefined` — for a selection outline, a tooltip, a measurement
     * (H-8). An element waiting for its parent (`ViewDef.parent`) is mounted
     * but not in the page.
     */
    elementOf(view: ViewDef<any>, entity: Entity): HTMLElement | undefined;
    /**
     * Render the panel in `slot` at the next commit, whatever its `changedOn`
     * and `everyFrames` say (H-24): for a repaint the world did not cause — a
     * tab change, a forecast finished off the world. A sleeping idle loop
     * does not wake for it; `world.render()` (outside a tick) repaints now.
     * Throws for a slot that holds none of this mount's panels.
     */
    invalidate(slot: string): void;
    /**
     * Listen for `type` on a slot and call `fn` with the entity whose mounted
     * element the event happened in — the innermost, for nested views — and
     * the event (H-9). Events outside this mount's elements are ignored.
     * Returns a function that stops listening; teardown stops them all. Throws
     * for a slot this mount was not given.
     */
    on<K extends keyof HTMLElementEventMap>(slot: string, type: K, fn: (entity: Entity, event: HTMLElementEventMap[K]) => void): () => void;
}
/**
 * Discriminated union of all expected failure modes for {@link mountDOM}.
 *
 * - `slot_already_mounted`: the named slot is already claimed by a prior
 *   `mountDOM` call on the same world (SPEC §5.6 — slot mounting is exclusive).
 * - `unregistered_slot`: a view or panel targets a slot name that was not
 *   supplied in `opts.slots`.
 * - `plugin_install_failed`: the internal renderer plugin could not be
 *   installed (e.g. `mountDOM` called twice on the same world after teardown
 *   has not fully cleaned up, or a programmer-error duplicate plugin name).
 * - `invalid_view_query`: a view's query contains a temporal node
 *   (`OnAdded`/`OnRemoved`/`OnChanged`/`OnChangedResource`). View membership
 *   is a standing set; use `changedOn` for change-gated redraws (O-52).
 * - `invalid_changed_on`: a view with `update` has no redraw trigger —
 *   `{ mode: 'explicit', types: [] }` without resources, or `auto` over a
 *   query with no positive `Has`/`Where` leaf. Use `{ mode: 'always' }` to
 *   redraw every tick on purpose (O-55).
 * - `invalid_parent`: a view's `parent.view` or one of its `parent.views`
 *   is not one of this mount's views, it names neither, or parents form a
 *   cycle (H-8, H-21).
 * - `invalid_panel`: a panel shares its slot with a view or another panel
 *   (H-7), or its `everyFrames` is not an integer >= 1 (H-24).
 */
export type MountError = {
    readonly kind: 'slot_already_mounted';
    readonly slot: string;
} | {
    readonly kind: 'unregistered_slot';
    readonly slot: string;
} | {
    readonly kind: 'plugin_install_failed';
    readonly reason: string;
} | {
    readonly kind: 'invalid_view_query';
    readonly slot: string;
    readonly reason: string;
} | {
    readonly kind: 'invalid_changed_on';
    readonly slot: string;
    readonly reason: string;
} | {
    readonly kind: 'invalid_parent';
    readonly slot: string;
    readonly reason: string;
} | {
    readonly kind: 'invalid_panel';
    readonly slot: string;
    readonly reason: string;
};
/**
 * Mount a DOM renderer onto `world`.
 *
 * Returns a `Result`:
 * - `ok(handle)` — renderer installed; call `handle.teardown()` to unmount.
 * - `err({ kind: 'slot_already_mounted', slot })` — the named slot is already
 *   claimed on this world (SPEC §5.6).
 * - `err({ kind: 'unregistered_slot', slot })` — a view targets a slot that
 *   was not supplied in `opts.slots`.
 * - `err({ kind: 'plugin_install_failed', reason })` — the internal renderer
 *   plugin failed to install (e.g. duplicate call on same world without prior
 *   teardown).
 * - `err({ kind: 'invalid_parent' | 'invalid_panel', … })` — see {@link MountError}.
 */
export declare function mountDOM(world: World, opts: MountOptions): Result<MountHandle, MountError>;

// file: paint.d.ts
/**
 * H-7 (Harbor findings): patch an element to match a markup string, for
 * panels drawn from strings. Writing such a panel with `innerHTML` replaces
 * the button under the pointer between press and release — so the click
 * never fires — and drops the focus on every repaint. `paint` keeps every
 * node that is still right, and `watchPresses` holds repaints off whatever
 * the primary button is pressing until the click has landed.
 */
/**
 * Make `target`'s content match `html`, keeping every node that is already
 * right — an element whose tag matches is kept and its attributes and
 * children brought into line, so focus, scroll positions and CSS
 * transitions survive. Nothing is touched when `html` is what was last
 * painted, nor while a press that `watchPresses` is tracking is under way
 * inside `target` (the markup is painted once the click has landed). True
 * when the DOM changed.
 *
 * `paint` owns `target`'s content: it compares against what it last painted,
 * so do not change that content by other means.
 */
export declare function paint(target: Element, html: string): boolean;
/**
 * Forget what {@link paint} last wrote into `target` (and any markup held
 * for it), before its content is cleared by other means — so the same
 * markup painted again is written, not skipped as already there.
 */
export declare function forgetPaint(target: Element): void;
/**
 * Keep {@link paint} off whatever the primary button is pressing in
 * `root`: what was under the pointer when the button went down is still
 * there, unchanged, when it comes up, so the click lands — and lands on what
 * was aimed at, not on what a re-sorted list has moved into its place.
 * Markup asked for meanwhile is painted as soon as the click has been
 * dispatched (or, for a press that ends without a click, on the next task).
 * Returns a function that stops watching.
 */
export declare function watchPresses(root: Document): () => void;

// file: view.d.ts
import type { ComponentType, Entity, EntityView, FieldsFromComponents, QueryShorthand, ResourceType, World } from '@domecs/core';
/**
 * Discriminated union controlling when a view's `update` callback fires.
 *
 * - `{ mode: 'auto' }` — derive `OnChanged(T)` from every `Has(T)` leaf in
 *   the view's query (P-3). A view over `[Position, Velocity]` auto-redraws
 *   when either component is marked changed. This is the default when
 *   `changedOn` is omitted.
 * - `{ mode: 'always' }` — update every mounted entity at every commit, even
 *   when no component is marked changed: a clock, a countdown, a time-driven
 *   animation. `{ mode: 'legacy' }` is the same mode under its old name.
 * - `{ mode: 'explicit'; types: [T, …] }` — gate redraws on exactly the
 *   listed component types (e.g. gate a `[Position, Sprite]` view on
 *   `Position` only).
 *
 * `resources` (auto and explicit, H-7): also redraw every mounted node when
 * one of these resources is set or marked — a camera or a selection held in
 * a transient resource, say. An explicit gate may list only resources.
 */
export type ChangedOn = {
    readonly mode: 'auto';
    readonly resources?: ReadonlyArray<ResourceType<any>>;
} | {
    readonly mode: 'always';
}
/** The same as `'always'`, under its 2.x name. */
 | {
    readonly mode: 'legacy';
} | {
    readonly mode: 'explicit';
    readonly types: ReadonlyArray<ComponentType<unknown>>;
    readonly resources?: ReadonlyArray<ResourceType<any>>;
};
/**
 * Where a view's elements go inside another view's (H-8): `view` is that
 * view (in the same `mountDOM` call), `of(entity)` the entity whose element
 * holds this one — `null` / `undefined` for the slot — and `at` an optional
 * selector for the mount point inside that element (the element itself when
 * absent or not found).
 *
 * H-21: when the holder can be of several kinds — a box aboard a ship, on a
 * crane's spreader, on a carrier's bed — list those views in `views` and
 * have `of` return a {@link ParentRef} naming the view, the entity and,
 * optionally, its own `at`. The element is then moved between them, never
 * re-created. A plain entity id from `of` means `view`.
 */
export interface ViewParent<Fields = Record<string, unknown>> {
    readonly view?: ViewDef<any>;
    readonly views?: ReadonlyArray<ViewDef<any>>;
    of(entity: EntityView<Fields>): Entity | ParentRef | null | undefined;
    readonly at?: string;
}
/** H-21: the element an entity's element hangs in: `view`'s for `entity`, at `at`. */
export interface ParentRef {
    readonly view: ViewDef<any>;
    readonly entity: Entity;
    /** Overrides `ViewParent.at` for this placement. */
    readonly at?: string;
}
/**
 * Per-view rendering definition.
 *
 * `Fields` is inferred when the view's `query` is supplied as a tuple of
 * `ComponentType`s (`defineView({ query: [Position, Sprite], … })`); in that
 * case the `entity` passed to `create` / `update` / `destroy` is typed with
 * `entity.Position` / `entity.Sprite`. Combinator-form queries fall back to
 * the generic `EntityView` shape and require manual narrowing or a
 * `world.getComponent(view.id, T)` call.
 *
 * `changedOn` controls when the `update` callback fires; see {@link ChangedOn}
 * for the three modes. Omitting `changedOn` is equivalent to
 * `{ mode: 'auto' }`.
 *
 * **First paint (O-2):** on mount, `update` (when provided) runs once for each
 * newly created node even under `auto` / `explicit` gating, so entities that
 * are spawned and never marked changed still render. Subsequent updates stay
 * change-gated. Use `{ mode: 'always' }` only when you need every mounted
 * entity redrawn every tick (time-driven animation).
 */
export interface ViewDef<Fields = Record<string, unknown>> {
    readonly slot: string;
    readonly query: QueryShorthand;
    readonly changedOn?: ChangedOn;
    /**
     * Keep this view's nodes ordered by `order(entity)`, ascending, ties by
     * entity id (H-10) — a queue, a ranked list. Re-evaluated for every node
     * whenever one of the view's nodes is created or updated, so a key should
     * depend on what the view redraws on. A non-finite key sorts last. Nodes
     * of other views in the same container are not moved.
     */
    order?(entity: EntityView<Fields>): number;
    /**
     * Mount each element inside another view's element instead of the slot
     * (H-8): a box on the deck of the ship that holds it. Re-evaluated when the
     * entity is updated (give the view an `update` to re-parent on change).
     * While the parent has no element — not mounted yet, or gone — the
     * element stays mounted but out of the page, and is attached as soon as
     * the parent's is. Parents are committed before their children.
     */
    readonly parent?: ViewParent<Fields>;
    create(entity: EntityView<Fields>): HTMLElement;
    update?(el: HTMLElement, entity: EntityView<Fields>): void;
    destroy?(el: HTMLElement, entity: EntityView<Fields>): void;
}
/**
 * Typed view factory.
 *
 * - Tuple-form `query` (e.g. `query: [Position, Sprite]`) infers
 *   `EntityView<{ Position: …; Sprite: … }>` for the callbacks.
 * - Combinator-form `query` (e.g. `query: And(Has(Position), Not(Dead))`)
 *   falls back to the unconstrained `EntityView` shape; users can either
 *   read components via `world.getComponent` or narrow at the call site.
 */
export declare function defineView<T extends ReadonlyArray<ComponentType<unknown, string>>>(def: Omit<ViewDef<FieldsFromComponents<T>>, 'query'> & {
    readonly query: readonly [...T];
}): ViewDef<FieldsFromComponents<T>>;
export declare function defineView(def: ViewDef): ViewDef;
/**
 * A panel (H-7): markup derived from the whole world — a side panel, a
 * status bar, a summary of many entities — rendered to a string and
 * patched into its own slot with `paint`, so the elements that stay (a
 * button being pressed, the focused control) are kept. The slot belongs to
 * the panel alone.
 *
 * `render` runs at the first commit, then whenever `changedOn` says: when a
 * listed component is added, changed or removed on any entity, when a
 * listed resource is set or marked, after every `restore()`, and at the
 * next commit after `MountHandle.invalidate(slot)` — for state no gate sees,
 * such as the open tab (H-24). Without `changedOn` it runs every commit (the
 * DOM is still only written when the markup differs). Run
 * `watchPresses(document)` once so a repaint never lands between a press
 * and its click.
 */
export interface PanelDef {
    readonly slot: string;
    render(world: World): string;
    readonly changedOn?: {
        readonly types?: ReadonlyArray<ComponentType<unknown>>;
        readonly resources?: ReadonlyArray<ResourceType<any>>;
    };
    /**
     * Render at most once every `everyFrames` commits (H-24): a panel that
     * sums a whole world whose inputs change every frame. A change in between
     * is kept and rendered when the panel is next due; `invalidate(slot)` and
     * a `restore()` render at the next commit whatever the rate. An integer
     * >= 1; default 1.
     */
    readonly everyFrames?: number;
}
/** Identity helper for a {@link PanelDef}, like {@link defineView}. */
export declare function definePanel(def: PanelDef): PanelDef;
