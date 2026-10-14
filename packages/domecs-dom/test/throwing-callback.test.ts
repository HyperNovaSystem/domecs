import { beforeEach, describe, expect, it } from 'vitest'
import { Has, createWorld, defineComponent, entry, isOk, type EntityView } from '@domecs/core'
import { defineView, mountDOM, type ViewDef } from '../src/index.js'

const Sprite = defineComponent<{ glyph: string }>('Sprite')
const Label = defineComponent<{ text: string }>('Label')
const glyph = (e: EntityView) => (e as unknown as { Sprite: { glyph: string } }).Sprite.glyph

// O-53: a throwing view callback must not jam the renderer.
describe('mountDOM — throwing view callbacks (O-53)', () => {
  let stage: HTMLElement
  let hud: HTMLElement
  beforeEach(() => {
    document.body.innerHTML = ''
    stage = document.createElement('div')
    hud = document.createElement('div')
    document.body.append(stage, hud)
  })

  function mount(world: ReturnType<typeof createWorld>, views: ViewDef[]) {
    const r = mountDOM(world, { slots: { stage, hud }, views })
    if (!isOk(r)) throw new Error('mount failed')
    return r.value
  }

  const labels = defineView({
    slot: 'hud',
    query: Has(Label),
    create: () => document.createElement('p'),
    update: (el, e) => { el.textContent = (e as unknown as { Label: { text: string } }).Label.text },
  })

  it('a throwing create surfaces once, and later frames and views still commit', () => {
    const world = createWorld({ headless: true })
    let ends = 0
    world.signals.tickEnd.subscribe(() => { ends++ })
    mount(world, [
      defineView({
        slot: 'stage',
        query: Has(Sprite),
        // A failed create is retried when a changedOn type is marked.
        changedOn: { mode: 'explicit', types: [Sprite] },
        create: (e) => {
          if (glyph(e) === 'bad') throw new Error('create boom')
          const el = document.createElement('span')
          el.textContent = glyph(e)
          return el
        },
      }),
      labels,
    ])
    world.spawn([entry(Sprite, { glyph: 'a' })])
    const bad = world.spawn([entry(Sprite, { glyph: 'bad' })])
    world.spawn([entry(Sprite, { glyph: 'b' })])
    world.spawn([entry(Label, { text: 'hp 3' })])

    expect(() => world.stepOnce()).toThrow('create boom')
    // The rest of the frame committed: both good sprites and the later view.
    expect(Array.from(stage.children, (c) => c.textContent)).toEqual(['a', 'b'])
    expect(hud.textContent).toBe('hp 3')

    // The next frame does not rethrow, and tickEnd fires again.
    world.spawn([entry(Sprite, { glyph: 'c' })])
    expect(() => world.stepOnce()).not.toThrow()
    expect(stage.children).toHaveLength(3)
    expect(ends).toBe(1)

    // A change to the failed entity retries its create.
    world.getComponent(bad, Sprite)!.glyph = 'fixed'
    world.markChanged(bad, Sprite)
    world.stepOnce()
    expect(Array.from(stage.children, (c) => c.textContent)).toContain('fixed')
  })

  it('a throwing update leaves the node mounted and other entities updated', () => {
    const world = createWorld({ headless: true })
    mount(world, [
      defineView({
        slot: 'stage',
        query: Has(Sprite),
        create: () => document.createElement('span'),
        update: (el, e) => {
          if (glyph(e) === 'bad') throw new Error('update boom')
          el.textContent = glyph(e)
        },
      }),
    ])
    const a = world.spawn([entry(Sprite, { glyph: 'a' })])
    const b = world.spawn([entry(Sprite, { glyph: 'b' })])
    world.stepOnce()
    world.getComponent(a, Sprite)!.glyph = 'bad'
    world.markChanged(a, Sprite)
    world.getComponent(b, Sprite)!.glyph = 'B'
    world.markChanged(b, Sprite)
    expect(() => world.stepOnce()).toThrow('update boom')
    expect(Array.from(stage.children, (c) => c.textContent)).toEqual(['a', 'B'])
    expect(() => world.stepOnce()).not.toThrow()
  })

  it('a throwing destroy still removes the node, on despawn and on teardown', () => {
    const world = createWorld({ headless: true })
    const handle = mount(world, [
      defineView({
        slot: 'stage',
        query: Has(Sprite),
        create: () => document.createElement('span'),
        destroy: () => { throw new Error('destroy boom') },
      }),
    ])
    const a = world.spawn([entry(Sprite, { glyph: 'a' })])
    world.spawn([entry(Sprite, { glyph: 'b' })])
    world.stepOnce()
    world.despawn(a)
    expect(() => world.stepOnce()).toThrow('destroy boom')
    expect(stage.children).toHaveLength(1)
    expect(() => world.stepOnce()).not.toThrow()
    expect(() => handle.teardown()).toThrow('destroy boom')
    expect(stage.children).toHaveLength(0)
  })
})

// O-54: a change-gated commit repaints only what changed, in id order.
describe('mountDOM — change-gated commit (O-54)', () => {
  it('updates only marked entities, in ascending id order', () => {
    document.body.innerHTML = ''
    const stage = document.createElement('div')
    const world = createWorld({ headless: true })
    const updated: number[] = []
    const r = mountDOM(world, {
      slots: { stage },
      views: [defineView({
        slot: 'stage',
        query: Has(Sprite),
        create: () => document.createElement('span'),
        update: (_el, e) => { updated.push(e.id) },
      })],
    })
    if (!isOk(r)) throw new Error('mount failed')
    const ids = [0, 1, 2, 3, 4].map(() => world.spawn([entry(Sprite, { glyph: '.' })]))
    world.stepOnce()
    updated.length = 0
    for (const id of [ids[4]!, ids[1]!]) world.markChanged(id, Sprite)
    world.stepOnce()
    expect(updated).toEqual([ids[1], ids[4]])
    updated.length = 0
    world.stepOnce()
    expect(updated).toEqual([])
  })
})

describe('mountDOM — review regressions (O-53, O-54)', () => {
  const RP = defineComponent<{ ok: boolean }>('RvRP', { defaults: { ok: false } })
  const VP = defineComponent<{ x: number }>('RvVP', { defaults: { x: 0 } })
  const VLabel = defineComponent<{ text: string }>('RvVLabel', { defaults: { text: '' } })

  for (const mode of ['create-only', 'legacy', 'auto+update', 'explicit-create-only'] as const) {
    it(`retries a failed create after markChanged (${mode})`, () => {
      const w = createWorld({ headless: true })
      const stage = document.createElement('div')
      const def: Record<string, unknown> = {
        slot: 'stage',
        query: Has(RP),
        create: (e: EntityView) => {
          if (!(e as unknown as { RvRP: { ok: boolean } }).RvRP.ok) throw new Error('bad')
          return document.createElement('div')
        },
      }
      if (mode === 'legacy') { def.changedOn = { mode: 'legacy' }; def.update = () => {} }
      if (mode === 'auto+update') def.update = () => {}
      if (mode === 'explicit-create-only') def.changedOn = { mode: 'explicit', types: [RP] }
      const r = mountDOM(w, { slots: { stage }, views: [def as unknown as ViewDef] })
      if (!isOk(r)) throw new Error('mount failed')
      const e = w.spawn([entry(RP, { ok: false })])
      expect(() => w.stepOnce()).toThrow('bad')
      expect(() => w.stepOnce()).not.toThrow() // no retry without a change
      w.getComponent(e, RP)!.ok = true
      w.markChanged(e, RP)
      w.stepOnce()
      expect(stage.children).toHaveLength(1)
    })
  }

  it('first paint after restoring into a fresh world sees every component', () => {
    const w1 = createWorld({ headless: true })
    w1.spawn([entry(VP, { x: 1 }), entry(VLabel, { text: 'hi' })])
    const snap = w1.snapshot()
    const w2 = createWorld({ headless: true })
    const stage = document.createElement('div')
    const r = mountDOM(w2, {
      slots: { stage },
      views: [defineView({
        slot: 'stage',
        query: Has(VP),
        create: () => document.createElement('div'),
        update: (el, e) => {
          el.textContent = (e as unknown as { RvVLabel?: { text: string } }).RvVLabel?.text ?? 'MISSING'
        },
      })],
    })
    if (!isOk(r)) throw new Error('mount failed')
    w2.restore(snap)
    w2.stepOnce()
    expect(stage.textContent).toBe('hi')
  })
})

describe('mountDOM — create sees the commit-time entity (O-55 D2)', () => {
  it('a component added after the entity matched, in the same frame, is in create', () => {
    const A = defineComponent<{ v: number }>('D2A', { defaults: { v: 0 } })
    const B = defineComponent<{ s: string }>('D2B', { defaults: { s: '' } })
    const w = createWorld({ headless: true })
    const stage = document.createElement('div')
    const r = mountDOM(w, {
      slots: { stage },
      views: [defineView({
        slot: 'stage',
        query: Has(A),
        create: (e) => {
          const el = document.createElement('i')
          el.textContent = (e as unknown as { D2B?: { s: string } }).D2B?.s ?? 'none'
          return el
        },
      })],
    })
    if (!isOk(r)) throw new Error('mount failed')
    const id = w.spawn([entry(A, { v: 1 })])
    w.addComponent(id, B, { s: 'late' })
    w.stepOnce()
    expect(stage.textContent).toBe('late')
  })
})
