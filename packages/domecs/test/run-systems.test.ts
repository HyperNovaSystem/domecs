import { describe, expect, it } from 'vitest'
import {
  OnChanged,
  createRecorder,
  createWorld,
  defineComponent,
  defineEvent,
  definePlugin,
  entry,
  hashSnapshot,
} from '../src/index.js'
import type { Entity, TickInfo, World } from '../src/index.js'

// §6.3 (G15; O-88): run named systems and the render phase without a tick,
// so derived state can be primed and the stage redrawn after a restore,
// scrub or branch selection without moving tick identity.

const Local = defineComponent<{ x: number }>('RsLocal', { defaults: { x: 0 } })
const Derived = defineComponent<{ x: number }>('RsDerived', { defaults: { x: 0 } })
const Ping = defineEvent<{ n: number }>('RsPing')

const strict = (w: World): string => hashSnapshot(w.snapshot({ pendingEvents: true }), { includeChanges: true })

/** A derived-state system in the shape of `composeTransforms`: `Derived = 2 × Local`. */
function addDerive(w: World, name = 'derive', priority = 0): string[] {
  const runs: string[] = []
  w.system(name, { schedule: 'tick', query: [Local], priority }, (ctx) => {
    runs.push(name)
    for (const e of ctx.entities) {
      const v = { x: w.getComponent(e.id, Local)!.x * 2 }
      const cur = w.getComponent(e.id, Derived)
      if (cur === undefined) w.addComponent(e.id, Derived, v)
      else if (cur.x !== v.x) {
        cur.x = v.x
        w.markChanged(e.id, Derived)
      }
    }
  })
  return runs
}

describe('runSystems (§6.3)', () => {
  it('after restore, primes derived state with tick and time unchanged (test 1)', () => {
    const w = createWorld({ headless: true })
    addDerive(w)
    const id = w.spawn([entry(Local, { x: 3 })])
    w.stepOnce()
    expect(w.getComponent(id, Derived)).toEqual({ x: 6 })
    const snap = w.snapshot()

    const fresh = createWorld({ headless: true })
    const runs = addDerive(fresh)
    let other = 0
    fresh.system('motion', { schedule: 'tick' }, () => void other++)
    fresh.restore(snap)
    fresh.removeComponent(id, Derived) // derived state not yet computed
    const before = { tick: fresh.time.tick, elapsed: fresh.time.elapsed, delta: fresh.time.delta }

    const r = fresh.runSystems(['derive'])
    expect(r).toEqual({ ran: ['derive'], skipped: [] })
    expect(runs).toEqual(['derive'])
    expect(other).toBe(0)
    expect(fresh.getComponent(id, Derived)).toEqual({ x: 6 })
    expect({ tick: fresh.time.tick, elapsed: fresh.time.elapsed, delta: fresh.time.delta }).toEqual(before)
  })

  it('reports unknown names and names of other schedules as skipped', () => {
    const w = createWorld({ headless: true })
    const ran: string[] = []
    w.system('t', { schedule: 'tick' }, () => void ran.push('t'))
    w.system('f', { schedule: 'fixed' }, () => void ran.push('f'))
    w.system('o', { schedule: 'once' }, () => void ran.push('o'))
    w.system('e', { schedule: 'event', triggers: [Ping] }, () => void ran.push('e'))
    w.system('r', { schedule: 'reactive', reactsTo: OnChanged(Local) }, () => void ran.push('r'))
    w.system('off', { schedule: 'tick' }, () => void ran.push('off')).disable()
    w.system('gated', { schedule: 'tick', enabled: () => false }, () => void ran.push('gated'))

    const r = w.runSystems(['nope', 'o', 't', 'e', 'f', 'r', 'off', 'gated'])
    expect(r.ran).toEqual(['f', 't'])
    expect(r.skipped).toEqual(['nope', 'o', 'e', 'r', 'off', 'gated'])
    expect(ran).toEqual(['f', 't'])
    expect(w.time.tick).toBe(0)
  })

  it('runs in run order (fixed phase, then tick; priority, order, registration), each name once', () => {
    const w = createWorld({ headless: true })
    const ran: string[] = []
    const sys = (name: string, schedule: 'tick' | 'fixed', priority: number, order = 0): void => {
      w.system(name, { schedule, priority, order }, () => void ran.push(name))
    }
    sys('late', 'tick', 10)
    sys('early', 'tick', -5)
    sys('tieB', 'tick', 0)
    sys('tieA', 'tick', 0, -1)
    sys('fx', 'fixed', 99)
    const r = w.runSystems(['late', 'tieB', 'fx', 'early', 'tieA', 'late'])
    expect(r).toEqual({ ran: ['fx', 'early', 'tieA', 'tieB', 'late'], skipped: [] })
    expect(ran).toEqual(['fx', 'early', 'tieA', 'tieB', 'late'])
  })

  it('a name shared by two systems runs both, and is listed once per system run', () => {
    const w = createWorld({ headless: true })
    const ran: string[] = []
    w.system('dup', { schedule: 'tick', priority: 2 }, () => void ran.push('dup:tick'))
    w.system('dup', { schedule: 'fixed' }, () => void ran.push('dup:fixed'))
    w.system('dup', { schedule: 'event', triggers: [Ping] }, () => void ran.push('dup:event'))
    expect(w.runSystems(['dup'])).toEqual({ ran: ['dup', 'dup'], skipped: [] })
    expect(ran).toEqual(['dup:fixed', 'dup:tick'])
  })

  it('re-checks enabled before each run: a system disabled by an earlier one is skipped', () => {
    const w = createWorld({ headless: true })
    const ran: string[] = []
    w.system('first', { schedule: 'tick', priority: 0 }, () => {
      ran.push('first')
      w.getSystem('second')!.disable()
    })
    w.system('second', { schedule: 'tick', priority: 1 }, () => void ran.push('second'))
    expect(w.runSystems(['second', 'first'])).toEqual({ ran: ['first'], skipped: ['second'] })
    expect(ran).toEqual(['first'])
  })

  it('rejects names that are not an array of strings', () => {
    const w = createWorld({ headless: true })
    expect(() => w.runSystems('t' as unknown as string[])).toThrow(TypeError)
    expect(() => w.runSystems([1] as unknown as string[])).toThrow(TypeError)
  })

  it('runs tick and fixed systems while paused, and ignores a fixed rate divisor', () => {
    const w = createWorld({ headless: true })
    const ran: string[] = []
    w.system('t', { schedule: 'tick' }, () => void ran.push('t'))
    w.system('slow', { schedule: 'fixed', rateHz: 1 }, () => void ran.push('slow'))
    w.pause()
    expect(w.runSystems(['t', 'slow']).ran).toEqual(['slow', 't'])
    expect(ran).toEqual(['slow', 't'])
  })

  it('does not flush events or fire tickStart/tickEnd or plugin hooks', () => {
    const w = createWorld({ headless: true })
    const hooks: string[] = []
    w.signals.tickStart.subscribe(() => void hooks.push('sig:start'))
    w.signals.tickEnd.subscribe(() => void hooks.push('sig:end'))
    w.use(
      definePlugin({
        name: 'rs:hooks',
        install: () => ({
          onTickStart: () => void hooks.push('start'),
          onTickEnd: () => void hooks.push('end'),
          onRender: () => void hooks.push('render'),
        }),
      }),
    )
    const seen: number[][] = []
    const delivered: number[] = []
    w.system('read', { schedule: 'tick' }, (ctx) => {
      seen.push(ctx.events.of(Ping).map((p) => p.n))
      if (w.time.tick === 0) ctx.events.emit(Ping, { n: 2 })
    })
    w.system('log', { schedule: 'event', triggers: [Ping] }, (ctx) => {
      for (const p of ctx.events.of(Ping)) delivered.push(p.n)
    })
    w.emit(Ping, { n: 1 })
    w.runSystems(['read'])
    expect(hooks).toEqual([])
    // The current (empty) view, not the pending queue.
    expect(seen).toEqual([[]])
    expect(w.pendingEvents().map((p) => p.payload)).toEqual([{ n: 1 }, { n: 2 }])
    w.stepOnce()
    // Both the outside emit and the system's emit are delivered at the next tick.
    expect(delivered).toEqual([1, 2])
    expect(seen).toEqual([[], [1, 2]])
  })

  it('after an in-place restore, ctx.events is not the abandoned timeline’s view', () => {
    const build = (): { w: World; seen: number[][] } => {
      const w = createWorld({ headless: true })
      const seen: number[][] = []
      w.system('read', { schedule: 'tick' }, (ctx) => void seen.push(ctx.events.of(Ping).map((p) => p.n)))
      return { w, seen }
    }
    const a = build()
    const snap = a.w.snapshot()
    a.w.emit(Ping, { n: 9 })
    a.w.stepOnce() // delivers Ping: it is in the current view
    expect(a.w.events.of(Ping).map((p) => p.n)).toEqual([9])
    a.w.restore(snap)
    // As in a fresh world restored from the same snapshot.
    const b = build()
    b.w.restore(snap)
    a.seen.length = 0
    a.w.runSystems(['read'])
    b.w.runSystems(['read'])
    expect(a.seen).toEqual(b.seen)
    expect(a.seen).toEqual([[]])
    expect(a.w.events.of(Ping)).toEqual([])
  })

  it('a run is a normal run for change windows: marks it saw are not reported again', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Local, { x: 1 })])
    w.stepOnce()
    const seen: Array<[number, Entity[]]> = []
    w.system('watch', { schedule: 'tick', query: OnChanged(Local) }, (ctx) => {
      seen.push([w.time.tick, ctx.entities.map((e) => e.id)])
    })
    w.getComponent(id, Local)!.x = 5
    w.markChanged(id, Local)
    w.runSystems(['watch'])
    w.stepOnce()
    expect(seen).toEqual([
      [1, [id]],
      [2, []],
    ])
  })

  it('records a gap on an attached recorder (test 4)', () => {
    const w = createWorld({ headless: true })
    addDerive(w)
    w.spawn([entry(Local, { x: 1 })])
    w.stepOnce()
    const rec = createRecorder(w)
    w.stepOnce()
    // Nothing ran: no gap.
    w.runSystems(['missing'])
    w.runSystems([])
    expect(rec.peek().gaps).toBeUndefined()
    // A run that changes nothing is still out of tick.
    w.runSystems(['derive'])
    w.stepOnce()
    expect(rec.stop().gaps).toEqual([{ tick: 2, reason: 'out_of_tick_mutation' }])
  })

  it('throws when called during a tick', () => {
    const w = createWorld({ headless: true })
    let caught: unknown
    w.system('a', { schedule: 'tick' }, () => {})
    w.system('b', { schedule: 'tick' }, () => {
      try {
        w.runSystems(['a'])
      } catch (e) {
        caught = e
      }
    })
    w.stepOnce()
    expect(caught).toBeInstanceOf(Error)
    expect(String((caught as Error).message)).toMatch(/runSystems.*outside a tick/)
  })

  it('a throwing system propagates and leaves the world usable', () => {
    const w = createWorld({ headless: true })
    w.system('boom', { schedule: 'tick' }, () => {
      throw new Error('boom')
    })
    let ok = 0
    w.system('fine', { schedule: 'tick' }, () => void ok++)
    expect(() => w.runSystems(['boom', 'fine'])).toThrow('boom')
    expect(ok).toBe(0)
    w.getSystem('boom')!.disable()
    expect(w.runSystems(['fine']).ran).toEqual(['fine'])
    expect(ok).toBe(1)
  })
})

describe('render (§6.3)', () => {
  function withHooks(w: World): { calls: string[]; infos: TickInfo[] } {
    const calls: string[] = []
    const infos: TickInfo[] = []
    w.signals.tickStart.subscribe(() => void calls.push('sig:start'))
    w.signals.tickEnd.subscribe(() => void calls.push('sig:end'))
    w.use(
      definePlugin({
        name: 'rs:render',
        install: () => ({
          onTickStart: () => void calls.push('start'),
          onTickEnd: () => void calls.push('end'),
          onRender: (_w, info) => {
            calls.push('render')
            infos.push(info)
          },
        }),
      }),
    )
    return { calls, infos }
  }

  it('calls onRender only, with heartbeat TickInfo; no signals, no systems (test 2)', () => {
    const w = createWorld({ headless: true })
    const { calls, infos } = withHooks(w)
    let ran = 0
    w.system('t', { schedule: 'tick' }, () => void ran++)
    w.stepOnce()
    calls.length = 0
    infos.length = 0
    const before = { ...w.time }
    w.render()
    expect(calls).toEqual(['render'])
    expect(infos).toEqual([{ heartbeat: true }])
    expect(ran).toBe(1)
    expect({ ...w.time }).toEqual(before)
  })

  it('leaves the default hash unchanged (test 3)', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    withHooks(w)
    const id = w.spawn([entry(Local, { x: 1 })])
    w.stepOnce()
    w.markChanged(id, Local)
    const h = hashSnapshot(w.snapshot())
    const s = strict(w)
    w.render()
    expect(hashSnapshot(w.snapshot())).toBe(h)
    expect(strict(w)).toBe(s)
  })

  it('advances query windows like the heartbeat render: a mark is painted once', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Local, { x: 1 })])
    w.stepOnce()
    const q = w.query(OnChanged(Local))
    const reads: Entity[][] = []
    w.use(
      definePlugin({
        name: 'rs:paint',
        install: () => ({ onRender: () => void reads.push(q.entities.map((e) => e.id)) }),
      }),
    )
    w.markChanged(id, Local)
    w.render()
    w.render()
    w.stepOnce()
    expect(reads).toEqual([[id], [], []])
  })

  it('a hook that throws still advances the windows', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Local, { x: 1 })])
    w.stepOnce()
    const q = w.query(OnChanged(Local))
    const reads: Entity[][] = []
    let fail = true
    w.use(
      definePlugin({
        name: 'rs:throws',
        install: () => ({
          onRender: () => {
            reads.push(q.entities.map((e) => e.id))
            if (fail) throw new Error('paint failed')
          },
        }),
      }),
    )
    w.markChanged(id, Local)
    expect(() => w.render()).toThrow('paint failed')
    fail = false
    w.render()
    expect(reads).toEqual([[id], []])
  })

  it('throws when called during a tick', () => {
    const w = createWorld({ headless: true })
    let caught: unknown
    w.system('b', { schedule: 'tick' }, () => {
      try {
        w.render()
      } catch (e) {
        caught = e
      }
    })
    w.stepOnce()
    expect(String((caught as Error).message)).toMatch(/render.*outside a tick/)
  })

  it('records no gap when render hooks change nothing', () => {
    const w = createWorld({ headless: true })
    withHooks(w)
    w.stepOnce()
    const rec = createRecorder(w)
    w.render()
    w.stepOnce()
    expect(rec.stop().gaps).toBeUndefined()
  })
})
