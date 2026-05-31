import { describe, expect, it } from 'vitest'
import type { DomecsError } from '../src/errors.js'
import { describeError } from '../src/errors.js'

const cause = { message: 'boom' }

describe('describeError — human-readable DomecsError formatter (review #4)', () => {
  it('formats every DomecsError variant with its salient fields', () => {
    const cases: Array<[DomecsError, RegExp]> = [
      [
        { kind: 'plugin_install_failed', plugin: 'inspector', cause, retryable: false },
        /inspector.*boom/,
      ],
      [{ kind: 'persist_io', op: 'save', cause, retryable: true }, /save.*boom/],
      [
        {
          kind: 'migration_failed',
          from: 1,
          to: 2,
          reason: 'no migrator',
          recoverable: false,
          retryable: false,
        },
        /1.*2.*no migrator/,
      ],
      [
        { kind: 'schema_mismatch', component: 'Position', expected: 'v2', got: 'v1', retryable: false },
        /Position.*v2.*v1/,
      ],
      [{ kind: 'query_invalid', reason: 'empty tree', retryable: false }, /empty tree/],
      [{ kind: 'event_handler_threw', event: 'Move', cause, retryable: true }, /Move.*boom/],
    ]
    for (const [e, re] of cases) {
      const msg = describeError(e)
      expect(typeof msg).toBe('string')
      expect(msg.length).toBeGreaterThan(0)
      expect(msg).toMatch(re)
    }
  })

  it('marks migration recoverability', () => {
    const recoverable = describeError({
      kind: 'migration_failed',
      from: 1,
      to: 2,
      reason: 'x',
      recoverable: true,
      retryable: false,
    })
    const fatal = describeError({
      kind: 'migration_failed',
      from: 1,
      to: 2,
      reason: 'x',
      recoverable: false,
      retryable: false,
    })
    expect(recoverable).toMatch(/recoverable/i)
    expect(fatal).not.toBe(recoverable)
  })
})
