import { describe, expect, it } from 'vitest'
import { hashSnapshot } from '../src/canonical.js'
import { defineComponent } from '../src/component.js'
import { OnAdded, OnChanged, OnChangedResource, OnRemoved, Or } from '../src/query.js'
import { defineResource } from '../src/resource.js'
import type { WorldSnapshot } from '../src/snapshot.js'
import { entry, type Entity } from '../src/types.js'
import { createWorld, type World } from '../src/world.js'

// H-4 (Harbor findings): snapshot().changes carried marks on transient
// components, which the snapshot itself leaves out, so two worlds differing
// only in presentation tags were not strict-hash equal once any system read
// changes. And every mark newer than the slowest reader was kept, whatever
// component it was on.

const Tag = defineComponent<{ k: number }>('ScTag', { defaults: { k: 0 }, transient: true })
const Pos = defineComponent<{ v: number }>('ScPos', { defaults: { v: 0 } })
const Other = defineComponent<{ n: number }>('ScOther', { defaults: { n: 0 } })
const Score = defineResource<number>('ScScore', { default: 0 })
const Cam = defineResource<number>('ScCam', { default: 0, transient: true })

const strict = (w: World): string => hashSnapshot(w.snapshot(), { includeChanges: true })

/** A world whose one change reader (1 Hz at 16 Hz) has not run after three steps. */
function build(): { w: World; e: Entity; seen: Entity[] } {
  const w = createWorld({ headless: true, fixedStep: 1 / 16 })
  const seen: Entity[] = []
  w.system('slow', { schedule: 'fixed', rateHz: 1, query: OnChanged(Pos) }, ({ entities }) => {
    for (const v of entities) seen.push(v.id)
  })
  const e = w.spawn([entry(Pos, { v: 0 }), entry(Other, { n: 0 })])
  for (let i = 0; i < 3; i++) w.step(1 / 16)
  return { w, e, seen }
}

describe('change marks in snapshots (H-4)', () => {
  it('leaves out marks on transient components and resources', () => {
    const a = build()
    const b = build()
    // Presentation state: a stage tag added and marked, a camera moved.
    a.w.addComponent(a.e, Tag, { k: 1 })
    a.w.markChanged(a.e, Tag)
    a.w.setResource(Cam, 5)
    expect(a.w.snapshot().changes?.marks.some((m) => m[1] === 'ScTag' || m[1] === 'ScCam')).not.toBe(true)
    expect(strict(a.w)).toBe(strict(b.w))
  })

  it('carries a mark only while a reader that watches its kind and component has not seen it', () => {
    const { w, e } = build()
    w.markChanged(e, Other) // no reader watches Other
    w.markChanged(e, Pos) // `slow` watches changed:Pos
    const changes = w.snapshot().changes
    // The spawn's added marks are watched by nobody either.
    expect(changes).toEqual({ marks: [['changed', 'ScPos', e]], seen: { slow: 0 } })
  })

  it('two worlds differing only in marks nobody reads hash equal', () => {
    const a = build()
    const b = build()
    a.w.markChanged(a.e, Other)
    a.w.setResource(Score, 3)
    b.w.setResource(Score, 3)
    expect(strict(a.w)).toBe(strict(b.w))
  })

  it('a restored twin reports what the live world would', () => {
    const live = build()
    live.w.markChanged(live.e, Other)
    live.w.markChanged(live.e, Pos)
    const snap = JSON.parse(JSON.stringify(live.w.snapshot())) as WorldSnapshot
    const twin = build()
    twin.w.restore(snap)
    expect(strict(twin.w)).toBe(strict(live.w))
    for (const { w } of [live, twin]) for (let i = 0; i < 13; i++) w.step(1 / 16)
    expect(live.seen).toEqual([live.e])
    expect(twin.seen).toEqual(live.seen)
  })

  it('keeps each kind for the readers of that kind, resources included', () => {
    const w = createWorld({ headless: true, fixedStep: 1 / 16 })
    w.system('adds', { schedule: 'fixed', rateHz: 1, query: OnAdded(Other) }, () => {})
    w.system('gone', { schedule: 'fixed', rateHz: 1, query: OnRemoved(Pos) }, () => {})
    w.system('score', { schedule: 'reactive', reactsTo: Or(OnChanged(Pos), OnChangedResource(Score)) }, () => {})
    w.step(1 / 16)
    const e = w.spawn([entry(Pos, { v: 0 }), entry(Other, { n: 0 })]) // added:Pos unwatched
    w.markChanged(e, Other) // changed:Other unwatched
    w.setResource(Score, 1)
    const gone = w.spawn([entry(Pos, { v: 0 })])
    w.despawn(gone)
    expect(w.snapshot().changes).toEqual({
      marks: [
        ['added', 'ScOther', e],
        ['resource', 'ScScore'],
        ['removed', 'ScPos', gone],
      ],
      seen: { adds: 0, gone: 0, score: 0 },
    })
  })
})
