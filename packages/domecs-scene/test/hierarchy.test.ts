import { describe, expect, it } from 'vitest'
import { createWorld } from '@domecs/core'
import { Parent, setParent } from '../src/index.js'

describe('setParent — cycle rejection', () => {
  it('rejects parenting an entity to itself, world state unchanged', () => {
    const world = createWorld({ headless: true })
    const a = world.spawn()

    const result = setParent(world, a, a)

    expect(result).toEqual({ ok: false, reason: expect.any(String) })
    expect(world.has(a, Parent)).toBe(false)
  })

  it('rejects parenting an ancestor under its own descendant (A<-B<-C, then setParent(A, C))', () => {
    const world = createWorld({ headless: true })
    const a = world.spawn()
    const b = world.spawn()
    const c = world.spawn()

    // B's parent is A, C's parent is B: A <- B <- C
    expect(setParent(world, b, a)).toEqual({ ok: true })
    expect(setParent(world, c, b)).toEqual({ ok: true })

    // Attempting to parent A under C would create a cycle (C is a
    // descendant of A already).
    const result = setParent(world, a, c)
    expect(result).toEqual({ ok: false, reason: expect.any(String) })

    // A must still have no Parent component (world state unchanged by the
    // rejected call).
    expect(world.has(a, Parent)).toBe(false)
    // B and C's existing relationships are untouched.
    expect(world.getComponent(b, Parent)?.entity).toBe(a)
    expect(world.getComponent(c, Parent)?.entity).toBe(b)
  })

  it('accepts a valid reparent and is reflected via getComponent', () => {
    const world = createWorld({ headless: true })
    const a = world.spawn()
    const b = world.spawn()

    const result = setParent(world, b, a)
    expect(result).toEqual({ ok: true })
    expect(world.getComponent(b, Parent)?.entity).toBe(a)
  })

  it('accepts re-parenting to null (root)', () => {
    const world = createWorld({ headless: true })
    const a = world.spawn()
    const b = world.spawn()
    expect(setParent(world, b, a)).toEqual({ ok: true })

    const result = setParent(world, b, null)
    expect(result).toEqual({ ok: true })
    expect(world.getComponent(b, Parent)?.entity).toBe(null)
  })
})
