/**
 * BETTER_ERRORS Phase 1 — Result discipline, errors as data.
 *
 * Covers the test list in doc/BETTER_ERRORS.md §"Phase 1 — Tests":
 *   1. void system returns produce no faults
 *   2. returned entity-scoped faults append to Faulted.faults
 *   3. two systems faulting the same entity in one tick: both entries present
 *      until consolidateFaults runs
 *   4. consolidateFaults collapses (source, kind, component) duplicates
 *   5. systemic faults (no `entity`) reach the error stream — never fake entities
 *   6. thrown user systems remain exceptions unless an explicit isolation mode
 *      is added later
 *   7. plugin install failure unwinds provided capabilities and returns Result.err
 *   8. compile-time exhaustiveness (representative samples)
 *   9. plugin error `kind` must satisfy the `${string}/${string}` template
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { defineComponent } from '../src/component.js'
import type { DomecsError, FaultEntry, PluginError, SystemFault, SystemicFault } from '../src/errors.js'
import { CONSOLIDATE_FAULTS_NAME, Faulted } from '../src/faulted.js'
import { Has } from '../src/query.js'
import { assertNever, err, match, ok } from '../src/result.js'
import { entry } from '../src/types.js'
import { createWorld } from '../src/world.js'

const Health = defineComponent<{ hp: number }>('Health', { defaults: { hp: 10 } })

describe('BETTER_ERRORS Phase 1 — errors as data', () => {
  it('1. a system returning `void` produces no faults', () => {
    const w = createWorld()
    const e = w.spawn([entry(Health, { hp: 1 })])
    w.system('quiet', { schedule: 'tick' }, () => {
      // Intentionally no return — common ergonomic case.
    })
    w.step(0.016)
    expect(w.getComponent(e, Faulted)).toBeUndefined()
  })

  it('2. an entity-scoped fault appends to Faulted.faults', () => {
    const w = createWorld()
    const e = w.spawn([entry(Health, { hp: -1 })])
    w.system('hp-validator', { schedule: 'tick' }, () => ({
      errors: [{
        entity: e,
        component: Health.name,
        error: { kind: 'schema_mismatch', component: Health.name, expected: 'hp>=0', got: 'hp=-1' },
        recoverable: true,
      } satisfies SystemFault],
    }))
    w.step(0.016)
    const f = w.getComponent(e, Faulted)
    expect(f).toBeDefined()
    expect(f!.faults.length).toBe(1)
    const entry0 = f!.faults[0]!
    expect(entry0.kind).toBe('schema_mismatch')
    expect(entry0.source).toBe('hp-validator')
    expect(entry0.component).toBe(Health.name)
    expect(entry0.recoverable).toBe(true)
    // tick is filled by the scheduler from world.time at attach.
    expect(typeof entry0.tick).toBe('number')
    // payload minus `kind` lands in detail.
    expect(entry0.detail).toMatchObject({ component: Health.name, expected: 'hp>=0', got: 'hp=-1' })
  })

  it('3. two systems faulting the same entity in one tick keep both entries pre-consolidation', () => {
    const w = createWorld()
    const e = w.spawn([entry(Health, { hp: 0 })])
    // Disable the built-in consolidator for this test so we can observe the
    // raw multi-append behaviour. Re-enabled per-test via fresh world.
    // Both systems run *before* the consolidator (priority MAX_SAFE_INTEGER).
    w.system('a', { schedule: 'tick', priority: 1 }, () => ({
      errors: [{
        entity: e,
        error: { kind: 'query_invalid', reason: 'a' },
        recoverable: false,
      }],
    }))
    w.system('b', { schedule: 'tick', priority: 2 }, () => ({
      errors: [{
        entity: e,
        error: { kind: 'query_invalid', reason: 'b' },
        recoverable: false,
      }],
    }))
    // Observe via tickEnd, which fires *after* user systems but also after
    // consolidateFaults — so we read snapshot inside system 'b' instead.
    let observed: readonly FaultEntry[] = []
    w.system('observer', { schedule: 'tick', priority: 3 }, () => {
      const f = w.getComponent(e, Faulted)
      if (f) observed = f.faults.slice()
    })
    w.step(0.016)
    expect(observed.length).toBe(2)
    expect(observed.map((x) => x.source).sort()).toEqual(['a', 'b'])
  })

  it('4. consolidateFaults collapses (source, kind, component) duplicates', () => {
    const w = createWorld()
    const e = w.spawn([entry(Health, { hp: 0 })])
    // Two faults with the same (source, kind, component) signature; only the
    // latter should survive end-of-tick consolidation. Use a single system
    // returning multiple SystemFaults so both share `source`.
    w.system('dup', { schedule: 'tick', priority: 1 }, () => ({
      errors: [
        { entity: e, component: Health.name, error: { kind: 'schema_mismatch', component: Health.name, expected: 'a', got: 'x' }, recoverable: true },
        { entity: e, component: Health.name, error: { kind: 'schema_mismatch', component: Health.name, expected: 'b', got: 'y' }, recoverable: true },
      ],
    }))
    w.step(0.016)
    const f = w.getComponent(e, Faulted)
    expect(f).toBeDefined()
    expect(f!.faults.length).toBe(1)
    // The most-recent entry wins (Map insertion order with later override).
    expect(f!.faults[0]!.detail).toMatchObject({ expected: 'b', got: 'y' })
  })

  it('4b. consolidateFaults keeps faults with distinct (source, kind, component) tuples', () => {
    const w = createWorld()
    const e = w.spawn([entry(Health, { hp: 0 })])
    w.system('keeper', { schedule: 'tick', priority: 1 }, () => ({
      errors: [
        { entity: e, component: Health.name, error: { kind: 'schema_mismatch', component: Health.name, expected: 'a', got: 'x' }, recoverable: true },
        { entity: e, error: { kind: 'query_invalid', reason: 'nope' }, recoverable: false },
      ],
    }))
    w.step(0.016)
    const f = w.getComponent(e, Faulted)
    expect(f!.faults.length).toBe(2)
  })

  it('5. systemic faults (no entity) route to the error stream and never attach a Faulted', () => {
    const w = createWorld()
    const inbox: SystemicFault[] = []
    w.signals.faultRaised.subscribe((f) => inbox.push(f))
    w.system('lonely', { schedule: 'tick' }, () => ({
      errors: [{
        // no `entity`
        error: { kind: 'persist_io', op: 'save', cause: { message: 'disk full' } },
        recoverable: true,
      }],
    }))
    w.step(0.016)
    expect(inbox.length).toBe(1)
    expect(inbox[0]!.source).toBe('lonely')
    expect(inbox[0]!.entry.kind).toBe('persist_io')
    // No phantom entity was created to host the fault.
    const faultedQuery = w.query(Has(Faulted))
    expect(faultedQuery.size).toBe(0)
  })

  it('6. thrown user systems remain exceptions (no implicit isolation in Phase 1)', () => {
    const w = createWorld()
    w.system('explode', { schedule: 'tick' }, () => {
      throw new Error('boom')
    })
    expect(() => w.step(0.016)).toThrowError(/boom/)
  })

  it('7. a thrown plugin install unwinds capabilities and returns plugin_install_failed', () => {
    const w = createWorld()
    const r = w.use({
      name: 'bad',
      provides: ['cap-x'],
      install: () => {
        throw new Error('install crashed')
      },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // exhaustive `match` validates the discriminant compile-time.
      const handled = match<DomecsError, string>(r.error, {
        plugin_install_failed: (e) => `${e.plugin}:${e.cause.message}`,
        system_threw: () => 'st',
        persist_io: () => 'io',
        migration_failed: () => 'mf',
        schema_mismatch: () => 'sm',
        query_invalid: () => 'qi',
        event_handler_threw: () => 'eh',
      })
      expect(handled).toBe('bad:install crashed')
    }
    // capability slot was unwound — a different plugin can now claim it.
    const r2 = w.use({ name: 'good', provides: ['cap-x'], install: () => ok(undefined) })
    expect(r2.ok).toBe(true)
  })

  it('7b. an install that returns Result.err also unwinds capabilities', () => {
    const w = createWorld()
    const r = w.use({
      name: 'returnsErr',
      provides: ['cap-y'],
      install: () => err<DomecsError>({ kind: 'query_invalid', reason: 'no thanks' }),
    })
    expect(r.ok).toBe(false)
    const r2 = w.use({ name: 'good2', provides: ['cap-y'], install: () => ok(undefined) })
    expect(r2.ok).toBe(true)
  })

  it('built-in consolidator is registered with the canonical name', () => {
    // Sanity check: the world auto-registers the end-of-tick consolidator.
    // We exercise it through behaviour above, but verify the registration
    // name is stable so userland can disable it via SystemHandle.
    expect(CONSOLIDATE_FAULTS_NAME).toBe('domecs:consolidateFaults')
  })
})

describe('BETTER_ERRORS Phase 1 — compile-time guarantees', () => {
  // 8. Representative `match` site: this *would* fail to compile if a new
  // variant were added to DomecsError without updating the cases map. We
  // exercise the runtime path with one representative kind.
  it('8. match() is exhaustive over the closed DomecsError union', () => {
    const err: DomecsError = { kind: 'query_invalid', reason: 'bad shape' }
    const label = match<DomecsError, string>(err, {
      plugin_install_failed: () => 'plugin',
      system_threw: () => 'system',
      persist_io: () => 'persist',
      migration_failed: () => 'migrate',
      schema_mismatch: () => 'schema',
      query_invalid: (e) => `query:${e.reason}`,
      event_handler_threw: () => 'event',
    })
    expect(label).toBe('query:bad shape')
  })

  it('8b. assertNever provides an escape hatch for explicit switches', () => {
    function summarise(e: DomecsError): string {
      switch (e.kind) {
        case 'plugin_install_failed': return 'p'
        case 'system_threw': return 's'
        case 'persist_io': return 'i'
        case 'migration_failed': return 'm'
        case 'schema_mismatch': return 'h'
        case 'query_invalid': return 'q'
        case 'event_handler_threw': return 'e'
        default: return assertNever(e)
      }
    }
    expect(summarise({ kind: 'query_invalid', reason: 'x' })).toBe('q')
  })

  it('9. PluginError kinds must satisfy `${string}/${string}` (compile-time)', () => {
    // Valid: namespaced kind compiles.
    const goodKind: PluginError['kind'] = 'my-plugin/timeout'
    expect(goodKind).toBe('my-plugin/timeout')

    // The negative assertion lives in the type system: a flat kind like
    // 'timeout' fails to satisfy `${string}/${string}`. We use expectTypeOf
    // (vitest's compile-time helper) to encode the constraint.
    expectTypeOf<PluginError['kind']>().toEqualTypeOf<`${string}/${string}`>()
  })
})

describe('BETTER_ERRORS Phase 4 — strictReturns dev-mode guardrail', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('warns once when a system returns a value not shaped like SystemResult', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = createWorld({ strictReturns: true })
    // Typo: `erorrs` instead of `errors`. Silent without the guardrail.
    w.system('typo', { schedule: 'tick' }, () => ({ erorrs: [] }) as unknown as void)
    w.step(0.016)
    w.step(0.016)
    expect(warn).toHaveBeenCalledTimes(1)
    const [msg] = warn.mock.calls[0]!
    expect(String(msg)).toContain('"typo"')
    expect(String(msg)).toContain('doc/error-handling.md')
  })

  it('does not warn under default options (strictReturns off)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = createWorld()
    w.system('typo', { schedule: 'tick' }, () => ({ erorrs: [] }) as unknown as void)
    w.step(0.016)
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not warn for well-formed SystemResult returns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = createWorld({ strictReturns: true })
    w.system('well-formed', { schedule: 'tick' }, () => ({ errors: [] }))
    w.step(0.016)
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not warn for void returns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = createWorld({ strictReturns: true })
    w.system('void', { schedule: 'tick' }, () => {})
    w.step(0.016)
    expect(warn).not.toHaveBeenCalled()
  })
})
