import { beforeEach, describe, expect, it } from 'vitest'
import { Has, createWorld, defineComponent, entry, isOk, type QueryDef, type QueryResult } from '@domecs/core'
import { defineView, mountDOM } from '../src/index.js'

const Sprite = defineComponent<{ glyph: string }>('Sprite')
const Meta = defineComponent<{ label: string }>('Meta')

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
      changedOn: { mode: 'explicit', types: [Sprite] },
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
    const r = mountDOM(world, { slots: { stage }, views: [view] })
    expect(isOk(r)).toBe(true)
    if (!isOk(r)) throw new Error('mount failed')
    const handle = r.value

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
    const r = mountDOM(world, { slots: { stage }, views: [view] })
    expect(isOk(r)).toBe(true)
    if (!isOk(r)) throw new Error('mount failed')
    const handle = r.value
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

  it('opts out of auto-derive when changedOn={mode:"legacy"} (legacy "update every tick")', () => {
    const world = createWorld({ headless: true })
    let updateCalls = 0
    const view = defineView({
      slot: 'stage',
      query: Has(Sprite),
      changedOn: { mode: 'legacy' }, // explicit legacy mode — restore redraw-every-tick.
      create() {
        return document.createElement('span')
      },
      update() {
        updateCalls++
      },
    })
    const r = mountDOM(world, { slots: { stage }, views: [view] })
    expect(isOk(r)).toBe(true)
    if (!isOk(r)) throw new Error('mount failed')
    const handle = r.value
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
      changedOn: { mode: 'explicit', types: [Sprite] },
      create() {
        return document.createElement('span')
      },
      update() {},
    })
    const r = mountDOM(world, { slots: { stage }, views: [view] })
    expect(isOk(r)).toBe(true)
    if (!isOk(r)) throw new Error('mount failed')
    const handle = r.value
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

  it('calls update once on mount (first paint) then gates subsequent updates on Changed', () => {
    const world = createWorld({ headless: true })
    let updateCalls = 0
    const view = defineView({
      slot: 'stage',
      query: Has(Sprite),
      changedOn: { mode: 'explicit', types: [Sprite] },
      create(e) {
        const el = document.createElement('span')
        el.textContent = (e as unknown as { Sprite: { glyph: string } }).Sprite.glyph
        return el
      },
      update() {
        updateCalls++
      },
    })
    const r = mountDOM(world, { slots: { stage }, views: [view] })
    expect(isOk(r)).toBe(true)
    if (!isOk(r)) throw new Error('mount failed')
    const handle = r.value

    const a = world.spawn()
    world.addComponent(a, Sprite, { glyph: '@' })
    world.stepOnce()
    // O-2: first paint runs update once at create even without OnChanged.
    expect(updateCalls).toBe(1)
    world.stepOnce()
    expect(updateCalls).toBe(1)

    world.markChanged(a, Sprite)
    world.stepOnce()
    expect(updateCalls).toBe(2)

    handle.teardown()
  })

  it('first-paints static entities under default changedOn:auto (O-2)', () => {
    const world = createWorld({ headless: true })
    const view = defineView({
      slot: 'stage',
      query: Has(Sprite),
      // changedOn omitted → auto
      create() {
        const el = document.createElement('span')
        el.textContent = '' // intentionally empty — update paints
        return el
      },
      update(el, e) {
        el.textContent = (e as unknown as { Sprite: { glyph: string } }).Sprite.glyph
      },
    })
    const r = mountDOM(world, { slots: { stage }, views: [view] })
    expect(isOk(r)).toBe(true)
    if (!isOk(r)) throw new Error('mount failed')

    const id = world.spawn()
    world.addComponent(id, Sprite, { glyph: 'X' })
    world.stepOnce()
    expect(stage.firstElementChild?.textContent).toBe('X')
    // No markChanged; content must stay painted (not cleared/empty).
    world.stepOnce()
    expect(stage.firstElementChild?.textContent).toBe('X')
  })

  it('runs update exactly once when an entity is created AND marked changed in the same window (O-2 residual)', () => {
    const world = createWorld({ headless: true })
    let updateCalls = 0
    const view = defineView({
      slot: 'stage',
      query: Has(Sprite),
      // changedOn omitted → auto
      create() {
        return document.createElement('span')
      },
      update(el, e) {
        updateCalls++
        el.textContent = (e as unknown as { Sprite: { glyph: string } }).Sprite.glyph
      },
    })
    const r = mountDOM(world, { slots: { stage }, views: [view] })
    expect(isOk(r)).toBe(true)
    if (!isOk(r)) throw new Error('mount failed')
    const handle = r.value

    // The exact pre-O-2 workaround pattern: spawn + explicit markChanged in
    // one commit window. First paint and the Changed mark must coalesce into
    // ONE update call, or non-idempotent update callbacks regress.
    const a = world.spawn()
    world.addComponent(a, Sprite, { glyph: '@' })
    world.markChanged(a, Sprite)
    world.stepOnce()
    expect(updateCalls).toBe(1)
    expect(stage.firstElementChild?.textContent).toBe('@')

    handle.teardown()
  })

  it('first paint sees components added later in the same window (fresh commit-time view, O-2 residual)', () => {
    const world = createWorld({ headless: true })
    const view = defineView({
      slot: 'stage',
      query: Has(Sprite),
      // changedOn omitted → auto
      create() {
        return document.createElement('span')
      },
      update(el, e) {
        const meta = (e as unknown as { Meta?: { label: string } }).Meta
        el.textContent = meta ? meta.label : 'MISSING'
      },
    })
    const r = mountDOM(world, { slots: { stage }, views: [view] })
    expect(isOk(r)).toBe(true)
    if (!isOk(r)) throw new Error('mount failed')

    // Spawn-bag adds Sprite (query match → view captured) and Meta within
    // one commit window. The first paint must read a commit-time view that
    // includes Meta — a static entity never heals a stale first paint.
    const a = world.spawn([entry(Sprite, { glyph: '@' }), entry(Meta, { label: 'hello' })])
    void a
    world.stepOnce()
    expect(stage.firstElementChild?.textContent).toBe('hello')
    world.stepOnce()
    expect(stage.firstElementChild?.textContent).toBe('hello')
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
    const r = mountDOM(world, { slots: { stage }, views: [view] })
    expect(isOk(r)).toBe(true)
    if (!isOk(r)) throw new Error('mount failed')
    const handle = r.value

    const a = world.spawn()
    world.addComponent(a, Sprite, { glyph: '@' })
    world.stepOnce()
    // O-2 first paint + auto-derived gate for subsequent ticks.
    expect(updateCalls).toBe(1)
    world.stepOnce()
    // No markChanged yet → auto-derived gate keeps update silent.
    expect(updateCalls).toBe(1)

    world.markChanged(a, Sprite)
    world.stepOnce()
    expect(updateCalls).toBe(2)

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
    const r = mountDOM(world, { slots: { stage }, views: [view] })
    expect(isOk(r)).toBe(true)
    if (!isOk(r)) throw new Error('mount failed')
    const handle = r.value
    const a = world.spawn()
    world.addComponent(a, Sprite, { glyph: '@' })
    world.stepOnce()
    world.removeComponent(a, Sprite)
    world.stepOnce()
    expect(seen).toEqual(['@'])
    handle.teardown()
  })

})
