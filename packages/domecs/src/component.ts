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
  // Defaults with no nested object need no per-entity copy beyond the spread.
  const flatDefaults =
    defaults === undefined ||
    Reflect.ownKeys(defaults).every((k) => {
      const v = (defaults as Record<PropertyKey, unknown>)[k]
      return v === null || typeof v !== 'object'
    })
  const validate = options.validate
  const shape = {
    name,
    __tag: tag,
    __defaults: defaults,
    __transient: options.transient ?? false,
    __validate: validate,
    __schema: options.schema,
    create(value?: Partial<T>): T {
      // O-44: each entity gets its own copy of nested default arrays and
      // objects; `{...defaults}` alone shared one instance across entities.
      // Caller-supplied values are taken as given (O-34).
      const base = flatDefaults ? defaults : cloneDefaults(defaults)
      const merged = { ...base, ...(value ?? {}) } as T
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

/**
 * Copy `defaults` per entity: arrays and plain objects (null-prototype ones
 * included) are cloned recursively with their own enumerable string and
 * symbol keys, cycles preserved; anything else (class instances, Maps,
 * functions) is kept by reference, since it cannot be copied without losing
 * its identity.
 */
function cloneDefaults<T>(defaults: Partial<T> | undefined): Partial<T> {
  if (defaults === undefined) return {}
  return clonePlain(defaults, new Map()) as Partial<T>
}

function clonePlain(value: unknown, seen: Map<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value
  const done = seen.get(value)
  if (done !== undefined) return done
  if (Array.isArray(value)) {
    const out: unknown[] = []
    seen.set(value, out)
    for (const v of value) out.push(clonePlain(v, seen))
    return out
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value
  const out = Object.create(proto) as Record<PropertyKey, unknown>
  seen.set(value, out)
  for (const k of Reflect.ownKeys(value)) {
    if (!Object.prototype.propertyIsEnumerable.call(value, k)) continue
    // defineProperty, so an own `__proto__` key (JSON.parse makes them)
    // stays a plain key.
    Object.defineProperty(out, k, {
      value: clonePlain((value as Record<PropertyKey, unknown>)[k], seen),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

export function internal<T>(type: ComponentType<T>): InternalComponentType<T> {
  return type as InternalComponentType<T>
}
