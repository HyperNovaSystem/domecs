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

/**
 * Tagged spawn entry — a (type, value) pair whose value position is tied to
 * the type's T within the same tuple. See F-7 in doc/findings.md.
 */
export type ComponentEntry<T = unknown> = readonly [ComponentType<T>, T]

// `ComponentEntry<any>` (not `<unknown>`) is load-bearing: bag-level consumers
// iterate heterogeneous tuples whose T varies per element. `unknown` propagates
// through `[ComponentType<unknown>, unknown]` and re-introduces the invariance
// assignability failure that `entry<T>()` was built to avoid; `any` opts the
// bag type out of checking *between* tuples while `entry()` preserves the
// tie *within* each tuple.
export type ComponentBag =
  | ReadonlyMap<ComponentType<unknown>, unknown>
  | ReadonlyArray<ComponentEntry<any>>

/**
 * Helper for heterogeneous spawn-tuple arrays. `entry(Position, {x,y})`
 * preserves per-tuple T inference under strict TypeScript, eliminating the
 * `as never` casts that `ComponentType<T>` invariance otherwise forces at
 * call sites (F-7).
 */
export function entry<T>(type: ComponentType<T>, value: T): ComponentEntry<T> {
  return [type, value]
}
