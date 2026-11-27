import { beforeEach, describe, expect, it } from 'vitest'
import { createWorld, defineComponent, defineResource, entry, type Entity, type World } from '@domecs/core'
import { defineView, definePanel, entityOf, mountDOM, type MountHandle, type ViewDef } from '../src/index.js'

// The view-side Harbor findings: H-7 (views cannot watch a resource; panels
// drawn from strings), H-8 (no nested mounting, no element lookup), H-9 (no
// route from a DOM event to an entity), H-10 (no ordered lists).

const Tile = defineComponent<{ n: number }>('HvTile', { defaults: { n: 0 } })
const Ship = defineComponent<{ name: string }>('HvShip', { defaults: { name: '' } })
const Box = defineComponent<{ holder: number }>('HvBox', { defaults: { holder: -1 } })
const Rank = defineComponent<{ rank: number }>('HvRank', { defaults: { rank: 0 } })
const Focus = defineResource<{ id: number }>('HvFocus', { default: { id: -1 }, transient: true })
const Cash = defineResource<number>('HvCash', { default: 100 })

let stage: HTMLElement
let hud: HTMLElement
beforeEach(() => {
  document.body.innerHTML = '<div id="stage"></div><div id="hud"></div>'
  stage = document.getElementById('stage')!
  hud = document.getElementById('hud')!
})

function mount(world: World, views: ViewDef[], extra: Partial<Parameters<typeof mountDOM>[1]> = {}): MountHandle {
  const r = mountDOM(world, { slots: { stage, hud }, views, ...extra })
  if (!r.ok) throw new Error(`mount failed: ${JSON.stringify(r.error)}`)
  return r.value
}

describe('views redraw on a resource (H-7)', () => {
  it('changedOn.resources redraws every mounted node when the resource is set', () => {
    const w = createWorld({ headless: true })
    const updates: number[] = []
    const tiles = defineView({
      slot: 'stage',
      query: [Tile],
      changedOn: { mode: 'auto', resources: [Focus] },
      create: () => document.createElement('i'),
      update(el, e) {
        updates.push(e.id)
        el.className = w.getResource(Focus)!.id === e.id ? 'focused' : ''
      },
    })
    mount(w, [tiles])
    const ids = [0, 1, 2].map((n) => w.spawn([entry(Tile, { n })]))
    w.stepOnce()
    expect(updates).toEqual(ids) // first paint
    updates.length = 0
    w.stepOnce()
    expect(updates).toEqual([])
    w.setResource(Focus, { id: ids[1]! })
    w.stepOnce()
    expect(updates).toEqual(ids)
    expect(Array.from(stage.children).map((c) => c.className)).toEqual(['', 'focused', ''])
  })

  it('an explicit gate may name only resources', () => {
    const w = createWorld({ headless: true })
    let n = 0
    const r = mountDOM(w, {
      slots: { stage },
      views: [defineView({
        slot: 'stage',
        query: [Tile],
        changedOn: { mode: 'explicit', types: [], resources: [Focus] },
        create: () => document.createElement('i'),
        update: () => void n++,
      })],
    })
    expect(r.ok).toBe(true)
    w.spawn([entry(Tile, { n: 0 })])
    w.stepOnce()
    w.markChanged(w.listEntities([Tile])[0]!, Tile)
    w.stepOnce()
    expect(n).toBe(1) // first paint only: Tile is not a trigger
  })
})

describe('panels: markup derived from the world, patched in place (H-7)', () => {
  it('paints on mount, repaints when a trigger changes, and keeps its elements', () => {
    const w = createWorld({ headless: true })
    let renders = 0
    const panel = definePanel({
      slot: 'hud',
      changedOn: { resources: [Cash], types: [Tile] },
      render: (world) => {
        renders++
        return `<p>Cash $${world.getResource(Cash)}</p><button>Buy</button><span>${world.countEntities([Tile])} tiles</span>`
      },
    })
    mount(w, [], { panels: [panel] })
    w.stepOnce()
    expect(hud.querySelector('p')!.textContent).toBe('Cash $100')
    const button = hud.querySelector('button')!
    w.stepOnce()
    expect(renders).toBe(1)
    w.setResource(Cash, 60)
    w.stepOnce()
    expect(hud.querySelector('p')!.textContent).toBe('Cash $60')
    expect(hud.querySelector('button')).toBe(button)
    const t = w.spawn([entry(Tile, { n: 1 })])
    w.stepOnce() // added counts, as changed and removed do
    expect(hud.querySelector('span')!.textContent).toBe('1 tiles')
    expect(renders).toBe(3)
    w.markChanged(t, Tile)
    w.stepOnce()
    w.despawn(t)
    w.stepOnce()
    expect(hud.querySelector('span')!.textContent).toBe('0 tiles')
    expect(renders).toBe(5)
    w.stepOnce()
    expect(renders).toBe(5)
  })

  // PR #30 review (Codex): teardown cleared the slot but not paint's memory
  // of it, so the same markup mounted again was never written.
  it('paints again when mounted again into the same slot', () => {
    const w = createWorld({ headless: true })
    const panel = definePanel({ slot: 'hud', render: () => '<b>100</b>' })
    const first = mount(w, [], { panels: [panel] })
    w.stepOnce()
    expect(hud.innerHTML).toBe('<b>100</b>')
    first.teardown()
    expect(hud.innerHTML).toBe('')
    mount(w, [], { panels: [panel] })
    w.stepOnce()
    expect(hud.innerHTML).toBe('<b>100</b>')
  })

  it('without a gate, repaints every frame, writing only when the markup changed', () => {
    const w = createWorld({ headless: true })
    let tick = 0
    mount(w, [], { panels: [definePanel({ slot: 'hud', render: () => `<b>${Math.floor(tick++ / 2)}</b>` })] })
    w.stepOnce()
    const b = hud.querySelector('b')!
    w.stepOnce()
    w.stepOnce()
    expect(hud.querySelector('b')).toBe(b)
    expect(b.textContent).toBe('1')
  })
})

describe('nested views (H-8)', () => {
  function harbour(): { w: World; ships: ViewDef; boxes: ViewDef; handle: MountHandle } {
    const w = createWorld({ headless: true })
    const ships = defineView({
      slot: 'stage',
      query: [Ship],
      create: (e) => {
        const el = document.createElement('div')
        el.className = 'ship'
        el.innerHTML = `<b>${e.HvShip!.name}</b><div class="deck"></div>`
        return el
      },
    })
    const boxes = defineView({
      slot: 'stage',
      query: [Box],
      changedOn: { mode: 'auto' },
      parent: { view: ships, of: (e) => (e.HvBox!.holder >= 0 ? e.HvBox!.holder : null), at: '.deck' },
      create: () => {
        const el = document.createElement('i')
        el.className = 'box'
        return el
      },
      update: () => {},
    })
    // Listed child first: parents are committed first whatever the order.
    const handle = mount(w, [boxes, ships])
    return { w, ships, boxes, handle }
  }

  it('mounts an element inside its parent entity’s element, and moves it when the parent changes', () => {
    const { w, ships, boxes, handle } = harbour()
    const a = w.spawn([entry(Ship, { name: 'Ada' })])
    const b = w.spawn([entry(Ship, { name: 'Bo' })])
    const box = w.spawn([entry(Box, { holder: a })])
    const loose = w.spawn([entry(Box, { holder: -1 })])
    w.stepOnce()
    const boxEl = handle.elementOf(boxes, box)!
    expect(boxEl.parentElement).toBe(handle.elementOf(ships, a)!.querySelector('.deck'))
    expect(handle.elementOf(boxes, loose)!.parentElement).toBe(stage)
    w.getComponent(box, Box)!.holder = b
    w.markChanged(box, Box)
    w.stepOnce()
    expect(handle.elementOf(boxes, box)).toBe(boxEl) // moved, not re-created
    expect(boxEl.parentElement).toBe(handle.elementOf(ships, b)!.querySelector('.deck'))
  })

  it('keeps a child whose parent has no element yet, or lost it, out of the page until it has one', () => {
    const { w, ships, boxes, handle } = harbour()
    const a = w.spawn([entry(Ship, { name: 'Ada' })])
    const box = w.spawn([entry(Box, { holder: a })])
    w.stepOnce()
    const boxEl = handle.elementOf(boxes, box)!
    w.despawn(a) // the box stays, held by nothing that is drawn
    w.stepOnce()
    expect(handle.elementOf(ships, a)).toBeUndefined()
    expect(handle.elementOf(boxes, box)).toBe(boxEl)
    expect(boxEl.isConnected).toBe(false)
    const c = w.spawn([entry(Ship, { name: 'Cy' })])
    w.getComponent(box, Box)!.holder = c
    w.markChanged(box, Box)
    w.stepOnce()
    expect(boxEl.parentElement).toBe(handle.elementOf(ships, c)!.querySelector('.deck'))
  })

  // PR #30 review (Codex): a parent update that rewrote its content left the
  // children in the old mount point, out of the page, until they changed.
  it('puts the children back when the parent’s update replaces their mount point', () => {
    const w = createWorld({ headless: true })
    const ships = defineView({
      slot: 'stage',
      query: [Ship],
      changedOn: { mode: 'auto' },
      create: () => document.createElement('div'),
      update: (el, e) => {
        el.innerHTML = `<b>${e.HvShip!.name}</b><div class="deck"></div>`
      },
    })
    const boxes = defineView({
      slot: 'stage',
      query: [Box],
      changedOn: { mode: 'auto' },
      parent: { view: ships, of: (e) => e.HvBox!.holder, at: '.deck' },
      create: () => document.createElement('i'),
      update: () => {},
    })
    const handle = mount(w, [ships, boxes])
    const a = w.spawn([entry(Ship, { name: 'Ada' })])
    const box = w.spawn([entry(Box, { holder: a })])
    w.stepOnce()
    const deck = () => handle.elementOf(ships, a)!.querySelector('.deck')
    expect(handle.elementOf(boxes, box)!.parentElement).toBe(deck())
    w.getComponent(a, Ship)!.name = 'Ada II'
    w.markChanged(a, Ship)
    w.stepOnce()
    expect(handle.elementOf(boxes, box)!.isConnected).toBe(true)
    expect(handle.elementOf(boxes, box)!.parentElement).toBe(deck())
    // Nothing moves when the update leaves the mount point alone.
    const kept = handle.elementOf(boxes, box)!
    w.stepOnce()
    expect(kept.parentElement).toBe(deck())
  })

  it('refuses a parent view that is not in the mount, or a cycle', () => {
    const w = createWorld({ headless: true })
    const outside = defineView({ slot: 'stage', query: [Ship], create: () => document.createElement('b') })
    const child = defineView({ slot: 'stage', query: [Box], parent: { view: outside, of: () => null }, create: () => document.createElement('i') })
    const r = mountDOM(w, { slots: { stage }, views: [child] })
    expect(!r.ok && r.error.kind).toBe('invalid_parent')
  })
})

describe('from a DOM event to an entity (H-9)', () => {
  it('stamps mounted roots with data-entity; entityOf finds the innermost', () => {
    const { w, boxes, handle } = (() => {
      const world = createWorld({ headless: true })
      const ships = defineView({
        slot: 'stage', query: [Ship],
        create: () => {
          const el = document.createElement('div')
          el.innerHTML = '<span class="label">ship</span>'
          return el
        },
      })
      const boxView = defineView({ slot: 'stage', query: [Box], parent: { view: ships, of: (e) => e.HvBox!.holder }, create: () => document.createElement('i') })
      return { w: world, boxes: boxView, handle: mount(world, [ships, boxView]) }
    })()
    const ship = w.spawn([entry(Ship, { name: 'Ada' })])
    const box = w.spawn([entry(Box, { holder: ship })])
    w.stepOnce()
    const label = stage.querySelector('.label')!
    expect(entityOf(label)).toBe(ship)
    expect(entityOf(handle.elementOf(boxes, box)!)).toBe(box)
    expect(entityOf(stage)).toBeUndefined()
    expect(entityOf(null)).toBeUndefined()
  })

  it('handle.on delegates a DOM event on a slot to the entity under it', () => {
    const w = createWorld({ headless: true })
    const handle = mount(w, [defineView({ slot: 'stage', query: [Tile], create: () => document.createElement('button') })])
    const t = w.spawn([entry(Tile, { n: 0 })])
    w.stepOnce()
    const hits: Array<[Entity, string]> = []
    const off = handle.on('stage', 'click', (entity, ev) => void hits.push([entity, ev.type]))
    ;(stage.firstElementChild as HTMLElement).click()
    stage.click() // no entity under it
    off()
    ;(stage.firstElementChild as HTMLElement).click()
    expect(hits).toEqual([[t, 'click']])
  })
})

describe('mount stats (P-4, O-5)', () => {
  it('counts creates, updates and destroys per view, renders and paints per panel', () => {
    const w = createWorld({ headless: true })
    const tiles = defineView({ slot: 'stage', query: [Tile], create: () => document.createElement('i'), update: () => {} })
    const handle = mount(w, [tiles], {
      panels: [definePanel({ slot: 'hud', changedOn: { resources: [Cash] }, render: (world) => `<b>${world.getResource(Cash)! > 50 ? 'rich' : 'poor'}</b>` })],
    })
    const a = w.spawn([entry(Tile, { n: 0 })])
    w.spawn([entry(Tile, { n: 1 })])
    w.stepOnce()
    w.markChanged(a, Tile)
    w.stepOnce()
    w.despawn(a)
    w.setResource(Cash, 90) // still "rich": rendered, not painted
    w.stepOnce()
    const { views, panels } = handle.stats()
    expect(views).toEqual([
      expect.objectContaining({ view: tiles, slot: 'stage', mounted: 1, creates: 2, updates: 3, destroys: 1 }),
    ])
    expect(views[0]!.lastCommitMs).toBeGreaterThanOrEqual(0)
    expect(panels).toEqual([expect.objectContaining({ slot: 'hud', renders: 2, paints: 1 })])
  })
})

describe('ordered lists (H-10)', () => {
  it('keeps a view’s nodes in order(entity) order, as ranks change and entities come and go', () => {
    const w = createWorld({ headless: true })
    const queue = defineView({
      slot: 'stage',
      query: [Rank, Ship],
      order: (e) => e.HvRank!.rank,
      create: (e) => {
        const el = document.createElement('li')
        el.textContent = e.HvShip!.name
        return el
      },
      update: () => {},
    })
    mount(w, [queue])
    const names = (): string[] => Array.from(stage.children).map((c) => c.textContent!)
    const add = (name: string, rank: number): Entity => w.spawn([entry(Rank, { rank }), entry(Ship, { name })])
    const ada = add('Ada', 3)
    add('Bo', 1)
    const cy = add('Cy', 2)
    w.stepOnce()
    expect(names()).toEqual(['Bo', 'Cy', 'Ada'])
    w.getComponent(ada, Rank)!.rank = 0
    w.markChanged(ada, Rank)
    w.stepOnce()
    expect(names()).toEqual(['Ada', 'Bo', 'Cy'])
    add('Di', 1.5)
    w.despawn(cy)
    w.stepOnce()
    expect(names()).toEqual(['Ada', 'Bo', 'Di'])
  })
})

// H-22 (Harbor 3.0 findings): the reorder moved every node behind one that
// belongs first — ten moves where one would do, each taking the focus from
// a control inside the moved row.
describe('reordering moves the fewest nodes (H-22)', () => {
  // A move is a removal and an insertion: count the removals of nodes that stay.
  function counted(): { moves: () => number; restore: () => void } {
    const observer = new MutationObserver(() => {})
    observer.observe(stage, { childList: true })
    let n = 0
    const take = (): void => {
      for (const r of observer.takeRecords()) n += r.removedNodes.length
    }
    return {
      moves: () => (take(), n),
      restore: () => observer.disconnect(),
    }
  }

  function roadstead(w: World): { add: (name: string, rank: number) => Entity; names: () => string[] } {
    const queue = defineView({
      slot: 'stage',
      query: [Rank, Ship],
      order: (e) => e.HvRank!.rank,
      create: (e) => {
        const el = document.createElement('li')
        el.textContent = e.HvShip!.name
        return el
      },
      update: () => {},
    })
    mount(w, [queue])
    return {
      add: (name, rank) => w.spawn([entry(Rank, { rank }), entry(Ship, { name })]),
      names: () => Array.from(stage.children).map((c) => c.textContent!),
    }
  }

  it('one row ranked first is one move, not one per row behind it', () => {
    const w = createWorld({ headless: true })
    const r = roadstead(w)
    for (let i = 1; i <= 10; i++) r.add(`s${i}`, i)
    w.stepOnce()
    const c = counted()
    try {
      r.add('first', 0)
      w.stepOnce()
      expect(r.names()).toEqual(['first', ...Array.from({ length: 10 }, (_, i) => `s${i + 1}`)])
      expect(c.moves()).toBe(1)
    } finally {
      c.restore()
    }
  })

  it('reversing, shuffling and swapping all end in order', () => {
    const w = createWorld({ headless: true })
    const r = roadstead(w)
    const ids = Array.from({ length: 8 }, (_, i) => r.add(`s${i}`, i))
    w.stepOnce()
    const rerank = (ranks: number[]): void => {
      ids.forEach((id, i) => {
        w.getComponent(id, Rank)!.rank = ranks[i]!
        w.markChanged(id, Rank)
      })
      w.stepOnce()
      const want = ids.map((_, i) => i).sort((a, b) => ranks[a]! - ranks[b]! || a - b).map((i) => `s${i}`)
      expect(r.names()).toEqual(want)
    }
    rerank([7, 6, 5, 4, 3, 2, 1, 0])
    rerank([3, 0, 6, 1, 7, 2, 5, 4])
    rerank([0, 1, 2, 3, 4, 5, 7, 6])
    rerank([9, 1, 2, 3, 4, 5, 6, 7])
  })

  it('keeps a moved row’s focused control focused where the browser can move state-preservingly', () => {
    const w = createWorld({ headless: true })
    const queue = defineView({
      slot: 'stage',
      query: [Rank, Ship],
      order: (e) => e.HvRank!.rank,
      create: (e) => {
        const el = document.createElement('li')
        el.innerHTML = `<button>${e.HvShip!.name}</button>`
        return el
      },
      update: () => {},
    })
    const h = mount(w, [queue])
    const a = w.spawn([entry(Rank, { rank: 1 }), entry(Ship, { name: 'a' })])
    w.spawn([entry(Rank, { rank: 2 }), entry(Ship, { name: 'b' })])
    w.stepOnce()
    const button = h.elementOf(queue, a)!.querySelector('button')!
    button.focus()
    // `a` stays put: the newcomer is the one that moves.
    w.spawn([entry(Rank, { rank: 0 }), entry(Ship, { name: 'c' })])
    w.stepOnce()
    expect(Array.from(stage.children).map((c) => c.textContent)).toEqual(['c', 'a', 'b'])
    expect(document.activeElement).toBe(button)
  })
})

// H-24 (Harbor 3.0 findings): a panel whose inputs change every frame was
// rendered at every commit, and nothing could ask it to repaint for state no
// gate sees (the open tab).
describe('panel rate and invalidate (H-24)', () => {
  it('everyFrames renders at most once every N commits, keeping a change seen in between', () => {
    const w = createWorld({ headless: true })
    let renders = 0
    const panel = definePanel({
      slot: 'hud',
      changedOn: { resources: [Cash] },
      everyFrames: 4,
      render: (world) => (renders++, `<b>${world.getResource(Cash)}</b>`),
    })
    mount(w, [], { panels: [panel] })
    w.stepOnce()
    expect(renders).toBe(1) // first paint is at once
    for (let i = 0; i < 8; i++) {
      w.setResource(Cash, 200 + i)
      w.stepOnce()
    }
    expect(renders).toBe(3) // commits 5 and 9
    expect(hud.textContent).toBe('207')
    w.setResource(Cash, 1)
    w.stepOnce() // commit 10: changed, not due
    expect(renders).toBe(3)
    w.stepOnce()
    w.stepOnce()
    w.stepOnce() // commit 13: due, the change was kept
    expect(renders).toBe(4)
    expect(hud.textContent).toBe('1')
    w.stepOnce()
    w.stepOnce()
    w.stepOnce()
    w.stepOnce()
    expect(renders).toBe(4) // nothing changed
  })

  it('a gateless panel with everyFrames renders every Nth commit', () => {
    const w = createWorld({ headless: true })
    let renders = 0
    mount(w, [], { panels: [definePanel({ slot: 'hud', everyFrames: 3, render: () => `<i>${++renders}</i>` })] })
    for (let i = 0; i < 7; i++) w.stepOnce()
    expect(renders).toBe(3) // commits 1, 4, 7
  })

  it('invalidate(slot) renders at the next commit whatever the gate and rate', () => {
    const w = createWorld({ headless: true })
    let tab = 'cranes'
    let renders = 0
    const h = mount(w, [], {
      panels: [
        definePanel({
          slot: 'hud',
          changedOn: { resources: [Cash] },
          everyFrames: 100,
          render: () => (renders++, `<p>${tab}</p>`),
        }),
      ],
    })
    w.stepOnce()
    expect(hud.textContent).toBe('cranes')
    tab = 'ships'
    w.stepOnce()
    expect(hud.textContent).toBe('cranes')
    h.invalidate('hud')
    expect(hud.textContent).toBe('cranes') // at the next commit, not now
    w.render()
    expect(hud.textContent).toBe('ships')
    expect(renders).toBe(2)
    expect(() => h.invalidate('stage')).toThrow(/no panel in slot "stage"/)
  })

  it('everyFrames must be an integer >= 1', () => {
    const w = createWorld({ headless: true })
    for (const bad of [0, 1.5, Number.NaN]) {
      const r = mountDOM(w, { slots: { stage, hud }, views: [], panels: [definePanel({ slot: 'hud', everyFrames: bad, render: () => '' })] })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatchObject({ kind: 'invalid_panel', slot: 'hud' })
    }
  })
})

describe("changedOn: { mode: 'always' } (Harbor 3.0 findings)", () => {
  it("redraws every mounted node at every commit, as 'legacy' does", () => {
    for (const mode of ['always', 'legacy'] as const) {
      document.body.innerHTML = '<div id="stage"></div><div id="hud"></div>'
      stage = document.getElementById('stage')!
      hud = document.getElementById('hud')!
      const w = createWorld({ headless: true })
      let updates = 0
      mount(w, [
        defineView({
          slot: 'stage',
          query: [Tile],
          changedOn: { mode },
          create: () => document.createElement('i'),
          update: () => void updates++,
        }),
      ])
      w.spawn([entry(Tile, { n: 1 })])
      w.spawn([entry(Tile, { n: 2 })])
      w.stepOnce()
      w.stepOnce()
      w.stepOnce()
      expect(updates).toBe(6)
    }
  })
})

// H-21 (Harbor 3.0 findings): a box rides on a ship's deck, a crane's
// spreader or the yard. parent named one view, so a box changing hands was
// destroyed in one view and created in the next.
describe('a view nested in several parent views (H-21)', () => {
  const Crane = defineComponent<{ n: number }>('HvCrane', { defaults: { n: 0 } })
  const Held = defineComponent<{ kind: 'ship' | 'crane' | 'yard'; by: number }>('HvHeld', {
    defaults: { kind: 'yard', by: -1 },
  })

  function port() {
    const w = createWorld({ headless: true })
    const ships = defineView({
      slot: 'stage',
      query: [Ship],
      create: () => {
        const el = document.createElement('div')
        el.className = 'ship'
        el.innerHTML = '<div class="deck"></div>'
        return el
      },
    })
    const cranes = defineView({
      slot: 'stage',
      query: [Crane],
      create: () => {
        const el = document.createElement('div')
        el.className = 'crane'
        el.innerHTML = '<div class="spreader"></div>'
        return el
      },
    })
    let creates = 0
    let destroys = 0
    const boxes = defineView({
      slot: 'hud',
      query: [Held],
      parent: {
        views: [ships, cranes],
        of: (e) =>
          e.HvHeld!.kind === 'ship'
            ? { view: ships, entity: e.HvHeld!.by, at: '.deck' }
            : e.HvHeld!.kind === 'crane'
              ? { view: cranes, entity: e.HvHeld!.by, at: '.spreader' }
              : null,
      },
      create: () => (creates++, document.createElement('b')),
      update: () => {},
      destroy: () => void destroys++,
    })
    const h = mount(w, [boxes, ships, cranes])
    const ship = w.spawn([entry(Ship, { name: 'Ada' })])
    const crane = w.spawn([entry(Crane, { n: 1 })])
    const box = w.spawn([entry(Held, { kind: 'ship', by: ship })])
    w.stepOnce()
    const hand = (kind: 'ship' | 'crane' | 'yard', by: number): void => {
      const held = w.getComponent(box, Held)!
      held.kind = kind
      held.by = by
      w.markChanged(box, Held)
      w.stepOnce()
    }
    return { w, h, boxes, ships, cranes, ship, crane, box, hand, counts: () => ({ creates, destroys }) }
  }

  it('moves one element from deck to spreader to yard and back', () => {
    const p = port()
    const el = p.h.elementOf(p.boxes, p.box)!
    expect(el.parentElement!.className).toBe('deck')
    expect(el.closest('.ship')).toBe(p.h.elementOf(p.ships, p.ship))
    p.hand('crane', p.crane)
    expect(p.h.elementOf(p.boxes, p.box)).toBe(el)
    expect(el.parentElement!.className).toBe('spreader')
    p.hand('yard', -1)
    expect(el.parentElement).toBe(hud)
    p.hand('ship', p.ship)
    expect(el.parentElement!.className).toBe('deck')
    expect(p.counts()).toEqual({ creates: 1, destroys: 0 })
  })

  it('waits while the named holder has no element, and follows it out when it goes', () => {
    const p = port()
    const el = p.h.elementOf(p.boxes, p.box)!
    p.w.despawn(p.ship)
    p.w.stepOnce()
    expect(el.isConnected).toBe(false)
    expect(p.counts()).toEqual({ creates: 1, destroys: 0 })
    p.hand('crane', p.crane)
    expect(el.parentElement!.className).toBe('spreader')
    // A crane whose element is gone takes the box out of the page, still mounted.
    p.w.despawn(p.crane)
    p.w.stepOnce()
    expect(el.isConnected).toBe(false)
    const crane2 = p.w.spawn([entry(Crane, { n: 2 })])
    p.hand('crane', crane2)
    expect(el.parentElement!.className).toBe('spreader')
    expect(el.closest('.crane')).toBe(p.h.elementOf(p.cranes, crane2))
  })

  it('refuses a parent with no view, or one naming a view not in this mount', () => {
    const w = createWorld({ headless: true })
    const other = defineView({ slot: 'stage', query: [Ship], create: () => document.createElement('i') })
    const kid = (parent: ViewDef['parent']) =>
      defineView({ slot: 'hud', query: [Held], parent: parent as never, create: () => document.createElement('i') })
    const none = mountDOM(w, { slots: { stage, hud }, views: [kid({ of: () => null })] })
    expect(!none.ok && none.error).toMatchObject({ kind: 'invalid_parent', reason: expect.stringMatching(/needs a view/) })
    const stray = mountDOM(w, { slots: { stage, hud }, views: [kid({ views: [other], of: () => null })] })
    expect(!stray.ok && stray.error).toMatchObject({ kind: 'invalid_parent' })
  })

  it('a ref to a view not listed is an error at commit, and the element waits', () => {
    const w = createWorld({ headless: true })
    const ships = defineView({ slot: 'stage', query: [Ship], create: () => document.createElement('div') })
    const cranes = defineView({ slot: 'stage', query: [Crane], create: () => document.createElement('div') })
    const boxes = defineView({
      slot: 'hud',
      query: [Held],
      parent: { views: [ships], of: (e) => ({ view: cranes, entity: e.HvHeld!.by }) },
      create: () => document.createElement('b'),
    })
    const h = mount(w, [ships, cranes, boxes])
    const crane = w.spawn([entry(Crane, { n: 1 })])
    const box = w.spawn([entry(Held, { kind: 'crane', by: crane })])
    expect(() => w.stepOnce()).toThrow(/not in parent\.view or parent\.views/)
    expect(h.elementOf(boxes, box)!.isConnected).toBe(false)
  })
})
