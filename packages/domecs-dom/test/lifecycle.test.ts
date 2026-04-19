import { beforeEach, describe, expect, it } from 'vitest'
import { Has, createWorld, defineComponent } from 'domecs'
import { defineView, mountDOM } from '../src/index.js'

const Sprite = defineComponent<{ glyph: string }>('Sprite')

describe('mountDOM — view lifecycle (SPEC §5.3)', () => {
  let stage: HTMLElement
  beforeEach(() => {
    document.body.innerHTML = ''
    stage = document.createElement('div')
    stage.id = 'stage'
    document.body.appendChild(stage)
  })

  it('creates element on spawn, updates on Changed, destroys on despawn', () => {
    const world = createWorld({ headless: true })
    const view = defineView({
      slot: 'stage',
      query: Has(Sprite),
      changedOn: [Sprite],
      create(e) {
        const el = document.createElement('span')
        el.dataset.eid = String(e.id)
        el.textContent = (e as unknown as { Sprite: { glyph: string } }).Sprite.glyph
        return el
      },
      update(el, e) {
        el.textContent = (e as unknown as { Sprite: { glyph: string } }).Sprite.glyph
      },
    })
    const handle = mountDOM(world, { slots: { stage }, views: [view] })

    const a = world.spawn()
    world.addComponent(a, Sprite, { glyph: '@' })
    world.step()
    expect(stage.children.length).toBe(1)
    expect(stage.firstElementChild?.textContent).toBe('@')

    const sprite = world.getComponent(a, Sprite)!
    sprite.glyph = '#'
    world.markChanged(a, Sprite)
    world.step()
    expect(stage.firstElementChild?.textContent).toBe('#')

    world.despawn(a)
    world.step()
    expect(stage.children.length).toBe(0)

    handle.teardown()
  })

  it('does not call update when no Changed observed (changedOn gates updates)', () => {
    const world = createWorld({ headless: true })
    let updateCalls = 0
    const view = defineView({
      slot: 'stage',
      query: Has(Sprite),
      changedOn: [Sprite],
      create(e) {
        const el = document.createElement('span')
        el.textContent = (e as unknown as { Sprite: { glyph: string } }).Sprite.glyph
        return el
      },
      update() {
        updateCalls++
      },
    })
    const handle = mountDOM(world, { slots: { stage }, views: [view] })

    const a = world.spawn()
    world.addComponent(a, Sprite, { glyph: '@' })
    world.step()
    expect(updateCalls).toBe(0)
    world.step()
    expect(updateCalls).toBe(0)

    world.markChanged(a, Sprite)
    world.step()
    expect(updateCalls).toBe(1)

    handle.teardown()
  })
})
