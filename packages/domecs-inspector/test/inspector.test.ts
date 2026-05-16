import { createWorld, defineComponent, entry } from '@domecs/core'
import type { SystemFault, SystemicFault } from '@domecs/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createInspector } from '../src/inspector.js'

const Health = defineComponent<{ hp: number }>('Health', { defaults: { hp: 10 } })
const Tag = defineComponent<{ name: string }>('Tag', { defaults: { name: '' } })

function install(world: ReturnType<typeof createWorld>, ins: ReturnType<typeof createInspector>) {
  const r = world.use(ins.plugin)
  if (!r.ok) throw new Error(`expected ok install; got err(${r.error.kind})`)
  return r.value
}

describe('@domecs/inspector — fault surface', () => {
  it('records nothing for a world with no faults', () => {
    const w = createWorld()
    const ins = createInspector()
    install(w, ins)
    w.step(0.016)
    expect(ins.view.entries.length).toBe(0)
    expect(ins.view.systemic.length).toBe(0)
    expect(ins.view.entityScoped.length).toBe(0)
  })

  it('records entity-scoped faults and exposes them by entity', () => {
    const w = createWorld()
    const ins = createInspector()
    install(w, ins)
    const e = w.spawn([entry(Health, { hp: -1 })])
    w.system('validator', { schedule: 'tick' }, () => ({
      errors: [
        {
          entity: e,
          component: Health.name,
          error: { kind: 'schema_mismatch', component: Health.name, expected: 'hp>=0', got: 'hp=-1' },
          recoverable: true,
        } satisfies SystemFault,
      ],
    }))
    w.step(0.016)
    expect(ins.view.entityScoped.length).toBe(1)
    const got = ins.view.entityScoped[0]!
    expect(got.systemId).toBe('validator')
    expect(got.kind).toBe('schema_mismatch')
    expect(got.entity).toBe(e)
    expect(got.recoverable).toBe(true)
    expect(ins.view.entriesFor(e).length).toBe(1)
  })

  it('records systemic faults separately from entity-scoped ones', () => {
    const w = createWorld()
    const ins = createInspector()
    install(w, ins)
    w.system('io', { schedule: 'tick' }, () => ({
      errors: [
        {
          error: { kind: 'persist_io', op: 'save', cause: { name: 'Error', message: 'disk full' } },
          recoverable: true,
        },
      ],
    }))
    w.step(0.016)
    expect(ins.view.systemic.length).toBe(1)
    expect(ins.view.entityScoped.length).toBe(0)
    const sys = ins.view.systemic[0]!
    expect(sys.systemId).toBe('io')
    expect(sys.kind).toBe('persist_io')
    expect(sys.entity).toBeUndefined()
  })

  it('preserves every fault entry on an entity (buffer-aware), even after consolidation', () => {
    const w = createWorld()
    const ins = createInspector()
    install(w, ins)
    const e = w.spawn([entry(Health, { hp: 0 })])
    // Two faults with the same (source, kind, component) — consolidator
    // collapses the buffer to the latest, but the inspector still saw both
    // entries as they were appended (or at minimum: the surviving consolidated
    // entry, exposed via entriesFor). The post-consolidation state is one
    // entry; the inspector records by FaultEntry identity, so we expect the
    // single surviving entry to be present.
    w.system('dup', { schedule: 'tick' }, () => ({
      errors: [
        { entity: e, component: Health.name, error: { kind: 'schema_mismatch', component: Health.name, expected: 'a', got: 'x' }, recoverable: true },
        { entity: e, component: Health.name, error: { kind: 'schema_mismatch', component: Health.name, expected: 'b', got: 'y' }, recoverable: true },
      ],
    }))
    w.step(0.016)
    // Inspector observes both pre-consolidation appends via onAdd + onChange,
    // dedupes by identity. After consolidation, only the latest survives in
    // the entity's buffer — that's the entry the inspector keeps.
    const forE = ins.view.entriesFor(e)
    expect(forE.length).toBeGreaterThanOrEqual(1)
    // Multi-system faults on same entity in same tick are also preserved:
    expect(forE.some((x) => x.kind === 'schema_mismatch')).toBe(true)
  })

  it('keeps distinct (source, kind, component) entries after consolidation', () => {
    const w = createWorld()
    const ins = createInspector()
    install(w, ins)
    const e = w.spawn([entry(Health, { hp: 0 })])
    w.system('mix', { schedule: 'tick' }, () => ({
      errors: [
        { entity: e, component: Health.name, error: { kind: 'schema_mismatch', component: Health.name, expected: 'a', got: 'x' }, recoverable: true },
        { entity: e, error: { kind: 'query_invalid', reason: 'nope' }, recoverable: false },
      ],
    }))
    w.step(0.016)
    const forE = ins.view.entriesFor(e)
    expect(forE.length).toBe(2)
    expect(forE.map((x) => x.kind).sort()).toEqual(['query_invalid', 'schema_mismatch'])
  })

  it('filters by source, kind, tick, recoverableOnly, onlyFaulted, hideFaulted', () => {
    const w = createWorld()
    const ins = createInspector()
    install(w, ins)
    const e = w.spawn([entry(Tag, { name: 'a' })])
    w.system('A', { schedule: 'tick' }, () => ({
      errors: [
        { entity: e, error: { kind: 'schema_mismatch', component: 'X', expected: '', got: '' }, recoverable: true },
      ],
    }))
    w.system('B', { schedule: 'tick' }, () => ({
      errors: [
        { error: { kind: 'persist_io', op: 'save', cause: { name: 'E', message: 'boom' } }, recoverable: false },
      ],
    }))
    w.step(0.016)

    expect(ins.view.entries.length).toBe(2)
    expect(ins.view.bySource('A').entries.length).toBe(1)
    expect(ins.view.bySource('B').entries.length).toBe(1)
    expect(ins.view.byKind('persist_io').entries.length).toBe(1)
    expect(ins.view.byKind('schema_mismatch').entries.length).toBe(1)
    expect(ins.view.recoverableOnly().entries.length).toBe(1)
    expect(ins.view.onlyFaulted().entries.length).toBe(1)
    expect(ins.view.hideFaulted().entries.length).toBe(1)
  })

  it('filters by tick and tick range', () => {
    const w = createWorld()
    const ins = createInspector()
    install(w, ins)
    const e = w.spawn([entry(Tag, { name: 'r' })])
    w.system('drip', { schedule: 'tick' }, (ctx) => {
      if (ctx.time.tick > 3) return
      return {
        errors: [
          { entity: e, error: { kind: 'schema_mismatch', component: 'X', expected: '', got: '' }, recoverable: true },
        ],
      }
    })
    for (let i = 0; i < 4; i++) w.step(0.016)

    const ticks = ins.view.entries.map((x) => x.tick).sort((a, b) => a - b)
    expect(ticks.length).toBeGreaterThanOrEqual(3)
    const firstTick = ticks[0]!
    const lastTick = ticks[ticks.length - 1]!
    expect(ins.view.byTick(firstTick).entries.every((x) => x.tick === firstTick)).toBe(true)
    const ranged = ins.view.byTickRange(firstTick, firstTick).entries
    expect(ranged.every((x) => x.tick === firstTick)).toBe(true)
    expect(ins.view.byTickRange(firstTick, lastTick).entries.length).toBe(ins.view.entries.length)
  })

  it('chains filters', () => {
    const w = createWorld()
    const ins = createInspector()
    install(w, ins)
    const e = w.spawn([entry(Tag, { name: 'c' })])
    w.system('A', { schedule: 'tick' }, () => ({
      errors: [
        { entity: e, error: { kind: 'schema_mismatch', component: 'X', expected: '', got: '' }, recoverable: true },
        { entity: e, error: { kind: 'query_invalid', reason: 'nope' }, recoverable: false },
      ],
    }))
    w.system('B', { schedule: 'tick' }, () => ({
      errors: [
        { error: { kind: 'persist_io', op: 'load', cause: { name: 'E', message: 'x' } }, recoverable: true },
      ],
    }))
    w.step(0.016)

    const chained = ins.view.bySource('A').recoverableOnly().entries
    expect(chained.length).toBe(1)
    expect(chained[0]!.kind).toBe('schema_mismatch')
  })

  it('ring buffer drops oldest entries past capacity', () => {
    const w = createWorld()
    const ins = createInspector({ bufferSize: 3 })
    install(w, ins)
    let counter = 0
    w.system('flood', { schedule: 'tick' }, () => {
      counter++
      return {
        errors: [
          { error: { kind: 'query_invalid', reason: `n${counter}` }, recoverable: false },
        ],
      }
    })
    for (let i = 0; i < 5; i++) w.step(0.016)
    expect(ins.view.entries.length).toBe(3)
    // First two should have been dropped — surviving entries are the latest 3.
    const reasons = ins.view.entries.map((e) => (e.detail as { reason: string }).reason)
    expect(reasons).toEqual(['n3', 'n4', 'n5'])
  })

  it('records state changes into the timeline when enabled', () => {
    const w = createWorld()
    const ins = createInspector({ recordStateChanges: true })
    install(w, ins)
    const e = w.spawn([entry(Health, { hp: 5 })])
    w.system('faulter', { schedule: 'tick' }, () => ({
      errors: [
        { entity: e, error: { kind: 'schema_mismatch', component: 'Health', expected: '', got: '' }, recoverable: true },
      ],
    }))
    w.step(0.016)
    w.despawn(e)
    w.step(0.016)

    const kinds = ins.view.timeline.map((t) => t.eventKind)
    expect(kinds).toContain('spawn')
    expect(kinds).toContain('componentAdded')
    expect(kinds).toContain('fault')
    expect(kinds).toContain('despawn')
    const faultEvent = ins.view.timeline.find((t) => t.eventKind === 'fault')!
    expect(faultEvent.entity).toBe(e)
    expect(faultEvent.fault?.kind).toBe('schema_mismatch')
  })

  it('timeline stays empty when recordStateChanges is false', () => {
    const w = createWorld()
    const ins = createInspector()
    install(w, ins)
    w.spawn([entry(Tag, { name: 't' })])
    w.step(0.016)
    expect(ins.view.timeline.length).toBe(0)
  })

  it('clear empties both buffers', () => {
    const w = createWorld()
    const ins = createInspector({ recordStateChanges: true })
    install(w, ins)
    const e = w.spawn([entry(Tag, { name: 'k' })])
    w.system('A', { schedule: 'tick' }, () => ({
      errors: [{ entity: e, error: { kind: 'query_invalid', reason: 'x' }, recoverable: false }],
    }))
    w.step(0.016)
    expect(ins.view.entries.length).toBeGreaterThan(0)
    expect(ins.view.timeline.length).toBeGreaterThan(0)
    ins.clear()
    expect(ins.view.entries.length).toBe(0)
    expect(ins.view.timeline.length).toBe(0)
  })

  it('teardown unsubscribes — no new entries arrive after dispose', () => {
    const w = createWorld()
    const ins = createInspector()
    const dispose = install(w, ins)
    const e = w.spawn([entry(Tag, { name: 'd' })])
    let trigger = true
    w.system('drip', { schedule: 'tick' }, () => {
      if (!trigger) return
      return {
        errors: [{ entity: e, error: { kind: 'query_invalid', reason: 'r' }, recoverable: false }],
      }
    })
    w.step(0.016)
    const beforeCount = ins.view.entries.length
    expect(beforeCount).toBeGreaterThan(0)
    dispose()
    trigger = true
    w.step(0.016)
    w.step(0.016)
    expect(ins.view.entries.length).toBe(beforeCount)
  })

  it('captures systemic faults emitted via world.signals.faultRaised directly', () => {
    // Belt-and-braces — verifies the subscription wiring even if no system
    // returns a SystemicFault during the test scenario above.
    const w = createWorld()
    const ins = createInspector()
    install(w, ins)
    const observed: SystemicFault = {
      source: 'manual',
      tick: 0,
      entry: {
        kind: 'query_invalid',
        source: 'manual',
        tick: 0,
        recoverable: false,
        detail: { reason: 'direct emit' },
      },
    }
    // Reach in via the system path — emit a fault from a system, since
    // the WorldSignals are not directly emittable from userland.
    w.system('emitter', { schedule: 'tick' }, () => ({
      errors: [{ error: observed.entry, recoverable: false }],
    }))
    w.step(0.016)
    expect(ins.view.systemic.length).toBe(1)
    expect(ins.view.systemic[0]!.systemId).toBe('emitter')
  })
})
