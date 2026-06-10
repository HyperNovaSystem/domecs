import { beforeEach, describe, expect, it } from 'vitest'
import { Has, createWorld, defineComponent, isOk } from '@domecs/core'
import { defineView, mountDOM } from '../src/index.js'

const TableRow = defineComponent<{ rank: number }>('TableRow')

// O-16: a same-tick remove-all/re-add projection (hand-rolled despawn+respawn)
// must not leave stale DOM content. The remove cancels into pendingDestroy,
// the re-add cancels the destroy and lands in pendingCreate, the create-phase
// double-create guard skips the mounted node — and OnChanged never fires
// (re-add is an Added mark, not a Changed mark) — so pre-fix the surviving
// node kept its pre-rebuild content. The trap: child COUNT stays correct;
// assert the rendered content set, not the length.
describe('mountDOM — same-tick remove+add reconciliation (O-16)', () => {
  let stage: HTMLElement
  beforeEach(() => {
    document.body.innerHTML = ''
    stage = document.createElement('div')
    stage.id = 'stage'
    document.body.appendChild(stage)
  })

  function rankView() {
    return defineView({
      slot: 'stage',
      query: Has(TableRow),
      // changedOn omitted — auto mode, the default consumers get.
      create(e) {
        const el = document.createElement('button')
        el.className = 'row'
        el.dataset.eid = String(e.id)
        el.textContent = String((e as unknown as { TableRow: { rank: number } }).TableRow.rank)
        return el
      },
      update(el, e) {
        el.dataset.eid = String(e.id)
        el.textContent = String((e as unknown as { TableRow: { rank: number } }).TableRow.rank)
      },
    })
  }

  function renderedRanks(): number[] {
    return Array.from(stage.children, (el) => Number(el.textContent)).sort((a, b) => a - b)
  }

  it('repaints surviving entities after a between-tick remove-all/re-add rebuild', () => {
    const world = createWorld({ headless: true })
    const r = mountDOM(world, { slots: { stage }, views: [rankView()] })
    expect(isOk(r)).toBe(true)
    if (!isOk(r)) throw new Error('mount failed')

    const ids = Array.from({ length: 6 }, () => world.spawn())
    ids.forEach((id, i) => world.addComponent(id, TableRow, { rank: i + 1 }))
    world.stepOnce()
    expect(renderedRanks()).toEqual([1, 2, 3, 4, 5, 6])

    // Rebuild: remove the whole window, re-add with reversed ranks.
    for (const id of ids) world.removeComponent(id, TableRow)
    ids.forEach((id, i) => world.addComponent(id, TableRow, { rank: 6 - i }))
    world.stepOnce()

    expect(stage.children.length).toBe(6)
    // The set must be exactly 1..6 (no duplicates / stale pre-rebuild ranks)…
    expect(renderedRanks()).toEqual([1, 2, 3, 4, 5, 6])
    // …and each node must carry its entity's POST-rebuild rank.
    for (const el of Array.from(stage.children) as HTMLElement[]) {
      const id = Number(el.dataset.eid)
      const idx = ids.indexOf(id)
      expect(el.textContent).toBe(String(6 - idx))
    }
    r.value.teardown()
  })

  it('repaints surviving entities when the rebuild runs inside a tick system (fleet projection shape)', () => {
    const world = createWorld({ headless: true })
    const r = mountDOM(world, { slots: { stage }, views: [rankView()] })
    expect(isOk(r)).toBe(true)
    if (!isOk(r)) throw new Error('mount failed')

    const ids = Array.from({ length: 4 }, () => world.spawn())
    ids.forEach((id, i) => world.addComponent(id, TableRow, { rank: i + 1 }))
    world.stepOnce()
    expect(renderedRanks()).toEqual([1, 2, 3, 4])

    let rebuild = false
    world.system('rebuildTableRows', { schedule: 'tick' }, () => {
      if (!rebuild) return
      rebuild = false
      for (const id of ids) world.removeComponent(id, TableRow)
      ids.forEach((id, i) => world.addComponent(id, TableRow, { rank: 4 - i }))
    })

    rebuild = true
    world.stepOnce()
    expect(stage.children.length).toBe(4)
    for (const el of Array.from(stage.children) as HTMLElement[]) {
      const id = Number(el.dataset.eid)
      const idx = ids.indexOf(id)
      expect(el.textContent).toBe(String(4 - idx))
    }
    r.value.teardown()
  })

  it('rebuilds the node for a re-added entity when the view has no update()', () => {
    const world = createWorld({ headless: true })
    let destroyed = 0
    const view = defineView({
      slot: 'stage',
      query: Has(TableRow),
      create(e) {
        const el = document.createElement('span')
        el.textContent = String((e as unknown as { TableRow: { rank: number } }).TableRow.rank)
        return el
      },
      destroy() {
        destroyed++
      },
    })
    const r = mountDOM(world, { slots: { stage }, views: [view] })
    expect(isOk(r)).toBe(true)
    if (!isOk(r)) throw new Error('mount failed')

    const a = world.spawn()
    world.addComponent(a, TableRow, { rank: 1 })
    world.stepOnce()
    expect(stage.firstElementChild?.textContent).toBe('1')

    world.removeComponent(a, TableRow)
    world.addComponent(a, TableRow, { rank: 9 })
    world.stepOnce()
    // create() is the only painter — the node must be torn down and rebuilt.
    expect(stage.children.length).toBe(1)
    expect(stage.firstElementChild?.textContent).toBe('9')
    expect(destroyed).toBe(1)
    r.value.teardown()
  })

  it('handles a partial-overlap window: leavers destroyed, enterers created, survivors repainted', () => {
    const world = createWorld({ headless: true })
    const r = mountDOM(world, { slots: { stage }, views: [rankView()] })
    expect(isOk(r)).toBe(true)
    if (!isOk(r)) throw new Error('mount failed')

    // Window 1: entities 0..4 ranked 1..5.
    const ids = Array.from({ length: 8 }, () => world.spawn())
    for (let i = 0; i < 5; i++) world.addComponent(ids[i]!, TableRow, { rank: i + 1 })
    world.stepOnce()
    expect(renderedRanks()).toEqual([1, 2, 3, 4, 5])

    // Window 2: remove all, re-add entities 3..7 ranked 1..5 (overlap: 3,4).
    for (let i = 0; i < 5; i++) world.removeComponent(ids[i]!, TableRow)
    for (let i = 3; i < 8; i++) world.addComponent(ids[i]!, TableRow, { rank: i - 2 })
    world.stepOnce()

    expect(stage.children.length).toBe(5)
    expect(renderedRanks()).toEqual([1, 2, 3, 4, 5])
    const mountedIds = Array.from(stage.children, (el) => Number((el as HTMLElement).dataset.eid)).sort(
      (a, b) => a - b,
    )
    expect(mountedIds).toEqual(ids.slice(3).sort((a, b) => a - b))
    r.value.teardown()
  })
})
