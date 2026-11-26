import { describe, expect, it } from 'vitest'
import * as core from '../src/index.js'

// Studio finding (2026-10-19): `validateEventPayload` — the schema check
// `world.action()` / `bridge.act()` run at the command boundary (O-39) — was
// not re-exported from `@domecs/core`, so studio kept a copy that could drift.
describe('validateEventPayload (public export)', () => {
  const { createWorld, defineEvent, validateEventPayload } = core

  const Move = defineEvent<{ dx: number; mode?: 'walk' | 'run'; tag?: string }>('Move', {
    schema: {
      fields: {
        dx: { kind: 'number' },
        mode: { kind: 'enum', options: ['walk', 'run'] },
        tag: { kind: 'string' },
      },
    },
  })
  const Ping = defineEvent<{ anything: unknown }>('Ping') // no schema

  it('is exported from the package entry point', () => {
    expect(typeof validateEventPayload).toBe('function')
  })

  it('returns null for valid payloads and schema-less events', () => {
    expect(validateEventPayload(Move, { dx: 1 })).toBeNull()
    expect(validateEventPayload(Move, { dx: 1, mode: 'run', tag: 'a' })).toBeNull()
    expect(validateEventPayload(Ping, { anything: 1 })).toBeNull()
    expect(validateEventPayload(Ping, 'not even an object')).toBeNull()
  })

  it('returns a reason for malformed payloads', () => {
    expect(validateEventPayload(Move, null)).toBe('expected an object payload')
    expect(validateEventPayload(Move, [1])).toBe('expected an object payload')
    expect(validateEventPayload(Move, { dx: 1, dz: 2 })).toMatch(/unknown field "dz"/)
    expect(validateEventPayload(Move, { dx: '1' })).toMatch(/field "dx" must be a number/)
    expect(validateEventPayload(Move, { dx: 1, mode: 'fly' })).toMatch(/field "mode" must be one of/)
  })

  // Verify pass (E-fix): the unknown-field check used `key in fields`, so a
  // key inherited from Object.prototype (`toString`, `constructor`,
  // `__proto__` via JSON.parse) counted as "declared" and the payload was
  // accepted. Now that hosts call this on agent/LLM-built payloads, inherited
  // names must be rejected like any other undeclared key.
  it('rejects keys that are only inherited from Object.prototype', () => {
    for (const key of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
      expect(validateEventPayload(Move, { dx: 1, [key]: 1 })).toMatch(new RegExp(`unknown field "${key}"`))
    }
    const proto = JSON.parse('{"dx":1,"__proto__":{"polluted":true}}') as unknown
    expect(Object.keys(proto as object)).toContain('__proto__')
    expect(validateEventPayload(Move, proto)).toMatch(/unknown field "__proto__"/)

    const world = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    const result = world.action(Move, { dx: 1, constructor: 'x' } as unknown as { dx: number })
    expect(result.accepted).toBe(false)
    expect(world.time.tick).toBe(0)
  })

  it('still accepts a declared field whose name shadows an Object.prototype member', () => {
    const Named = defineEvent<{ toString?: string }>('Named', {
      schema: { fields: { toString: { kind: 'string' as const } } },
    })
    expect(validateEventPayload(Named, { toString: 'x' })).toBeNull()
    expect(validateEventPayload(Named, { toString: 1 })).toMatch(/field "toString" must be a string/)
    // Absent declared field is optional: it must not be read through the
    // prototype chain (Object.prototype.toString is a function, not a string).
    expect(validateEventPayload(Named, {})).toBeNull()
  })

  it('agrees with world.action(): the action reason embeds the same fragment', () => {
    const world = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    const bad = { dx: 1, dz: 2 } as unknown as { dx: number }
    const fragment = validateEventPayload(Move, bad)
    const result = world.action(Move, bad)
    expect(result.accepted).toBe(false)
    expect(result.reason).toBe(`invalid payload for "Move": ${fragment}`)
    expect(world.time.tick).toBe(0)
  })
})

// H-6 (Harbor findings): every declared field was optional and only its type
// was checked, so a command missing its one needed field, a NaN, a 1.5 where
// an entity id goes, or an id of nothing were all accepted, and every app
// handler re-validated its payload.
describe('payload schemas say what a command needs (H-6)', () => {
  const { createWorld, defineComponent, defineEvent, validateEventPayload, entry } = core
  const Crane = defineComponent<{ condition: number }>('VpCrane', { defaults: { condition: 1 } })
  const Ship = defineComponent<{ name: string }>('VpShip', { defaults: { name: '' } })
  const Service = defineEvent<{ crane: number; budget?: number; berth?: number }>('VpService', {
    schema: {
      fields: {
        crane: { kind: 'entity', required: true, with: ['VpCrane'] },
        budget: { kind: 'number', min: 0, max: 1000 },
        berth: { kind: 'number', integer: true, min: 0 },
      },
    },
  })

  it('rejects a payload missing a required field', () => {
    expect(validateEventPayload(Service, {})).toBe('missing required field "crane"')
    expect(validateEventPayload(Service, { crane: undefined })).toBe('missing required field "crane"')
    expect(validateEventPayload(Service, { crane: 0 })).toBeNull()
  })

  it('rejects non-finite numbers in every number field', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(validateEventPayload(Service, { crane: 0, budget: bad })).toMatch(/field "budget" must be a finite number/)
    }
    const Plain = defineEvent<{ x: number }>('VpPlain', { schema: { fields: { x: { kind: 'number' } } } })
    expect(validateEventPayload(Plain, { x: Number.NaN })).toMatch(/must be a finite number/)
  })

  it('honours min, max and integer', () => {
    expect(validateEventPayload(Service, { crane: 0, budget: -1 })).toBe('field "budget" must be >= 0, got -1')
    expect(validateEventPayload(Service, { crane: 0, budget: 1001 })).toBe('field "budget" must be <= 1000, got 1001')
    expect(validateEventPayload(Service, { crane: 0, budget: 1000 })).toBeNull()
    expect(validateEventPayload(Service, { crane: 0, berth: 1.5 })).toBe('field "berth" must be an integer, got 1.5')
    expect(validateEventPayload(Service, { crane: 0, berth: 2 })).toBeNull()
  })

  it('an entity field holds an entity id: an integer >= 0', () => {
    for (const bad of [1.5, -1, '3', Number.NaN]) {
      expect(validateEventPayload(Service, { crane: bad })).toMatch(/field "crane" must be an entity id/)
    }
  })

  it('with a world, an entity field must name a live entity holding every `with` component', () => {
    const w = createWorld({ headless: true })
    const crane = w.spawn([entry(Crane, { condition: 1 })])
    const ship = w.spawn([entry(Ship, { name: 'Ada' })])
    const gone = w.spawn([entry(Crane, { condition: 1 })])
    w.despawn(gone)
    expect(validateEventPayload(Service, { crane }, { world: w })).toBeNull()
    expect(validateEventPayload(Service, { crane: ship }, { world: w })).toBe(
      `field "crane" must name an entity with VpCrane; entity ${ship} has no VpCrane`,
    )
    expect(validateEventPayload(Service, { crane: gone }, { world: w })).toBe(
      `field "crane" must name a live entity; entity ${gone} is not alive`,
    )
  })

  it('world.action() applies all of it before any tick, and describe() shows it', () => {
    const w = createWorld({ headless: true })
    w.register(Service)
    const crane = w.spawn([entry(Crane, { condition: 1 })])
    let handled = 0
    w.system('service', { schedule: 'event', triggers: [Service] }, (ctx) => void (handled += ctx.events.of(Service).length))
    for (const bad of [{}, { crane: 99 }, { crane, budget: Number.NaN }, { crane, berth: 0.5 }]) {
      const r = w.action(Service, bad as never)
      expect(r.accepted).toBe(false)
      expect(r.reason).toMatch(/^invalid payload for "VpService": /)
    }
    expect(w.time.tick).toBe(0)
    expect(w.action(Service, { crane }).accepted).toBe(true)
    expect(handled).toBe(1)
    const fields = w.describe().events.find((e) => e.name === 'VpService')!.fields
    expect(fields.crane).toEqual({ kind: 'entity', required: true, with: ['VpCrane'] })
    expect(fields.berth).toEqual({ kind: 'number', integer: true, min: 0 })
  })

  it('partial: true checks only the fields given (for tools that build a payload a field at a time)', () => {
    expect(validateEventPayload(Service, { budget: 5 }, { partial: true })).toBeNull()
    expect(validateEventPayload(Service, { budget: -5 }, { partial: true })).toMatch(/must be >= 0/)
    expect(validateEventPayload(Service, { nope: 1 }, { partial: true })).toMatch(/unknown field "nope"/)
  })
})
