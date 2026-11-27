import { describe, expect, it } from 'vitest'
import { accept, defineCommand } from '../src/commands.js'
import { defineEvent } from '../src/events.js'
import { defineResource } from '../src/resource.js'
import { createRecorder, replay } from '../src/replay.js'
import { ok } from '../src/result.js'
import { createWorld, type World } from '../src/world.js'

// H-25 (Harbor 3.0 findings): a `world.on` listener that called
// `world.action()` started a second tick inside the first. The inner flush
// replaced the outer tick's event view, so a command delivered alongside
// the report was never handled and came back refused for a reason that was
// not true. action(), step(), stepOnce() and turn() now refuse to run inside
// a tick, and world.afterTick(fn) is the supported way to act on what a
// listener heard.

const Speed = defineResource<number>('AtSpeed', { default: 1 })
const Hired = defineResource<number>('AtHired', { default: 0 })
const Verdict = defineEvent<{ won: boolean }>('AtVerdict')
const Pause = defineCommand<Record<string, never>>('AtPause', {
  handle(ctx) {
    ctx.world.setResource(Speed, 0)
    return accept()
  },
})
const Hire = defineCommand<Record<string, never>>('AtHire', {
  handle(ctx) {
    ctx.world.setResource(Hired, ctx.world.getResource(Hired)! + 1)
    return accept()
  },
})

function port(): World {
  const w = createWorld({ headless: true })
  w.register(Pause, Hire, Verdict, Speed, Hired)
  return w
}

describe('H-25: no tick inside a tick', () => {
  it('action() from a listener is refused, and the command delivered with the report still runs', () => {
    const w = port()
    const inner: unknown[] = []
    w.on(Verdict, () => inner.push(w.action(Pause, {})))
    w.emit(Verdict, { won: false })
    const r = w.action(Hire, {})
    expect(r.accepted).toBe(true)
    expect(w.getResource(Hired)).toBe(1)
    expect(inner).toHaveLength(1)
    expect(inner[0]).toMatchObject({ accepted: false, consumedTurn: false, events: [] })
    expect((inner[0] as { reason: string }).reason).toMatch(/"AtPause" was not run: action\(\) was called inside a tick/)
    expect((inner[0] as { reason: string }).reason).toMatch(/world\.afterTick/)
    // Refused before the emit: nothing is left queued to run later.
    w.stepOnce()
    expect(w.getResource(Speed)).toBe(1)
  })

  it('step, stepOnce and turn throw inside a tick, naming afterTick', () => {
    const w = port()
    const errors: string[] = []
    w.system('poke', { schedule: 'tick' }, () => {
      for (const f of [() => w.step(1 / 60), () => w.stepOnce(), () => w.turn(Hire, {}), () => w.step(0)]) {
        try {
          f()
          errors.push('no throw')
        } catch (e) {
          errors.push((e as Error).message)
        }
      }
    })
    w.stepOnce()
    expect(errors).toHaveLength(4)
    expect(errors[0]).toMatch(/^domecs: step must be called outside a tick.*world\.afterTick/)
    expect(errors[1]).toMatch(/^domecs: stepOnce must be called outside a tick/)
    expect(errors[2]).toMatch(/^domecs: turn must be called outside a tick/)
    expect(errors[3]).toMatch(/^domecs: step must be called outside a tick/)
    expect(w.time.tick).toBe(1)
    // turn() was refused before its emit.
    w.stepOnce()
    expect(w.getResource(Hired)).toBe(0)
  })

  it('afterTick from a listener acts once the outer action() has its verdict', () => {
    const w = port()
    const order: string[] = []
    let paused: unknown
    w.on(Verdict, () => {
      order.push('heard')
      w.afterTick(() => {
        order.push('after')
        paused = w.action(Pause, {})
      })
    })
    w.emit(Verdict, { won: false })
    const r = w.action(Hire, {})
    order.push('returned')
    expect(r.accepted).toBe(true)
    expect(paused).toMatchObject({ accepted: true, consumedTurn: true })
    expect(order).toEqual(['heard', 'after', 'returned'])
    expect(w.getResource(Speed)).toBe(0)
    expect(w.getResource(Hired)).toBe(1)
    expect(w.time.tick).toBe(2)
  })

  it('afterTick runs after step, stepOnce, render and runSystems; at once outside any call', () => {
    const w = port()
    const seen: string[] = []
    w.system('tickSys', { schedule: 'tick' }, () => {
      w.afterTick(() => seen.push(`after tick ${w.time.tick}`))
    })
    w.step(1 / 60)
    w.stepOnce()
    expect(seen).toEqual(['after tick 1', 'after tick 2'])
    w.runSystems(['tickSys'])
    expect(seen).toHaveLength(3)
    w.afterTick(() => seen.push('now'))
    expect(seen.at(-1)).toBe('now')
    let rendered = 0
    w.use({ name: 'r', install: () => ok({ onRender: () => w.afterTick(() => rendered++) }) })
    w.render()
    expect(rendered).toBe(1)
  })

  it('callbacks run in order, including ones they queue; a throw lets the rest run, then propagates', () => {
    const w = port()
    const seen: string[] = []
    w.system('q', { schedule: 'tick' }, () => {
      w.afterTick(() => {
        seen.push('a')
        w.afterTick(() => seen.push('c'))
        throw new Error('boom')
      })
      w.afterTick(() => seen.push('b'))
    })
    expect(() => w.stepOnce()).toThrow('boom')
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('afterTick queued by a tick that throws waits for the next call that returns', () => {
    const w = port()
    const seen: number[] = []
    let fail = true
    w.system('flaky', { schedule: 'tick' }, () => {
      w.afterTick(() => seen.push(w.time.tick))
      if (fail) throw new Error('flaky')
    })
    expect(() => w.stepOnce()).toThrow('flaky')
    expect(seen).toEqual([])
    fail = false
    w.stepOnce()
    expect(seen).toEqual([2, 2])
  })

  it('afterTick rejects a non-function', () => {
    const w = port()
    expect(() => w.afterTick(42 as unknown as () => void)).toThrow(TypeError)
  })

  it('an action() from afterTick is recorded as an act and replays', () => {
    const build = (): World => {
      const w = port()
      return w
    }
    const live = build()
    live.on(Verdict, () => live.afterTick(() => live.action(Pause, {})))
    const base = live.snapshot({ pendingEvents: true })
    const rec = createRecorder(live)
    live.emit(Verdict, { won: true })
    live.action(Hire, {})
    const log = rec.stop()
    expect(log.gaps ?? []).toEqual([])
    // The replay world has no stimulus source: the listener's act is in the log.
    const fork = build()
    const r = replay(fork, log, { base })
    expect(r.ok).toBe(true)
    expect(fork.getResource(Speed)).toBe(0)
    expect(fork.getResource(Hired)).toBe(1)
  })
})
