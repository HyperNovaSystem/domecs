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
