import { OnChanged, createWorld, defineComponent, entry } from '@domecs/core'
import type { SystemFault } from '@domecs/core'
import { describe, expect, it } from 'vitest'
import { createInspector } from '../src/index.js'

// O-60 (N1), fixed by O-42: a fault appended to an already-faulted entity by
// a system that runs after the inspector's observer used to be missed.

const Hp = defineComponent<{ hp: number }>('LfiHp', { defaults: { hp: 1 } })

function fault(entity: number, kind: 'query_invalid' | 'schema_mismatch'): SystemFault {
  const error =
    kind === 'query_invalid'
      ? { kind, reason: 'r', retryable: false }
      : { kind, component: Hp.name, expected: 'e', got: 'g', retryable: false }
  return { entity, error: error as SystemFault['error'], recoverable: true }
}

describe('inspector — faults from late systems (O-60 N1)', () => {
  it('records a second fault appended after its observer ran', () => {
    const w = createWorld()
    const ins = createInspector()
    const r = w.use(ins.plugin)
    if (!r.ok) throw new Error('install failed')
    const e = w.spawn([entry(Hp, { hp: 1 })])
    let first = true
    w.system('first', { schedule: 'tick' }, () => {
      if (!first) return
      first = false
      return { errors: [fault(e, 'query_invalid')] }
    })
    // A reactive system that runs after the inspector's observer (priority
    // 10) and appends to the already-faulted entity.
    w.system('late', { schedule: 'reactive', priority: 10, reactsTo: OnChanged(Hp) }, () => ({
      errors: [fault(e, 'schema_mismatch')],
    }))
    w.step(1 / 60)
    w.markChanged(e, Hp)
    for (let i = 0; i < 3; i++) w.step(1 / 60)
    const kinds = ins.view.entries.map((x) => x.kind)
    expect(kinds).toEqual(['query_invalid', 'schema_mismatch'])
  })
})
