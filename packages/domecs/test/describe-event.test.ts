import { describe, expect, it } from 'vitest'
import { defineEvent } from '../src/events.js'
import type { ComponentSchema } from '../src/types.js'
import { createWorld } from '../src/world.js'

const DamageSchema: ComponentSchema = {
  fields: {
    amount: { kind: 'number', min: 0 },
    crit: { kind: 'boolean' },
  },
}
const Damage = defineEvent<{ amount: number; crit: boolean }>('Damage', {
  schema: DamageSchema,
})
const Ping = defineEvent<void>('Ping') // no schema

describe('world.describeEvent — event reflection (§6)', () => {
  it('reports the declared schema fields with fieldsSource=schema', () => {
    const w = createWorld()
    const d = w.describeEvent(Damage)
    expect(d.name).toBe('Damage')
    expect(d.fieldsSource).toBe('schema')
    expect(d.fields).toEqual(DamageSchema.fields)
  })

  it('reports empty fields with fieldsSource=none when no schema declared', () => {
    const w = createWorld()
    const d = w.describeEvent(Ping)
    expect(d).toEqual({ name: 'Ping', fields: {}, fieldsSource: 'none' })
  })

  it('returns a copy of fields, not the original schema reference', () => {
    const w = createWorld()
    expect(w.describeEvent(Damage).fields).not.toBe(DamageSchema.fields)
  })

  it('defineEvent without options still works (back-compatible signature)', () => {
    const E = defineEvent<number>('Legacy')
    const w = createWorld()
    expect(w.describeEvent(E).fieldsSource).toBe('none')
  })
})
