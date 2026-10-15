import { beforeEach, describe, expect, it } from 'vitest'
import { Has, Not, Where, createWorld, defineComponent, entry, isOk, isErr, type QueryResult } from '@domecs/core'
import { defineView, mountDOM } from '../src/index.js'

const Tag = defineComponent<{}>('Tag')

describe('mountDOM — slot policy (SPEC §5.6)', () => {
  let stage: HTMLElement
  let stage2: HTMLElement
  let hud: HTMLElement
  beforeEach(() => {
    document.body.innerHTML = ''
    stage = document.createElement('div')
    stage2 = document.createElement('div')
    hud = document.createElement('div')
    document.body.append(stage, stage2, hud)
  })

  it('returns err on duplicate slot mount (slot_already_mounted)', () => {
    const world = createWorld({ headless: true })
    const r1 = mountDOM(world, { slots: { stage }, views: [] })
    expect(isOk(r1)).toBe(true)
    if (!isOk(r1)) throw new Error('mount failed')
    const h1 = r1.value

    const r2 = mountDOM(world, { slots: { stage: stage2 }, views: [] })
    expect(isErr(r2)).toBe(true)
    if (isErr(r2)) expect(r2.error.kind).toBe('slot_already_mounted')

    h1.teardown()
    // After teardown the slot is released, so remount should succeed
    const r3 = mountDOM(world, { slots: { stage: stage2 }, views: [] })
    expect(isOk(r3)).toBe(true)
    if (isOk(r3)) r3.value.teardown()
  })

  it('view registration is additive — multiple views on same slot append in registration order', () => {
    const world = createWorld({ headless: true })
    const v1 = defineView({
      slot: 'stage',
      query: Has(Tag),
      create() {
        const el = document.createElement('span')
        el.dataset.from = 'v1'
        return el
      },
    })
    const v2 = defineView({
      slot: 'stage',
      query: Has(Tag),
      create() {
        const el = document.createElement('span')
        el.dataset.from = 'v2'
        return el
      },
    })
    const r = mountDOM(world, { slots: { stage }, views: [v1, v2] })
    expect(isOk(r)).toBe(true)
    if (!isOk(r)) throw new Error('mount failed')
    const handle = r.value
    const a = world.spawn()
    world.addComponent(a, Tag, {})
    world.stepOnce()
    const kids = Array.from(stage.children) as HTMLElement[]
    expect(kids.length).toBe(2)
    expect(kids[0]!.dataset.from).toBe('v1')
    expect(kids[1]!.dataset.from).toBe('v2')
    handle.teardown()
    expect(stage.children.length).toBe(0)
  })

  it('returns err when a view targets a slot that was not registered (unregistered_slot)', () => {
    const world = createWorld({ headless: true })
    const v = defineView({
      slot: 'missing',
      query: Has(Tag),
      create() {
        return document.createElement('span')
      },
    })
    const r = mountDOM(world, { slots: { stage }, views: [v] })
    expect(isErr(r)).toBe(true)
    if (isErr(r)) {
      expect(r.error.kind).toBe('unregistered_slot')
    }
  })

  it('mounts entities already present at mountDOM time', () => {
    const world = createWorld({ headless: true })
    const a = world.spawn()
    world.addComponent(a, Tag, {})
    const v = defineView({
      slot: 'stage',
      query: Has(Tag),
      create() {
        return document.createElement('span')
      },
    })
    const r = mountDOM(world, { slots: { stage }, views: [v] })
    expect(isOk(r)).toBe(true)
    if (!isOk(r)) throw new Error('mount failed')
    const handle = r.value
    world.stepOnce()
    expect(stage.children.length).toBe(1)
    handle.teardown()
  })

  it('mounts a second renderer on other slots of the same world (O-55 D7)', () => {
    const world = createWorld({ headless: true })
    const Mark = defineComponent<{ n: number }>('SlMark', { defaults: { n: 0 } })
    const r1 = mountDOM(world, {
      slots: { stage },
      views: [defineView({ slot: 'stage', query: Has(Mark), create: () => document.createElement('i') })],
    })
    const r2 = mountDOM(world, {
      slots: { hud },
      views: [defineView({ slot: 'hud', query: Has(Mark), create: () => document.createElement('b') })],
    })
    expect(isOk(r1) && isOk(r2)).toBe(true)
    world.spawn([entry(Mark, { n: 1 })])
    world.stepOnce()
    expect(stage.children).toHaveLength(1)
    expect(hud.children).toHaveLength(1)
    if (isOk(r2)) r2.value.teardown()
    if (isOk(r1)) r1.value.teardown()
    expect(stage.children).toHaveLength(0)
  })

  it('rejects a view with update but no redraw trigger (O-55 D5)', () => {
    const world = createWorld({ headless: true })
    const Mark = defineComponent<{ n: number }>('SlMark2', { defaults: { n: 0 } })
    const explicitEmpty = mountDOM(world, {
      slots: { stage },
      views: [defineView({
        slot: 'stage', query: Has(Mark), changedOn: { mode: 'explicit', types: [] },
        create: () => document.createElement('i'), update: () => {},
      })],
    })
    expect(isErr(explicitEmpty) && explicitEmpty.error.kind).toBe('invalid_changed_on')
    const noLeaf = mountDOM(world, {
      slots: { stage },
      views: [defineView({
        slot: 'stage', query: Not(Has(Mark)),
        create: () => document.createElement('i'), update: () => {},
      })],
    })
    expect(isErr(noLeaf) && noLeaf.error.kind).toBe('invalid_changed_on')
    // A Where leaf is a trigger.
    const where = mountDOM(world, {
      slots: { stage },
      views: [defineView({
        slot: 'stage', query: Where(Mark, (m) => m.n > 0),
        create: () => document.createElement('i'), update: () => {},
      })],
    })
    expect(isOk(where)).toBe(true)
  })
})

describe('mountDOM — failed mounts roll back cleanly (O-17)', () => {
  it('disposes the queries + subscriptions built before an error return', () => {
    const world = createWorld({ headless: true })
    // capture every query the mount creates so disposal is observable
    const created: QueryResult[] = []
    const origQuery = world.query.bind(world)
    ;(world as { query: typeof world.query }).query = (def: Parameters<typeof world.query>[0]) => {
      const q = origQuery(def)
      created.push(q)
      return q
    }
    const stage = document.createElement('div')
    const good = defineView({
      slot: 'stage',
      query: [Tag],
      create: () => document.createElement('i'),
    })
    const bad = defineView({
      slot: 'not-a-slot',
      query: [Tag],
      create: () => document.createElement('i'),
    })
    const r = mountDOM(world, { slots: { stage }, views: [good, bad] })
    expect(isErr(r)).toBe(true)
    if (isErr(r)) expect(r.error.kind).toBe('unregistered_slot')
    expect(created.length).toBeGreaterThan(0)
    // a leaked live query would track this spawn; disposed queries report 0
    world.spawn([entry(Tag, {})])
    for (const q of created) expect(q.size).toBe(0)
    // and the slot claims were rolled back, so the same slot mounts cleanly
    const r2 = mountDOM(world, { slots: { stage }, views: [good] })
    expect(isOk(r2)).toBe(true)
    if (isOk(r2)) r2.value.teardown()
  })
})
