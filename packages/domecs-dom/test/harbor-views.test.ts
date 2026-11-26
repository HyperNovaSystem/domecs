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
