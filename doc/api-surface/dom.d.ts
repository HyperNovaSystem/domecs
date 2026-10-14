// file: index.d.ts
export { defineView } from './view.js';
export { mountDOM } from './mount.js';
export type { ViewDef, ChangedOn } from './view.js';
export type { MountOptions, MountHandle, MountError } from './mount.js';

// file: mount.d.ts
import type { World } from '@domecs/core';
import { type Result } from '@domecs/core';
import type { ViewDef } from './view.js';
export interface MountOptions {
    readonly slots: Readonly<Record<string, HTMLElement>>;
    readonly views: ReadonlyArray<ViewDef>;
}
export interface MountHandle {
    teardown(): void;
}
/**
 * Discriminated union of all expected failure modes for {@link mountDOM}.
 *
 * - `slot_already_mounted`: the named slot is already claimed by a prior
 *   `mountDOM` call on the same world (SPEC §5.6 — slot mounting is exclusive).
 * - `unregistered_slot`: a view targets a slot name that was not supplied in
 *   `opts.slots`.
 * - `plugin_install_failed`: the internal renderer plugin could not be
 *   installed (e.g. `mountDOM` called twice on the same world after teardown
 *   has not fully cleaned up, or a programmer-error duplicate plugin name).
 * - `invalid_view_query`: a view's query contains a temporal node
 *   (`OnAdded`/`OnRemoved`/`OnChanged`/`OnChangedResource`). View membership
 *   is a standing set; use `changedOn` for change-gated redraws (O-52).
 * - `invalid_changed_on`: a view with `update` has no redraw trigger —
 *   `{ mode: 'explicit', types: [] }`, or `auto` over a query with no
 *   positive `Has`/`Where` leaf. Use `{ mode: 'legacy' }` to redraw every
 *   tick on purpose (O-55).
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
 */
export declare function mountDOM(world: World, opts: MountOptions): Result<MountHandle, MountError>;

// file: view.d.ts
import type { ComponentType, EntityView, FieldsFromComponents, QueryShorthand } from '@domecs/core';
/**
 * Discriminated union controlling when a view's `update` callback fires.
 *
 * - `{ mode: 'auto' }` — derive `OnChanged(T)` from every `Has(T)` leaf in
 *   the view's query (P-3). A view over `[Position, Velocity]` auto-redraws
 *   when either component is marked changed. This is the default when
 *   `changedOn` is omitted.
 * - `{ mode: 'legacy' }` — update every mounted entity on every tick, even
 *   when no component is marked changed. Useful for time-driven animations.
 * - `{ mode: 'explicit'; types: [T, …] }` — gate redraws on exactly the
 *   listed component types (e.g. gate a `[Position, Sprite]` view on
 *   `Position` only).
 */
export type ChangedOn = {
    readonly mode: 'auto';
} | {
    readonly mode: 'legacy';
} | {
    readonly mode: 'explicit';
    readonly types: ReadonlyArray<ComponentType<unknown>>;
};
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
 * change-gated. Use `{ mode: 'legacy' }` only when you need every mounted
 * entity redrawn every tick (time-driven animation).
 */
export interface ViewDef<Fields = Record<string, unknown>> {
    readonly slot: string;
    readonly query: QueryShorthand;
    readonly changedOn?: ChangedOn;
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
