import type { ComponentDescriptor, ComponentType, FieldKind, FieldSchema } from '@domecs/core'
import { defineComponent } from '@domecs/core'

/** The full set of `FieldKind` values a reflection widget knows how to render. */
const FIELD_KINDS: ReadonlySet<string> = new Set<FieldKind>([
  'number',
  'string',
  'boolean',
  'enum',
  'object',
  'unknown',
])

/**
 * A single defect found while turning persisted `ComponentTypeData` back
 * into live `ComponentType`s. Never thrown — always collected and returned
 * alongside whatever *did* register successfully (M0: user-authored
 * component types must degrade gracefully, not abort a whole document load).
 */
export interface SchemaProblem {
  path: string
  message: string
}

/** One field of a serialized component type — the persisted form of `FieldSchema` plus its default. */
export interface ComponentFieldData {
  name: string
  kind: FieldKind
  default?: unknown
  min?: number
  max?: number
  step?: number
  options?: (string | number)[]
  label?: string
  readonly?: boolean
}

/** The persisted, document-embeddable form of a `ComponentType` + its `ComponentDescriptor`. */
export interface ComponentTypeData {
  name: string
  transient?: boolean
  fields: ComponentFieldData[]
}

/**
 * Pure projection of a `ComponentType`'s reflection data (as obtained from
 * `world.describeComponent(type)`) into the persisted `ComponentTypeData`
 * shape. No `World` import here — the caller owns fetching the descriptor,
 * this function only reshapes it.
 *
 * Output is kept minimal: `transient` is included only when `true`, and
 * each field only carries the optional keys its `FieldSchema` / default
 * actually declared.
 */
export function serializeComponentType(
  type: ComponentType<unknown>,
  descriptor: ComponentDescriptor,
): ComponentTypeData {
  const fields: ComponentFieldData[] = []
  for (const [name, field] of Object.entries(descriptor.fields)) {
    const data: ComponentFieldData = { name, kind: field.kind }
    if (descriptor.defaults && Object.prototype.hasOwnProperty.call(descriptor.defaults, name)) {
      data.default = descriptor.defaults[name]
    }
    if (field.min !== undefined) data.min = field.min
    if (field.max !== undefined) data.max = field.max
    if (field.step !== undefined) data.step = field.step
    if (field.options !== undefined) data.options = field.options.slice()
    if (field.label !== undefined) data.label = field.label
    if (field.readonly !== undefined) data.readonly = field.readonly
    fields.push(data)
  }

  const result: ComponentTypeData = { name: type.name, fields }
  if (descriptor.transient) result.transient = true
  return result
}

/**
 * Rebuilds live `ComponentType`s from persisted `ComponentTypeData`, e.g.
 * user-authored component types loaded from a document. Never throws:
 * every defect (a name colliding with a `reserved` built-in, a duplicate
 * name within `data`, or a field with an unrecognized `kind`) is reported
 * as a {@link SchemaProblem} and the offending entry/field is skipped
 * rather than dropping data silently or aborting the whole batch.
 *
 * - A `data[i].name` in `reserved` skips the whole entry (no shadowing a
 *   built-in component type).
 * - A `data[i].name` repeated earlier in `data` skips the second (and any
 *   later) occurrence.
 * - A field whose `kind` isn't a known `FieldKind` skips just that field;
 *   the type is still registered with its remaining valid fields.
 */
export function registerComponentTypes(
  data: ComponentTypeData[],
  reserved: ReadonlySet<string>,
): { types: ComponentType<unknown>[]; problems: SchemaProblem[] } {
  const types: ComponentType<unknown>[] = []
  const problems: SchemaProblem[] = []
  const seen = new Set<string>()

  for (let i = 0; i < data.length; i++) {
    const entry = data[i]!
    const path = `componentTypes[${i}]`

    if (reserved.has(entry.name)) {
      problems.push({
        path,
        message: `component type "${entry.name}" is a reserved name and cannot be redefined`,
      })
      continue
    }
    if (seen.has(entry.name)) {
      problems.push({ path, message: 'duplicate component type name' })
      continue
    }
    seen.add(entry.name)

    const fields: Record<string, FieldSchema> = {}
    const defaults: Record<string, unknown> = {}
    for (let j = 0; j < entry.fields.length; j++) {
      const field = entry.fields[j]!
      if (!FIELD_KINDS.has(field.kind)) {
        problems.push({
          path: `componentTypes[${i}].fields[${j}].kind`,
          message: `unrecognized field kind "${String(field.kind)}"`,
        })
        continue
      }
      const fieldSchema: FieldSchema = {
        kind: field.kind,
        ...(field.min !== undefined ? { min: field.min } : {}),
        ...(field.max !== undefined ? { max: field.max } : {}),
        ...(field.step !== undefined ? { step: field.step } : {}),
        ...(field.options !== undefined ? { options: field.options.slice() } : {}),
        ...(field.label !== undefined ? { label: field.label } : {}),
        ...(field.readonly !== undefined ? { readonly: field.readonly } : {}),
      }
      fields[field.name] = fieldSchema
      if (field.default !== undefined) defaults[field.name] = field.default
    }

    types.push(
      defineComponent(entry.name, {
        schema: { fields },
        defaults,
        transient: entry.transient ?? false,
      }),
    )
  }

  return { types, problems }
}
