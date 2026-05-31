export type Entity = number

declare const __componentTag: unique symbol
declare const __resourceTag: unique symbol

/**
 * Component schema. `Name` is the literal name string supplied at
 * `defineComponent('Foo')` — it propagates through queries so the resulting
 * `EntityView` has a typed `e.Foo` field instead of `unknown` (D-2).
 */
export interface ComponentType<T, Name extends string = string> {
  readonly name: Name
  readonly [__componentTag]: symbol
  create(value?: Partial<T>): T
}

/**
 * Extract a component's value type from its `ComponentType`. Replaces the
 * `ReturnType<typeof X.create>` idiom that proliferated across consumers:
 * `ComponentValue<typeof Ship>` instead of `ReturnType<typeof Ship.create>`.
 */
export type ComponentValue<C> = C extends ComponentType<infer T, string>
  ? T
  : never

export interface ComponentOptions<T> {
  defaults?: Partial<T>
  transient?: boolean
  validate?: (value: T) => true | string
  /**
   * Optional field-level schema for reflection (review #14). Lets dev tools
   * render edit widgets for this component from the world alone via
   * `world.describeComponent(type)` — no hand-rolled per-app schema registry.
   * When omitted, `describeComponent` infers field kinds from `defaults`.
   */
  schema?: ComponentSchema
}

/** Field kinds a reflection widget can render (review #14). */
export type FieldKind = 'number' | 'string' | 'boolean' | 'enum' | 'object' | 'unknown'

/**
 * Per-field reflection metadata. `kind` is required; the rest are optional
 * widget hints (numeric range/step, enum `options`, display `label`,
 * `readonly`). Field names are plain strings, not keyed to `T` — this is a
 * runtime descriptor consumed by tooling, not a type-level constraint.
 */
export interface FieldSchema {
  readonly kind: FieldKind
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly options?: ReadonlyArray<string | number>
  readonly label?: string
  readonly readonly?: boolean
}

/** A component's field schema: a map of field name → {@link FieldSchema}. */
export interface ComponentSchema {
  readonly fields: Readonly<Record<string, FieldSchema>>
}

/**
 * Result of `world.describeComponent(type)`. `fields` is resolved: the
 * explicit `schema.fields` when one was declared (`fieldsSource: 'schema'`),
 * otherwise inferred from `defaults` by runtime `typeof`
 * (`fieldsSource: 'defaults'`), otherwise empty (`fieldsSource: 'none'`).
 * `defaults` is an independent clone safe for tooling to read or mutate.
 */
export interface ComponentDescriptor {
  readonly name: string
  readonly transient: boolean
  readonly defaults: Record<string, unknown> | undefined
  readonly fields: Readonly<Record<string, FieldSchema>>
  readonly fieldsSource: 'schema' | 'defaults' | 'none'
}

/**
 * A world-singleton value, addressed by identity rather than per-entity
 * (review #16). Defined with {@link defineResource}; read/written via
 * `world.getResource(type)` / `world.setResource(type, value)`. The distinct
 * brand (`__resourceTag`) keeps resources from being passed where a
 * `ComponentType` is expected and vice-versa.
 */
export interface ResourceType<T, Name extends string = string> {
  readonly name: Name
  readonly [__resourceTag]: symbol
}

/** Extract a resource's value type from its `ResourceType`. */
export type ResourceValue<R> = R extends ResourceType<infer T, string> ? T : never

export interface ResourceOptions<T> {
  /**
   * Initial value, materialized lazily on first `resource()` read. A function
   * is treated as a per-world factory (called once per world) so object/array
   * defaults are not shared across worlds; any other value is deep-cloned per
   * world. For a resource whose value is itself a function, wrap it:
   * `default: () => myFn`.
   */
  default?: T | (() => T)
  /** Reject invalid values on `setResource` / lazy default; return `true` or a message. */
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
