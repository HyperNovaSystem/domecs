import type {
  ComponentType,
  Entity,
  EntityView,
  FieldsFromComponents,
  QueryShorthand,
  ResourceType,
  World,
} from '@domecs/core'

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
export type ChangedOn =
  | { readonly mode: 'auto'; readonly resources?: ReadonlyArray<ResourceType<any>> }
  | { readonly mode: 'always' }
  /** The same as `'always'`, under its 2.x name. */
  | { readonly mode: 'legacy' }
  | {
      readonly mode: 'explicit'
      readonly types: ReadonlyArray<ComponentType<unknown>>
      readonly resources?: ReadonlyArray<ResourceType<any>>
    }

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly view?: ViewDef<any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly views?: ReadonlyArray<ViewDef<any>>
  of(entity: EntityView<Fields>): Entity | ParentRef | null | undefined
  readonly at?: string
}

/** H-21: the element an entity's element hangs in: `view`'s for `entity`, at `at`. */
export interface ParentRef {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly view: ViewDef<any>
  readonly entity: Entity
  /** Overrides `ViewParent.at` for this placement. */
  readonly at?: string
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
  readonly slot: string
  readonly query: QueryShorthand
  readonly changedOn?: ChangedOn
  /**
   * Keep this view's nodes ordered by `order(entity)`, ascending, ties by
   * entity id (H-10) — a queue, a ranked list. Re-evaluated for every node
   * whenever one of the view's nodes is created or updated, so a key should
   * depend on what the view redraws on. A non-finite key sorts last. Nodes
   * of other views in the same container are not moved.
   */
  order?(entity: EntityView<Fields>): number
  /**
   * Mount each element inside another view's element instead of the slot
   * (H-8): a box on the deck of the ship that holds it. Re-evaluated when the
   * entity is updated (give the view an `update` to re-parent on change).
   * While the parent has no element — not mounted yet, or gone — the
   * element stays mounted but out of the page, and is attached as soon as
   * the parent's is. Parents are committed before their children.
   */
  readonly parent?: ViewParent<Fields>
  create(entity: EntityView<Fields>): HTMLElement
  update?(el: HTMLElement, entity: EntityView<Fields>): void
  destroy?(el: HTMLElement, entity: EntityView<Fields>): void
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
export function defineView<T extends ReadonlyArray<ComponentType<unknown, string>>>(
  def: Omit<ViewDef<FieldsFromComponents<T>>, 'query'> & { readonly query: readonly [...T] },
): ViewDef<FieldsFromComponents<T>>
export function defineView(def: ViewDef): ViewDef
export function defineView(def: ViewDef): ViewDef {
  return def
}

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
  readonly slot: string
  render(world: World): string
  readonly changedOn?: {
    readonly types?: ReadonlyArray<ComponentType<unknown>>
    readonly resources?: ReadonlyArray<ResourceType<any>>
  }
  /**
   * Render at most once every `everyFrames` commits (H-24): a panel that
   * sums a whole world whose inputs change every frame. A change in between
   * is kept and rendered when the panel is next due; `invalidate(slot)` and
   * a `restore()` render at the next commit whatever the rate. An integer
   * >= 1; default 1.
   */
  readonly everyFrames?: number
}

/** Identity helper for a {@link PanelDef}, like {@link defineView}. */
export function definePanel(def: PanelDef): PanelDef {
  return def
}
