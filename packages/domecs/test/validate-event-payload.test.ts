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
