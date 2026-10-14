import { describe, expect, it } from 'vitest'
import { createWorld, defineComponent, entry, type ComponentType } from '@domecs/core'
import { compileRule, installRules, parseExpression, type RuleDef } from '../src/index.js'

const Log = defineComponent<{ s: string }>('OrLog', { defaults: { s: '' } })
const resolve = (n: string): ComponentType<any> | undefined => (n === 'OrLog' ? Log : undefined)
const append = (name: string, ch: string, priority?: number): RuleDef => ({
  name, schedule: 'tick', query: ['OrLog'], actions: [{ set: 'OrLog.s', expr: `"${ch}"` }],
  ...(priority !== undefined ? { priority } : {}),
})

// O-69: ordering and validation.
describe('rules — ordering and validation (O-69)', () => {
  it('runs equal-priority rules in defs order and honours priority (R6)', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Log, { s: '' })])
    const h = installRules(w, [append('a', 'A'), append('b', 'B')], resolve)
    w.stepOnce()
    expect(w.getComponent(id, Log)!.s).toBe('B') // b ran last
    h.update([append('b', 'B'), append('a', 'A')])
    w.stepOnce()
    expect(w.getComponent(id, Log)!.s).toBe('A')
    h.update([append('b', 'B', -1), append('a', 'A', -2)])
    w.stepOnce()
    expect(w.getComponent(id, Log)!.s).toBe('B') // a (-2) then b (-1)
  })

  it('reports an unknown schedule and a duplicate name (R7, R8)', () => {
    const bad = compileRule({ ...append('x', 'X'), schedule: 'frame' as 'tick' }, resolve)
    expect(bad.errors[0]?.message).toMatch(/Unknown schedule "frame"/)
    const w = createWorld({ headless: true })
    const errors = installRules(w, [], resolve).update([append('d', 'A'), append('d', 'B')])
    expect(errors.get('d')?.[0]?.message).toMatch(/Duplicate rule name "d"/)
    expect(w.describe().systems.filter((s) => s.name === 'rule:d')).toHaveLength(1)
  })

  it('rejects over-long literals and unknown escapes (R11)', () => {
    expect(parseExpression('1' + '0'.repeat(400))).toEqual({ errors: [{ position: 0, message: 'Number literal out of range' }] })
    expect(parseExpression('"a\\qb"')).toEqual({ errors: [{ position: 2, message: 'Unknown escape "\\q"' }] })
  })
})
