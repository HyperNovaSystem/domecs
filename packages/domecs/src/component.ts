import type { ComponentOptions, ComponentType } from './types.js'

const tag = Symbol('domecs.component')

export interface InternalComponentType<T> extends ComponentType<T> {
  readonly __tag: symbol
  readonly __defaults: Partial<T> | undefined
  readonly __transient: boolean
  readonly __validate: ((value: T) => true | string) | undefined
}

export function defineComponent<T>(
  name: string,
  options: ComponentOptions<T> = {},
): ComponentType<T> {
  const defaults = options.defaults
  const shape = {
    name,
    __tag: tag,
    __defaults: defaults,
    __transient: options.transient ?? false,
    __validate: options.validate,
    create(value?: Partial<T>): T {
      return { ...(defaults ?? {}), ...(value ?? {}) } as T
    },
  }
  return shape as unknown as ComponentType<T>
}

export function internal<T>(type: ComponentType<T>): InternalComponentType<T> {
  return type as InternalComponentType<T>
}
