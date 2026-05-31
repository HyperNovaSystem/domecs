import { beforeEach, describe, expect, it } from 'vitest'
import { Has, createWorld, defineComponent, isOk, isErr } from '@domecs/core'
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

  it('returns err on plugin_install_failed when renderer plugin already installed', () => {
    // Mount once to install the renderer plugin under this plugin name
    const world = createWorld({ headless: true })
    const r1 = mountDOM(world, { slots: { stage }, views: [] })
    expect(isOk(r1)).toBe(true)
    // The renderer plugin is now registered; calling mountDOM again on the
    // same world would re-install the same plugin name, causing a throw from
    // world.use — which mountDOM should catch and return as err.
    const r2 = mountDOM(world, { slots: { hud }, views: [] })
    expect(isErr(r2)).toBe(true)
    if (isErr(r2)) expect(r2.error.kind).toBe('plugin_install_failed')
    if (isOk(r1)) r1.value.teardown()
  })
})
