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
  const validate = options.validate
  const shape = {
    name,
    __tag: tag,
    __defaults: defaults,
    __transient: options.transient ?? false,
    __validate: validate,
    create(value?: Partial<T>): T {
      const merged = { ...(defaults ?? {}), ...(value ?? {}) } as T
      if (validate) {
        const verdict = validate(merged)
        if (verdict !== true) {
          throw new Error(`domecs: invalid component "${name}": ${verdict}`)
        }
      }
      return merged
    },
  }
  return shape as unknown as ComponentType<T>
}

export function internal<T>(type: ComponentType<T>): InternalComponentType<T> {
  return type as InternalComponentType<T>
}
