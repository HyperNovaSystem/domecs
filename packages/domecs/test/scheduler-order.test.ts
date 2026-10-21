// E3.1 (§4.3; O-76): SystemDef.order is the secondary sort key. Run order in
// a mode is priority, then order, then registration index.
import { describe, expect, it } from 'vitest'
import { createWorld } from '../src/world.js'

describe('SystemDef.order (E3.1)', () => {
  it('breaks priority ties ahead of registration index', () => {
    const w = createWorld({ headless: true })
    const ran: string[] = []
    w.system('late', { order: 2 }, () => void ran.push('late'))
    w.system('early', { order: 1 }, () => void ran.push('early'))
    w.system('default', {}, () => void ran.push('default'))
    w.system('neg', { order: -5 }, () => void ran.push('neg'))
    w.stepOnce()
    expect(ran).toEqual(['neg', 'default', 'early', 'late'])
  })

  it('priority still dominates order', () => {
    const w = createWorld({ headless: true })
    const ran: string[] = []
    w.system('p1', { priority: 1, order: -100 }, () => void ran.push('p1'))
    w.system('p0', { priority: 0, order: 100 }, () => void ran.push('p0'))
    w.stepOnce()
    expect(ran).toEqual(['p0', 'p1'])
  })

  it('equal priority and order fall back to registration index', () => {
    const w = createWorld({ headless: true })
    const ran: string[] = []
    w.system('a', { order: 3 }, () => void ran.push('a'))
    w.system('b', { order: 3 }, () => void ran.push('b'))
    w.system('c', { order: 3 }, () => void ran.push('c'))
    w.stepOnce()
    expect(ran).toEqual(['a', 'b', 'c'])
  })

  it('applies to fixed systems', () => {
    const w = createWorld({ headless: true })
    const ran: string[] = []
    w.system('b', { schedule: 'fixed', order: 2 }, () => void ran.push('b'))
    w.system('a', { schedule: 'fixed', order: 1 }, () => void ran.push('a'))
    w.step(w.time.fixedStep)
    expect(ran).toEqual(['a', 'b'])
  })

  it('a re-registered system keeps its place by order, not by registration time', () => {
    const w = createWorld({ headless: true })
    const ran: string[] = []
    const a = w.system('a', { order: 1 }, () => void ran.push('a'))
    w.system('b', { order: 2 }, () => void ran.push('b'))
    w.system('zero', {}, () => void ran.push('zero'))
    a.remove()
    w.system('a', { order: 1 }, () => void ran.push('a'))
    w.stepOnce()
    expect(ran).toEqual(['zero', 'a', 'b'])
  })

  it.each([NaN, Infinity, -Infinity])('non-finite order %s throws at world.system()', (bad) => {
    const w = createWorld({ headless: true })
    expect(() => w.system('bad', { order: bad }, () => {})).toThrow(/order/)
    expect(w.getSystem('bad')).toBeUndefined()
  })

  it('a non-number order throws (untyped callers)', () => {
    const w = createWorld({ headless: true })
    expect(() =>
      w.system('bad', { order: '1' as unknown as number }, () => {}),
    ).toThrow(/order/)
  })

  describe('removal during a phase keeps O-43 semantics', () => {
    it('a system that removes itself does not skip the next one in order', () => {
      const w = createWorld({ headless: true })
      const ran: string[] = []
      w.system('c', { order: 3 }, () => void ran.push('c'))
      w.system('b', { order: 2 }, () => void ran.push('b'))
      const a = w.system('a', { order: 1 }, () => {
        ran.push('a')
        a.remove()
      })
      w.stepOnce()
      expect(ran).toEqual(['a', 'b', 'c'])
      ran.length = 0
      w.stepOnce()
      expect(ran).toEqual(['b', 'c'])
    })

    it('a system removed by an earlier one does not run later in the same phase', () => {
      const w = createWorld({ headless: true })
      const ran: string[] = []
      const b = w.system('b', { order: 2 }, () => void ran.push('b'))
      w.system('c', { order: 3 }, () => void ran.push('c'))
      w.system('a', { order: 1 }, () => {
        ran.push('a')
        b.remove()
      })
      w.stepOnce()
      expect(ran).toEqual(['a', 'c'])
    })

    it('a system added mid-phase with a lower order runs from the next pass', () => {
      const w = createWorld({ headless: true })
      const ran: string[] = []
      let added = false
      w.system('a', { order: 1 }, () => void ran.push('a'))
      w.system('b', { order: 2 }, () => {
        ran.push('b')
        if (added) return
        added = true
        w.system('early', { order: 0 }, () => void ran.push('early'))
      })
      w.stepOnce()
      expect(ran).toEqual(['a', 'b'])
      ran.length = 0
      w.stepOnce()
      expect(ran).toEqual(['early', 'a', 'b'])
    })
  })

  it('describe().systems reports priority and order', () => {
    const w = createWorld({ headless: true })
    w.system('s', { priority: 7, order: 3 }, () => {})
    w.system('d', {}, () => {})
    const m = w.describe()
    expect(m.systems.find((s) => s.name === 's')).toMatchObject({ priority: 7, order: 3 })
    expect(m.systems.find((s) => s.name === 'd')).toMatchObject({ priority: 0, order: 0 })
  })
})
