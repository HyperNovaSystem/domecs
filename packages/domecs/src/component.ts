import type { ComponentOptions, ComponentSchema, ComponentType } from './types.js'

const tag = Symbol('domecs.component')

export interface InternalComponentType<T, Name extends string = string>
  extends ComponentType<T, Name> {
  readonly __tag: symbol
  readonly __defaults: Partial<T> | undefined
  readonly __transient: boolean
  readonly __validate: ((value: T) => true | string) | undefined
  readonly __schema: ComponentSchema | undefined
}

/**
 * Define a component type carrying a payload `T`, keyed by `name`.
 *
 * Two overloads are intentionally kept. The first uses `const Name extends
 * string` to capture the literal name (so `view.Position` is typed when the
 * literal is known at the call site); the second widens to `string` for cases
 * where the name is a runtime value. TypeScript cannot express "infer the
 * literal when available, else widen" in a single signature, so the `Name`
 * type parameter is necessarily duplicated across the two overloads — a known
 * language limitation, not redundancy to be collapsed.
 */
export function defineComponent<T, const Name extends string>(
  name: Name,
  options?: ComponentOptions<T>,
): ComponentType<T, Name>
export function defineComponent<T>(
  name: string,
  options?: ComponentOptions<T>,
): ComponentType<T, string>
export function defineComponent<T>(
  name: string,
  options: ComponentOptions<T> = {},
): ComponentType<T, string> {
  const defaults = options.defaults
  const validate = options.validate
  const shape = {
    name,
    __tag: tag,
    __defaults: defaults,
    __transient: options.transient ?? false,
    __validate: validate,
    __schema: options.schema,
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
  return shape as unknown as ComponentType<T, string>
}

export function internal<T>(type: ComponentType<T>): InternalComponentType<T> {
  return type as InternalComponentType<T>
}
