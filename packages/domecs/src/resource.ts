import { cloneSerializable } from './snapshot.js'
import type { ResourceOptions, ResourceType } from './types.js'

const tag = Symbol('domecs.resource')

export interface InternalResourceType<T, Name extends string = string>
  extends ResourceType<T, Name> {
  readonly __tag: symbol
  /** Produces a fresh default value, or `undefined` when none was declared. */
  readonly __default: (() => T) | undefined
  readonly __validate: ((value: T) => true | string) | undefined
}

export function defineResource<T, const Name extends string>(
  name: Name,
  options?: ResourceOptions<T>,
): ResourceType<T, Name>
export function defineResource<T>(
  name: string,
  options?: ResourceOptions<T>,
): ResourceType<T, string>
export function defineResource<T>(
  name: string,
  options: ResourceOptions<T> = {},
): ResourceType<T, string> {
  const def = options.default
  // A function default is a factory called per world; any other value is
  // deep-cloned per world so object/array defaults are never shared.
  const defaultFactory: (() => T) | undefined =
    def === undefined
      ? undefined
      : typeof def === 'function'
        ? (def as () => T)
        : (): T => cloneSerializable(def)
  const shape = {
    name,
    __tag: tag,
    __default: defaultFactory,
    __validate: options.validate,
  }
  return shape as unknown as ResourceType<T, string>
}

export function internalResource<T>(type: ResourceType<T>): InternalResourceType<T> {
  return type as InternalResourceType<T>
}
