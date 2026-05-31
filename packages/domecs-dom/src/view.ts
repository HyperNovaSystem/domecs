import type {
  ComponentType,
  EntityView,
  FieldsFromComponents,
  QueryShorthand,
} from '@domecs/core'

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
 * `changedOn`:
 *   - omitted (default): redraws are gated by `OnChanged(T)` for every `Has(T)`
 *     leaf in the view's query (P-3). A view over `[Position, Velocity]`
 *     auto-redraws when either component is marked changed.
 *   - explicit empty array (`changedOn: []`): redraw every tick (legacy
 *     "update everything" behaviour; useful for time-driven animations).
 *   - explicit non-empty array: gate redraws on this set only.
 */
export interface ViewDef<Fields = Record<string, unknown>> {
  readonly slot: string
  readonly query: QueryShorthand
  readonly changedOn?: ReadonlyArray<ComponentType<unknown>>
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
