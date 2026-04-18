export type Entity = number

declare const __componentTag: unique symbol

export interface ComponentType<T> {
  readonly name: string
  readonly [__componentTag]: symbol
  create(value?: Partial<T>): T
}

export interface ComponentOptions<T> {
  defaults?: Partial<T>
  transient?: boolean
  validate?: (value: T) => true | string
}

export type ComponentBag =
  | ReadonlyMap<ComponentType<unknown>, unknown>
  | ReadonlyArray<readonly [ComponentType<unknown>, unknown]>
