import type { ComponentType, EntityView, QueryShorthand } from 'domecs'

export interface ViewDef {
  readonly slot: string
  readonly query: QueryShorthand
  readonly changedOn?: ReadonlyArray<ComponentType<unknown>>
  create(entity: EntityView): HTMLElement
  update?(el: HTMLElement, entity: EntityView): void
  destroy?(el: HTMLElement, entity: EntityView): void
}

export function defineView(def: ViewDef): ViewDef {
  return def
}
