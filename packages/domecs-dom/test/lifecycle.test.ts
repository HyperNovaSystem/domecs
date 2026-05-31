import { beforeEach, describe, expect, it } from 'vitest'
import { Has, createWorld, defineComponent, type QueryDef, type QueryResult } from '@domecs/core'
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
    world.stepOnce()
    expect(stage.children.length).toBe(1)
    expect(stage.firstElementChild?.textContent).toBe('@')

    const sprite = world.getComponent(a, Sprite)!
    sprite.glyph = '#'
    world.markChanged(a, Sprite)
    world.stepOnce()
    expect(stage.firstElementChild?.textContent).toBe('#')

    world.despawn(a)
    world.stepOnce()
    expect(stage.children.length).toBe(0)

    handle.teardown()
  })

  it('auto-derives Changed queries from the view query when changedOn is omitted (P-3)', () => {
    const world = createWorld({ headless: true })
    let queryCalls = 0
    const originalQuery = world.query.bind(world)
    ;(world as { query: (def: QueryDef) => QueryResult }).query = (def: QueryDef) => {
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
    // 1 structural query + 1 auto-derived Changed(Sprite) query at install.
    // After install, render commits MUST NOT allocate further queries.
    expect(queryCalls).toBe(2)

    const a = world.spawn()
    world.addComponent(a, Sprite, { glyph: '@' })
    world.stepOnce()
    world.stepOnce()
    world.stepOnce()
    expect(queryCalls).toBe(2)

    handle.teardown()
  })

  it('opts out of auto-derive when changedOn=[] (legacy "update every tick")', () => {
    const world = createWorld({ headless: true })
    let updateCalls = 0
    const view = defineView({
      slot: 'stage',
      query: Has(Sprite),
      changedOn: [], // explicit empty array — restore legacy redraw-every-tick.
      create() {
        return document.createElement('span')
      },
      update() {
        updateCalls++
      },
    })
    const handle = mountDOM(world, { slots: { stage }, views: [view] })
    const a = world.spawn()
    world.addComponent(a, Sprite, { glyph: '@' })
    world.stepOnce()
    expect(updateCalls).toBe(1)
    // No markChanged, but legacy mode still drives update every tick.
    world.stepOnce()
    expect(updateCalls).toBe(2)
    world.stepOnce()
    expect(updateCalls).toBe(3)
    handle.teardown()
  })

  it('does not allocate new world queries during render commits when changedOn is present', () => {
    const world = createWorld({ headless: true })
    let queryCalls = 0
    const originalQuery = world.query.bind(world)
    ;(world as { query: (def: QueryDef) => QueryResult }).query = (def: QueryDef) => {
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
    world.stepOnce()
    world.markChanged(a, Sprite)
    world.stepOnce()
    world.stepOnce()
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
    world.stepOnce()
    expect(updateCalls).toBe(0)
    world.stepOnce()
    expect(updateCalls).toBe(0)

    world.markChanged(a, Sprite)
    world.stepOnce()
    expect(updateCalls).toBe(1)

    handle.teardown()
  })


  it('gates update on auto-derived Changed queries when changedOn is omitted (P-3)', () => {
    const world = createWorld({ headless: true })
    let updateCalls = 0
    const view = defineView({
      slot: 'stage',
      query: Has(Sprite),
      // changedOn omitted — renderer should auto-derive [Sprite] from
      // the query's Has(T) leaves.
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
    world.stepOnce()
    expect(updateCalls).toBe(0)
    world.stepOnce()
    // No markChanged yet → auto-derived gate keeps update silent.
    expect(updateCalls).toBe(0)

    world.markChanged(a, Sprite)
    world.stepOnce()
    expect(updateCalls).toBe(1)

    handle.teardown()
  })

  it('passes last mounted complete view to destroy after removal', () => {
    const world = createWorld({ headless: true })
    const seen: string[] = []
    const view = defineView({
      slot: 'stage',
      query: Has(Sprite),
      create(e) {
        const el = document.createElement('span')
        el.textContent = (e as any).Sprite.glyph
        return el
      },
      destroy(_el, e) {
        seen.push((e as any).Sprite?.glyph ?? '')
      },
    })
    const handle = mountDOM(world, { slots: { stage }, views: [view] })
    const a = world.spawn()
    world.addComponent(a, Sprite, { glyph: '@' })
    world.stepOnce()
    world.removeComponent(a, Sprite)
    world.stepOnce()
    expect(seen).toEqual(['@'])
    handle.teardown()
  })

})
