import { beforeEach, describe, expect, it } from 'vitest'
import { And, Has, OnChanged, Where, createWorld, defineComponent, entry, isOk } from '@domecs/core'
import { defineView, mountDOM } from '../src/index.js'

const Pos = defineComponent<{ x: number }>('WvPos')

// O-52 (2026-10-13 engine review D1): a view whose query has a `Where` filter
// mounts exactly the entities that pass it, and follows them in and out as
// the filtered field changes. Temporal nodes are rejected.
describe('mountDOM — Where in a view query (O-52)', () => {
  let stage: HTMLElement
  beforeEach(() => {
    document.body.innerHTML = ''
    stage = document.createElement('div')
    document.body.appendChild(stage)
  })

  const ids = (): number[] =>
    Array.from(stage.children, (el) => Number((el as HTMLElement).dataset.eid)).sort((a, b) => a - b)

  function mount(world: ReturnType<typeof createWorld>) {
    return mountDOM(world, {
      slots: { stage },
      views: [
        defineView({
          slot: 'stage',
          query: Where(Pos, (p) => p.x > 0),
          create: (e) => {
            const el = document.createElement('i')
            el.dataset.eid = String(e.id)
            return el
          },
          update: (el, e) => {
            el.textContent = String((e as unknown as { WvPos: { x: number } }).WvPos.x)
          },
        }),
      ],
    })
  }

  it('mounts only matching entities and follows field changes', () => {
    const world = createWorld({ headless: true })
    const before = world.spawn([entry(Pos, { x: -1 })])
    expect(isOk(mount(world))).toBe(true)
    const neg = world.spawn([entry(Pos, { x: -5 })])
    const pos = world.spawn([entry(Pos, { x: 3 })])
    world.stepOnce()
    expect(ids()).toEqual([pos])

    world.getComponent(before, Pos)!.x = 10
    world.markChanged(before, Pos)
    world.stepOnce()
    expect(ids()).toEqual([before, pos])
    expect(stage.textContent).toContain('10')

    world.getComponent(pos, Pos)!.x = -2
    world.markChanged(pos, Pos)
    world.stepOnce()
    expect(ids()).toEqual([before])

    world.despawn(before)
    world.stepOnce()
    expect(ids()).toEqual([])
    expect(neg).toBeGreaterThan(-1)
  })

  it('rejects temporal nodes with invalid_view_query', () => {
    const world = createWorld({ headless: true })
    const r = mountDOM(world, {
      slots: { stage },
      views: [
        defineView({
          slot: 'stage',
          query: And(Has(Pos), OnChanged(Pos)) as never,
          create: () => document.createElement('i'),
        }),
      ],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe('invalid_view_query')
    // The slot claim was rolled back.
    expect(isOk(mount(world))).toBe(true)
  })
})
