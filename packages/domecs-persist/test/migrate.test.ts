import type { WorldSnapshot } from '@domecs/core'
import { err, ok } from '@domecs/core'
import { describe, expect, it } from 'vitest'
import { BUILTIN_MIGRATIONS, migrate, type Migration } from '../src/migrate.js'

function snap(version: number, extras: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    version,
    seed: [1, 2, 3, 4],
    tick: 0,
    entities: [],
    ...extras,
  }
}

describe('@domecs/persist — migrate', () => {
  it('returns the snapshot unchanged when already at target', () => {
    const s = snap(3)
    const r = migrate(s, 3, new Map())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(s)
  })

  it('applies a single step', () => {
    const bump: Migration = (s) => ok({ ...s, version: s.version + 1, meta: { stepped: true } })
    const r = migrate(snap(1), 2, new Map([[1, bump]]))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.version).toBe(2)
      expect(r.value.meta).toEqual({ stepped: true })
    }
  })

  it('applies multi-step chains in order', () => {
    const order: number[] = []
    const m: Migration = (s) => {
      order.push(s.version)
      return ok({ ...s, version: s.version + 1 })
    }
    const r = migrate(snap(1), 4, new Map([[1, m], [2, m], [3, m]]))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.version).toBe(4)
    expect(order).toEqual([1, 2, 3])
  })

  it('fails when no migration is registered for the current step', () => {
    const r = migrate(snap(1), 3, new Map())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('migration_failed')
      expect(r.error.from).toBe(1)
      expect(r.error.to).toBe(2)
      expect(r.error.reason).toMatch(/no migration registered/)
      expect(r.error.recoverable).toBe(false)
    }
  })

  it('propagates an err returned by a migration step', () => {
    const fail: Migration = () =>
      err({ kind: 'migration_failed', from: 1, to: 2, reason: 'schema drift', recoverable: true, retryable: false })
    const r = migrate(snap(1), 2, new Map([[1, fail]]))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.reason).toBe('schema drift')
      expect(r.error.recoverable).toBe(true)
    }
  })

  it('catches throws inside a migration and normalizes the cause into reason', () => {
    const boom: Migration = () => {
      throw new Error('disk on fire')
    }
    const r = migrate(snap(1), 2, new Map([[1, boom]]))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('migration_failed')
      expect(r.error.from).toBe(1)
      expect(r.error.to).toBe(2)
      expect(r.error.reason).toMatch(/disk on fire/)
      expect(r.error.recoverable).toBe(false)
    }
  })

  it('errors out when a migration fails to advance the version (would otherwise infinite-loop)', () => {
    const lazy: Migration = (s) => ok({ ...s })
    const r = migrate(snap(1), 2, new Map([[1, lazy]]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toMatch(/did not advance/)
  })

  it('BUILTIN_MIGRATIONS carries a 1->2 step that bumps the version (review #16)', () => {
    const step = BUILTIN_MIGRATIONS.get(1)
    expect(step).toBeDefined()
    const r = step!(snap(1))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.version).toBe(2)
  })

  it('errors out when the snapshot is newer than the supported target', () => {
    const r = migrate(snap(5), 3, new Map())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.from).toBe(5)
      expect(r.error.to).toBe(3)
      expect(r.error.reason).toMatch(/newer than supported target/)
    }
  })
})
