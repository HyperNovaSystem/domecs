import type {
  ComponentType,
  EntityView,
  FieldsFromComponents,
  QueryShorthand,
} from '@domecs/core'

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
export type ChangedOn =
  | { readonly mode: 'auto' }
  | { readonly mode: 'legacy' }
  | { readonly mode: 'explicit'; readonly types: ReadonlyArray<ComponentType<unknown>> }

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
  readonly slot: string
  readonly query: QueryShorthand
  readonly changedOn?: ChangedOn
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
