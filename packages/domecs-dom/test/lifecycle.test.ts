import { beforeEach, describe, expect, it } from 'vitest'
import { Has, createWorld, defineComponent, type QueryDef, type QueryResult } from 'domecs'
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

  it('does not allocate new world queries during render commits when changedOn is absent', () => {
    const world = createWorld({ headless: true })
    let queryCalls = 0
    const originalQuery = world.query.bind(world)
    ;(world as typeof world & { query(def: QueryDef): QueryResult }).query = (def) => {
      queryCalls++
      return originalQuery(def)
    }

    const view = defineView({
      slot: 'stage',
      query: Has(Sprite),
      create() {
        return document.createElement('span')
      },
      update() {},
    })
    const handle = mountDOM(world, { slots: { stage }, views: [view] })
    expect(queryCalls).toBe(1)

    const a = world.spawn()
    world.addComponent(a, Sprite, { glyph: '@' })
    world.step()
    world.step()
    world.step()
    expect(queryCalls).toBe(1)

    handle.teardown()
  })

  it('does not allocate new world queries during render commits when changedOn is present', () => {
    const world = createWorld({ headless: true })
    let queryCalls = 0
    const originalQuery = world.query.bind(world)
    ;(world as typeof world & { query(def: QueryDef): QueryResult }).query = (def) => {
      queryCalls++
      return originalQuery(def)
    }

    const view = defineView({
      slot: 'stage',
      query: Has(Sprite),
      changedOn: [Sprite],
      create() {
        return document.createElement('span')
      },
      update() {},
    })
    const handle = mountDOM(world, { slots: { stage }, views: [view] })
    expect(queryCalls).toBe(2) // structural query + one cached Changed(Sprite) query

    const a = world.spawn()
    world.addComponent(a, Sprite, { glyph: '@' })
    world.step()
    world.markChanged(a, Sprite)
    world.step()
    world.step()
    expect(queryCalls).toBe(2)

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
