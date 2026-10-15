import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import {
  all, andThen, attempt, attemptAsync, err, mapErr, mapR, ok, tap, tapErr, unwrapOr,
} from '../src/result.js'
import { entry } from '../src/types.js'
import { createWorld } from '../src/world.js'

// O-73 (X8): direct tests for helpers only exercised indirectly before.
describe('Result combinators', () => {
  it('map, mapErr, andThen and unwrapOr act on their branch only', () => {
    expect(mapR(ok(2), (n: number) => n * 3)).toEqual(ok(6))
    expect(mapR(err('e'), (n: number) => n * 3)).toEqual(err('e'))
    expect(mapErr(err('e'), (e: string) => e.toUpperCase())).toEqual(err('E'))
    expect(mapErr(ok(1), (e: string) => e.toUpperCase())).toEqual(ok(1))
    expect(andThen(ok(2), (n: number) => (n > 1 ? ok(n) : err('small')))).toEqual(ok(2))
    expect(andThen(ok(0), (n: number) => (n > 1 ? ok(n) : err('small')))).toEqual(err('small'))
    expect(andThen(err('first'), () => ok(1))).toEqual(err('first'))
    expect(unwrapOr(ok(1), 9)).toBe(1)
    expect(unwrapOr(err('x'), 9)).toBe(9)
  })

  it('tap/tapErr run on their branch and pass the Result through', () => {
    const seen: unknown[] = []
    const a = ok(1)
    const b = err('e')
    expect(tap(a, (v) => seen.push(['ok', v]))).toBe(a)
    expect(tap(b, (v) => seen.push(['ok', v]))).toBe(b)
    expect(tapErr(b, (e) => seen.push(['err', e]))).toBe(b)
    expect(tapErr(a, (e) => seen.push(['err', e]))).toBe(a)
    expect(seen).toEqual([['ok', 1], ['err', 'e']])
  })

  it('all collects values or returns the first error', () => {
    expect(all([ok(1), ok(2)])).toEqual(ok([1, 2]))
    expect(all([ok(1), err('a'), err('b')])).toEqual(err('a'))
    expect(all([])).toEqual(ok([]))
  })

  it('attempt and attemptAsync turn throws into thrown errors', async () => {
    expect(attempt(() => 5)).toEqual(ok(5))
    const r = attempt(() => { throw new TypeError('bad') })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatchObject({ kind: 'thrown', cause: { name: 'TypeError', message: 'bad' } })
    expect(await attemptAsync(async () => 7)).toEqual(ok(7))
    const a = await attemptAsync(async () => { throw 'plain' })
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.error.kind).toBe('thrown')
  })
})

describe('world.stepN and world.setInput', () => {
  const C = defineComponent<{ n: number }>('HlC', { defaults: { n: 0 } })

  it('stepN(n) runs n turn-based ticks; stepN(n, dt) runs n timed ones, firing fixed systems', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(C, { n: 0 })])
    let fixed = 0
    w.system('t', { schedule: 'tick', query: [C] }, () => { w.getComponent(id, C)!.n++ })
    w.system('f', { schedule: 'fixed' }, () => { fixed++ })
    w.stepN(3)
    expect(w.time.tick).toBe(3)
    expect(w.getComponent(id, C)!.n).toBe(3)
    expect(fixed).toBe(0)
    w.stepN(2, w.time.fixedStep)
    expect(w.time.tick).toBe(5)
    expect(fixed).toBe(2)
  })

  it('setInput publishes a snapshot systems read', () => {
    const w = createWorld({ headless: true })
    let seen = false
    w.system('r', { schedule: 'tick' }, ({ world }) => { seen = world.input.keys.has('KeyQ') })
    w.setInput({
      keys: new Set(['KeyQ']),
      keyDelta: { pressed: new Set(['KeyQ']), released: new Set() },
      mods: { ctrl: false, alt: false, shift: false, meta: false },
      pointer: { x: 0, y: 0, buttons: 0, delta: { x: 0, y: 0 }, wheel: 0, entered: [] },
      gamepads: [],
      focus: { activeTag: '', consumesKeys: false },
    })
    w.stepOnce()
    expect(seen).toBe(true)
  })
})
