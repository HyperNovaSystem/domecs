import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import { OnRemoved } from '../src/query.js'
import { definePlugin } from '../src/plugin.js'
import { createRng, rewindRng } from '../src/rng.js'
import type { WorldSnapshot } from '../src/snapshot.js'
import { entry } from '../src/types.js'
import { createWorld } from '../src/world.js'

// Regression tests for the 2026-10-13 engine review's core-kernel tranche:
// C2 (O-41), C4 (O-43), C5 (O-44), C6 (O-45), C7 (O-46), C8 (O-47),
// C9 (O-48), C10 (O-49).

const Hp = defineComponent<{ hp: number }>('KhHp', { defaults: { hp: 10 } })

describe('O-41: restore validates the whole snapshot before wiping the world', () => {
  function seeded(): ReturnType<typeof createWorld> {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    w.spawn([entry(Hp, { hp: 7 })])
    w.spawn([entry(Hp, { hp: 8 })])
    w.stepOnce()
    return w
  }

  const good = (): WorldSnapshot => seeded().snapshot()

  const bad: Array<[string, (s: WorldSnapshot) => unknown]> = [
    ['an entity record without components', (s) => ({ ...s, entities: [{ id: 3 }] })],
    ['a non-integer entity id', (s) => ({ ...s, entities: [{ id: 1.5, components: {} }] })],
    ['a negative entity id', (s) => ({ ...s, entities: [{ id: -1, components: {} }] })],
    ['a string entity id', (s) => ({ ...s, entities: [{ id: '0', components: {} }] })],
    [
      'duplicate entity ids',
      (s) => ({ ...s, entities: [{ id: 0, components: {} }, { id: 0, components: {} }] }),
    ],
    ['an array component bag', (s) => ({ ...s, entities: [{ id: 0, components: [] }] })],
    ['a null entity record', (s) => ({ ...s, entities: [null] })],
    ['entities that is not an array', (s) => ({ ...s, entities: {} })],
    ['a short seed', (s) => ({ ...s, seed: [1, 2, 3] })],
    ['a non-numeric seed', (s) => ({ ...s, seed: [1, 2, 3, 'x'] })],
    ['a missing tick', (s) => ({ ...s, tick: undefined })],
    ['a fractional tick', (s) => ({ ...s, tick: 1.5 })],
    ['a non-numeric nextId', (s) => ({ ...s, nextId: 'x' })],
    ['a non-object resources field', (s) => ({ ...s, resources: [] })],
  ]

  for (const [label, corrupt] of bad) {
    it(`rejects ${label} and leaves the live world intact`, () => {
      const w = seeded()
      const before = JSON.stringify(w.snapshot())
      expect(() => w.restore(corrupt(good()) as WorldSnapshot)).toThrow(/invalid snapshot/)
      expect(JSON.stringify(w.snapshot())).toBe(before)
      expect(w.listEntities([Hp])).toHaveLength(2)
    })
  }

  it('still restores a well-formed snapshot', () => {
    const w = seeded()
    const snap = w.snapshot()
    w.spawn([entry(Hp, { hp: 1 })])
    w.restore(snap)
    expect(JSON.stringify(w.snapshot())).toBe(JSON.stringify(snap))
  })
})

describe('O-43: the schedule is stable while a phase iterates it', () => {
  it('a system that removes itself does not skip the next one', () => {
    const w = createWorld({ headless: true })
    const ran: string[] = []
    const a = w.system('a', { schedule: 'tick' }, () => {
      ran.push('a')
      a.remove()
    })
    w.system('b', { schedule: 'tick' }, () => void ran.push('b'))
    w.system('c', { schedule: 'tick' }, () => void ran.push('c'))
    w.stepOnce()
    expect(ran).toEqual(['a', 'b', 'c'])
    ran.length = 0
    w.stepOnce()
    expect(ran).toEqual(['b', 'c'])
  })

  it('a system removed by an earlier one does not run later in the same phase', () => {
    const w = createWorld({ headless: true })
    const ran: string[] = []
    w.system('a', { schedule: 'tick' }, () => {
      ran.push('a')
      b.remove()
    })
    const b = w.system('b', { schedule: 'tick' }, () => void ran.push('b'))
    w.system('c', { schedule: 'tick' }, () => void ran.push('c'))
    w.stepOnce()
    expect(ran).toEqual(['a', 'c'])
  })

  it('a system added mid-phase runs from the next pass, not twice', () => {
    const w = createWorld({ headless: true })
    const ran: string[] = []
    let added = false
    w.system('a', { schedule: 'tick' }, () => void ran.push('a'))
    w.system('b', { schedule: 'tick' }, () => {
      ran.push('b')
      if (added) return
      added = true
      w.system('early', { schedule: 'tick', priority: -1 }, () => void ran.push('early'))
    })
    w.stepOnce()
    expect(ran).toEqual(['a', 'b'])
    ran.length = 0
    w.stepOnce()
    expect(ran).toEqual(['early', 'a', 'b'])
  })

  it('equal priorities keep registration order after removals', () => {
    const w = createWorld({ headless: true })
    const ran: string[] = []
    const a = w.system('a', { schedule: 'tick' }, () => void ran.push('a'))
    const b = w.system('b', { schedule: 'tick' }, () => void ran.push('b'))
    w.system('c', { schedule: 'tick' }, () => void ran.push('c'))
    w.system('d', { schedule: 'tick' }, () => void ran.push('d'))
    a.remove()
    b.remove()
    w.system('e', { schedule: 'tick' }, () => void ran.push('e'))
    w.stepOnce()
    expect(ran).toEqual(['c', 'd', 'e'])
  })
})

describe('O-44: component defaults are copied per entity', () => {
  it('nested arrays and objects are not shared', () => {
    const Inv = defineComponent<{ items: string[]; meta: { tags: string[] } }>('KhInv', {
      defaults: { items: [], meta: { tags: [] } },
    })
    const w = createWorld({ headless: true })
    const a = w.spawn([entry(Inv, Inv.create())])
    const b = w.spawn([entry(Inv, Inv.create())])
    w.getComponent(a, Inv)!.items.push('sword')
    w.getComponent(a, Inv)!.meta.tags.push('hero')
    expect(w.getComponent(b, Inv)!.items).toEqual([])
    expect(w.getComponent(b, Inv)!.meta.tags).toEqual([])
    expect(Inv.create().items).toEqual([])
  })

  it('keeps symbol keys, null prototypes and cycles', () => {
    const sym = Symbol('k')
    const dict = Object.assign(Object.create(null) as Record<string, number>, { a: 1 })
    const loop: { self?: unknown; n: number } = { n: 1 }
    loop.self = loop
    const C = defineComponent<{ [sym]: number; dict: Record<string, number>; loop: typeof loop }>(
      'KhEdge',
      { defaults: { [sym]: 1, dict, loop } },
    )
    const v = C.create()
    expect(v[sym]).toBe(1)
    expect(Object.getPrototypeOf(v.dict)).toBe(null)
    expect(v.dict).not.toBe(dict)
    expect(v.loop).not.toBe(loop)
    expect(v.loop.self).toBe(v.loop)
  })

  it('non-plain default values keep their identity', () => {
    const shared = new Map<string, number>()
    const Reg = defineComponent<{ map: Map<string, number> }>('KhReg', {
      defaults: { map: shared },
    })
    expect(Reg.create().map).toBe(shared)
  })
})

describe('O-46: restore rewinds world.rand in place', () => {
  it('a captured rand handle follows the restore', () => {
    const w = createWorld({ headless: true, seed: [9, 8, 7, 6] })
    const rng = w.rand
    const snap = w.snapshot()
    const first = rng.uniform()
    rng.uniform()
    w.restore(snap)
    expect(w.rand).toBe(rng)
    expect(rng.uniform()).toBe(first)
  })

  it('rewindRng matches a fresh generator from the same state', () => {
    const a = createRng([1, 2, 3, 4])
    a.uniform()
    const b = createRng(a.seed())
    a.uniform()
    expect(rewindRng(a, b.seed())).toBe(true)
    expect(a.uniform()).toBe(b.uniform())
  })
})

describe('O-47: OnRemoved reads do not cache views of despawned entities', () => {
  it('a despawned id gets a fresh view each read', () => {
    const w = createWorld({ headless: true })
    const views: unknown[] = []
    w.system(
      'gone',
      { schedule: 'reactive', reactsTo: OnRemoved(Hp) },
      ({ entities }) => {
        for (const e of entities) views.push(e)
      },
    )
    w.system('gone-too', { schedule: 'reactive', reactsTo: OnRemoved(Hp) }, ({ entities }) => {
      for (const e of entities) views.push(e)
    })
    const id = w.spawn([entry(Hp, { hp: 1 })])
    w.stepOnce()
    w.despawn(id)
    w.stepOnce()
    expect(views).toHaveLength(2)
    // Two separate reads of the same dead id: no cached view is shared.
    expect(views[0]).not.toBe(views[1])
  })
})

describe('O-49: archetype keys do not collide', () => {
  it('a component named "a|b" is not {a, b}', () => {
    const A = defineComponent<{ v: number }>('a', { defaults: { v: 0 } })
    const B = defineComponent<{ v: number }>('b', { defaults: { v: 0 } })
    const AB = defineComponent<{ v: number }>('a|b', { defaults: { v: 0 } })
    const w = createWorld({ headless: true })
    const both = w.spawn([entry(A, { v: 0 }), entry(B, { v: 0 })])
    const piped = w.spawn([entry(AB, { v: 0 })])
    expect(w.listEntities([A])).toEqual([both])
    expect(w.listEntities([AB])).toEqual([piped])
  })
})

// --- driver tests (fake rAF) ---

interface Raf {
  advance(ms: number): void
  pending(): boolean
  restore(): void
}

function installRaf(): Raf {
  let next = 1
  let clock = 0
  const queue = new Map<number, FrameRequestCallback>()
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: FrameRequestCallback) => number
    cancelAnimationFrame?: (h: number) => void
  }
  const prevRaf = g.requestAnimationFrame
  const prevCaf = g.cancelAnimationFrame
  g.requestAnimationFrame = (cb) => {
    const h = next++
    queue.set(h, cb)
    return h
  }
  g.cancelAnimationFrame = (h) => void queue.delete(h)
  return {
    advance(ms) {
      clock += ms
      const due = Array.from(queue.values())
      queue.clear()
      for (const cb of due) {
        try {
          cb(clock)
        } catch {
          // A browser reports a throwing rAF callback and carries on.
        }
      }
    },
    pending: () => queue.size > 0,
    restore() {
      if (prevRaf) g.requestAnimationFrame = prevRaf
      else delete g.requestAnimationFrame
      if (prevCaf) g.cancelAnimationFrame = prevCaf
      else delete g.cancelAnimationFrame
    },
  }
}

describe('driver', () => {
  let raf: Raf | undefined
  afterEach(() => {
    raf?.restore()
    raf = undefined
  })

  it('O-45: one throwing system does not stop the loop', () => {
    raf = installRaf()
    const w = createWorld({ idle: false })
    let runs = 0
    w.system('flaky', { schedule: 'tick' }, () => {
      runs += 1
      if (runs === 1) throw new Error('boom')
    })
    w.startLoop()
    for (let i = 0; i < 6; i++) raf.advance(16)
    w.stop()
    // The first frame primes; the next five step.
    expect(runs).toBe(5)
  })

  for (const paused of [false, true]) {
    it(`O-48: restore repaints an idle${paused ? ', paused' : ''} loop without ticking`, () => {
      raf = installRaf()
      const w = createWorld()
      let renders = 0
      w.use(definePlugin({ name: 'kh:render-count', install: () => ({ onRender: () => void renders++ }) }))
      w.spawn([entry(Hp, { hp: 1 })])
      w.startLoop()
      for (let i = 0; i < 4; i++) raf.advance(16)
      if (paused) w.pause()
      for (let i = 0; i < 4; i++) raf.advance(16)
      expect(raf.pending()).toBe(false)
      const snap = w.snapshot()
      const rendersBefore = renders
      w.restore(snap)
      expect(raf.pending()).toBe(true)
      for (let i = 0; i < 4; i++) raf.advance(16)
      expect(renders).toBe(rendersBefore + 1)
      expect(JSON.stringify(w.snapshot())).toBe(JSON.stringify(snap))
      w.stop()
    })
  }

  it('O-48: a mutation before the repaint frame turns it into a step', () => {
    raf = installRaf()
    const w = createWorld()
    w.startLoop()
    for (let i = 0; i < 4; i++) raf.advance(16)
    const tick = w.time.tick
    w.restore(w.snapshot())
    w.spawn([entry(Hp, { hp: 2 })])
    raf.advance(16)
    expect(w.time.tick).toBe(tick + 1)
    w.stop()
  })
})
