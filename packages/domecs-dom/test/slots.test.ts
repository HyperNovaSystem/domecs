import { beforeEach, describe, expect, it } from 'vitest'
import { Has, createWorld, defineComponent } from 'domecs'
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

  it('throws on second mountDOM claiming an already-mounted slot name (exclusive mounting)', () => {
    const world = createWorld({ headless: true })
    const h1 = mountDOM(world, { slots: { stage }, views: [] })
    expect(() =>
      mountDOM(world, { slots: { stage: stage2 }, views: [] }),
    ).toThrow(/already mounted/i)
    h1.teardown()
    expect(() =>
      mountDOM(world, { slots: { stage: stage2 }, views: [] }),
    ).not.toThrow()
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
    const handle = mountDOM(world, { slots: { stage }, views: [v1, v2] })
    const a = world.spawn()
    world.addComponent(a, Tag, {})
    world.step()
    const kids = Array.from(stage.children) as HTMLElement[]
    expect(kids.length).toBe(2)
    expect(kids[0]!.dataset.from).toBe('v1')
    expect(kids[1]!.dataset.from).toBe('v2')
    handle.teardown()
    expect(stage.children.length).toBe(0)
  })

  it('throws when a view targets a slot that was not registered', () => {
    const world = createWorld({ headless: true })
    const v = defineView({
      slot: 'missing',
      query: Has(Tag),
      create() {
        return document.createElement('span')
      },
    })
    expect(() => mountDOM(world, { slots: { stage }, views: [v] })).toThrow(
      /not registered/i,
    )
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
    const handle = mountDOM(world, { slots: { stage }, views: [v] })
    world.step()
    expect(stage.children.length).toBe(1)
    handle.teardown()
  })
})
