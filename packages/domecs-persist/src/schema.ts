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
  /** Free-text meaning of the field (`FieldSchema.description`); round-trips, never dropped. */
  description?: string
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
    if (field.description !== undefined) data.description = field.description
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
 * - Malformed input — `data` not an array, an entry without a string
 *   `name` or a `fields` array, a field without a string `name` — skips
 *   that entry or field (O-63).
 * - A field named `__proto__`, or repeating an earlier field's name, is
 *   skipped; a `default` that does not fit the field's kind (or enum
 *   `options`), or a `description` that is not a string, is dropped,
 *   keeping the field.
 */
export function registerComponentTypes(
  data: ComponentTypeData[],
  reserved: ReadonlySet<string>,
): { types: ComponentType<unknown>[]; problems: SchemaProblem[] } {
  const types: ComponentType<unknown>[] = []
  const problems: SchemaProblem[] = []
  const seen = new Set<string>()

  // O-63 (P5): `data` comes from documents, so its shape is checked too —
  // "never throws" has to hold for malformed input, not just bad kinds.
  if (!Array.isArray(data)) {
    problems.push({ path: 'componentTypes', message: 'expected an array of component types' })
    return { types, problems }
  }
  for (let i = 0; i < data.length; i++) {
    const entry = data[i] as ComponentTypeData | null | undefined
    const path = `componentTypes[${i}]`

    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || entry.name === '') {
      problems.push({ path, message: 'expected an object with a non-empty string "name"' })
      continue
    }
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
    if (!Array.isArray(entry.fields)) {
      problems.push({ path: `${path}.fields`, message: 'expected an array of fields' })
      continue
    }
    seen.add(entry.name)

    // Null-prototype maps: a field named like an Object.prototype member is
    // stored as data, never resolved through the prototype.
    const fields: Record<string, FieldSchema> = Object.create(null)
    const defaults: Record<string, unknown> = Object.create(null)
    for (let j = 0; j < entry.fields.length; j++) {
      const field = entry.fields[j] as ComponentFieldData | null | undefined
      const fieldPath = `${path}.fields[${j}]`
      if (!field || typeof field !== 'object' || typeof field.name !== 'string' || field.name === '') {
        problems.push({ path: fieldPath, message: 'expected an object with a non-empty string "name"' })
        continue
      }
      if (field.name === '__proto__') {
        problems.push({ path: `${fieldPath}.name`, message: 'field name "__proto__" is not allowed' })
        continue
      }
      if (Object.hasOwn(fields, field.name)) {
        problems.push({ path: `${fieldPath}.name`, message: `duplicate field name "${field.name}"` })
        continue
      }
      if (!FIELD_KINDS.has(field.kind)) {
        problems.push({
          path: `${fieldPath}.kind`,
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
        ...(typeof field.description === 'string' ? { description: field.description } : {}),
      }
      if (field.description !== undefined && typeof field.description !== 'string') {
        // The field stays; only the description is dropped.
        problems.push({ path: `${fieldPath}.description`, message: 'description must be a string' })
      }
      fields[field.name] = fieldSchema
      if (field.default !== undefined) {
        const mismatch = defaultMismatch(fieldSchema, field.default)
        if (mismatch) {
          // The field stays; only the default is dropped.
          problems.push({ path: `${fieldPath}.default`, message: mismatch })
        } else {
          defaults[field.name] = field.default
        }
      }
    }

    types.push(
      defineComponent(entry.name, {
        schema: { fields: { ...fields } },
        defaults: { ...defaults },
        transient: entry.transient ?? false,
      }),
    )
  }

  return { types, problems }
}

/**
 * O-63 (P5): why `value` cannot be the default of a field of this schema,
 * or null when it can.
 */
function defaultMismatch(schema: FieldSchema, value: unknown): string | null {
  switch (schema.kind) {
    case 'number':
      return typeof value === 'number' ? null : `default for a number field must be a number, got ${typeof value}`
    case 'string':
      return typeof value === 'string' ? null : `default for a string field must be a string, got ${typeof value}`
    case 'boolean':
      return typeof value === 'boolean' ? null : `default for a boolean field must be a boolean, got ${typeof value}`
    case 'enum':
      if (schema.options && !schema.options.includes(value as string | number)) {
        return `default ${JSON.stringify(value)} is not one of the enum options`
      }
      return typeof value === 'string' || typeof value === 'number'
        ? null
        : `default for an enum field must be a string or number, got ${typeof value}`
    case 'object':
      return value !== null && typeof value === 'object' ? null : 'default for an object field must be an object'
    case 'unknown':
      return null
  }
}
