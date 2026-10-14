import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import { defineEvent } from '../src/events.js'
import { definePlugin } from '../src/plugin.js'
import { And, Has, OnAdded, OnChanged, OnChangedResource, OnRemoved } from '../src/query.js'
import { defineResource } from '../src/resource.js'
import type { WorldSnapshot } from '../src/snapshot.js'
import { entry, type Entity } from '../src/types.js'
import { createWorld, type World } from '../src/world.js'

// O-42 (2026-10-13 engine review C3): a change-detection filter reports every
// mark since its reader last looked — for a system, since its previous run —
// so no mark is lost to a reader that ran earlier in the tick than the writer.

const Hp = defineComponent<{ hp: number }>('CwHp', { defaults: { hp: 10 } })
const Glyph = defineComponent<{ ch: string }>('CwGlyph', { defaults: { ch: '.' } })
const Hit = defineEvent<{ id: Entity }>('CwHit')
const Config = defineResource<{ n: number }>('CwConfig', { default: { n: 0 } })

function hit(w: World, id: Entity): void {
  w.getComponent(id, Hp)!.hp -= 1
  w.markChanged(id, Hp)
}

describe('O-42: systems see every mark since their last run', () => {
  it('a tick system sees a change an event system made after it ran', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Hp, { hp: 10 })])
    const seen: number[] = []
    w.system('watch', { schedule: 'tick', query: OnChanged(Hp) }, ({ entities }) => {
      for (const e of entities) seen.push(w.time.tick, e.id)
    })
    w.system('onHit', { schedule: 'event', triggers: [Hit] }, ({ events }) => {
      for (const ev of events.of(Hit)) hit(w, ev.id)
    })
    w.stepOnce() // tick 1: spawn not a change; nothing seen
    w.emit(Hit, { id })
    w.stepOnce() // tick 2: event system marks Hp after `watch` ran
    expect(seen).toEqual([])
    w.stepOnce() // tick 3: `watch` sees it
    expect(seen).toEqual([3, id])
    w.stepOnce() // seen exactly once
    expect(seen).toEqual([3, id])
  })

  it('a reactive re-trigger is deferred to the next tick, once', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Hp, { hp: 10 }), entry(Glyph, { ch: 'a' })])
    const bFired: number[] = []
    // B runs first (priority -1) and watches Glyph; A marks Glyph when Hp changes.
    w.system('B', { schedule: 'reactive', priority: -1, reactsTo: OnChanged(Glyph) }, () => {
      bFired.push(w.time.tick)
    })
    w.system('A', { schedule: 'reactive', reactsTo: OnChanged(Hp) }, ({ entities }) => {
      for (const e of entities) {
        w.getComponent(e.id, Glyph)!.ch = 'b'
        w.markChanged(e.id, Glyph)
      }
    })
    w.stepOnce()
    hit(w, id)
    w.stepOnce() // A fires and marks Glyph after B ran
    expect(bFired).toEqual([])
    w.stepOnce()
    w.stepOnce()
    expect(bFired).toEqual([3])
  })

  it('a system does not see its own writes', () => {
    const w = createWorld({ headless: true })
    w.spawn([entry(Hp, { hp: 10 })])
    let runs = 0
    w.system('self', { schedule: 'reactive', reactsTo: OnChanged(Hp) }, ({ entities }) => {
      runs++
      for (const e of entities) hit(w, e.id)
    })
    const [id] = w.listEntities([Hp])
    hit(w, id!)
    for (let i = 0; i < 5; i++) w.stepOnce()
    expect(runs).toBe(1)
  })

  it('marks made in tickEnd reach the next tick', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Glyph, { ch: 'a' })])
    const seen: string[] = []
    w.system('watch', { schedule: 'tick', query: OnChanged(Glyph) }, ({ entities }) => {
      for (const e of entities) seen.push(w.getComponent(e.id, Glyph)!.ch)
    })
    let once = true
    w.use(
      definePlugin({
        name: 'cw:late',
        install: () => ({
          onTickEnd: () => {
            if (!once) return
            once = false
            w.getComponent(id, Glyph)!.ch = 'z'
            w.markChanged(id, Glyph)
          },
        }),
      }),
    )
    w.stepOnce()
    w.stepOnce()
    expect(seen).toEqual(['z'])
  })

  it('a sub-rate fixed system sees changes from the frames it skipped', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Hp, { hp: 10 })])
    let total = 0
    w.system('slow', { schedule: 'fixed', rateHz: 15, query: OnChanged(Hp) }, ({ entities }) => {
      total += entities.length
    })
    w.system('hitter', { schedule: 'tick' }, () => hit(w, id))
    for (let i = 0; i < 8; i++) w.step(1 / 60)
    // `slow` ran twice (every 4th step); each run saw the one entity.
    expect(total).toBe(2)
  })

  it('a disabled system sees what changed while it was off', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Hp, { hp: 10 })])
    let on = false
    const seen: Entity[] = []
    w.system('watch', { schedule: 'tick', query: OnChanged(Hp), enabled: () => on }, ({ entities }) => {
      for (const e of entities) seen.push(e.id)
    })
    w.stepOnce()
    hit(w, id)
    w.stepOnce()
    w.stepOnce()
    on = true
    w.stepOnce()
    expect(seen).toEqual([id])
  })

  it('OnAdded/OnRemoved and resources follow the same windows', () => {
    const w = createWorld({ headless: true })
    const log: string[] = []
    w.system('adds', { schedule: 'tick', query: OnAdded(Hp) }, ({ entities }) => {
      for (const e of entities) log.push(`add ${e.id}`)
    })
    w.system('removes', { schedule: 'tick', query: OnRemoved(Hp) }, ({ entities }) => {
      for (const e of entities) log.push(`rm ${e.id}`)
    })
    w.system('cfg', { schedule: 'tick', query: OnChangedResource(Config) }, ({ entities }) => {
      if (entities.length > 0) log.push('cfg')
    })
    w.system('late', { schedule: 'event', triggers: [Hit] }, ({ events }) => {
      for (const ev of events.of(Hit)) {
        if (ev.id < 0) {
          w.setResource(Config, { n: 1 })
          continue
        }
        w.despawn(ev.id)
        w.spawn([entry(Hp, { hp: 1 })])
      }
    })
    const a = w.spawn([entry(Hp, { hp: 1 })])
    w.stepOnce()
    expect(log).toEqual([`add ${a}`])
    w.emit(Hit, { id: a })
    w.emit(Hit, { id: -1 })
    w.stepOnce()
    w.stepOnce()
    expect(log).toEqual([`add ${a}`, `add ${a + 1}`, `rm ${a}`, 'cfg'])
  })
})

describe('O-42: queries outside systems', () => {
  it('a query read each tick reports marks made after its last read', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Glyph, { ch: 'a' })])
    const q = w.query(OnChanged(Glyph))
    const reads: number[][] = []
    w.use(
      definePlugin({
        name: 'cw:reader',
        install: () => ({ onRender: () => void reads.push(q.entities.map((e) => e.id)) }),
      }),
    )
    let mark = true
    w.use(
      definePlugin({
        name: 'cw:late-writer',
        install: () => ({
          onTickEnd: () => {
            if (!mark) return
            mark = false
            w.markChanged(id, Glyph)
          },
        }),
      }),
    )
    w.stepOnce() // render reads before tickEnd marks
    w.stepOnce() // next read sees it
    w.stepOnce() // and only once
    expect(reads).toEqual([[], [id], []])
  })

  it('a heartbeat render paints a between-tick mark once', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Glyph, { ch: 'a' })])
    w.stepOnce()
    const q = w.query(OnChanged(Glyph))
    const reads: number[][] = []
    w.use(
      definePlugin({
        name: 'cw:paint',
        install: () => ({ onRender: () => void reads.push(q.entities.map((e) => e.id)) }),
      }),
    )
    w.markChanged(id, Glyph)
    w.step(0)
    w.stepOnce()
    expect(reads).toEqual([[id], []])
  })
})

describe('O-42: snapshot and restore carry unseen marks', () => {
  function build(w: World): { seen: string[] } {
    const out = { seen: [] as string[] }
    w.system('watch', { schedule: 'tick', query: OnChanged(Hp) }, ({ entities }) => {
      for (const e of entities) out.seen.push(`${w.time.tick}:${e.id}`)
    })
    w.system('onHit', { schedule: 'event', triggers: [Hit] }, ({ events }) => {
      for (const ev of events.of(Hit)) hit(w, ev.id)
    })
    w.system('gone', { schedule: 'reactive', reactsTo: OnRemoved(Hp) }, ({ entities }) => {
      for (const e of entities) out.seen.push(`rm${w.time.tick}:${e.id}`)
    })
    return out
  }

  it('omits `changes` when every system has seen every mark', () => {
    const w = createWorld({ headless: true })
    build(w)
    w.spawn([entry(Hp, { hp: 3 })])
    w.stepOnce()
    w.stepOnce()
    expect(w.snapshot().changes).toBeUndefined()
  })

  it('a restored twin reports the same marks as the live world', () => {
    const live = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    const liveOut = build(live)
    const a = live.spawn([entry(Hp, { hp: 3 })])
    const b = live.spawn([entry(Hp, { hp: 5 })])
    live.stepOnce()
    live.emit(Hit, { id: a })
    live.stepOnce() // `watch` has not seen the hit yet
    live.markChanged(b, Hp) // between-tick mark
    live.despawn(b)
    const snap = live.snapshot()
    expect(snap.changes).toBeDefined()

    const twin = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    const twinOut = build(twin)
    twin.restore(JSON.parse(JSON.stringify(snap)) as WorldSnapshot)
    expect(JSON.stringify(twin.snapshot())).toBe(JSON.stringify(snap))

    liveOut.seen.length = 0
    for (let i = 0; i < 4; i++) {
      live.stepOnce()
      twin.stepOnce()
      expect(JSON.stringify(twin.snapshot())).toBe(JSON.stringify(live.snapshot()))
    }
    expect(twinOut.seen).toEqual(liveOut.seen)
    expect(liveOut.seen).toEqual([`3:${a}`, `rm3:${b}`])
  })

  it('cursors wait for systems registered after the restore', () => {
    const live = createWorld({ headless: true })
    const liveOut = build(live)
    const a = live.spawn([entry(Hp, { hp: 3 })])
    live.stepOnce()
    live.emit(Hit, { id: a })
    live.stepOnce()
    const snap = live.snapshot()

    const twin = createWorld({ headless: true })
    twin.restore(snap)
    const twinOut = build(twin)
    liveOut.seen.length = 0
    live.stepOnce()
    twin.stepOnce()
    expect(twinOut.seen).toEqual(liveOut.seen)
    expect(twinOut.seen).toEqual([`3:${a}`])
  })

  it('rejects a malformed `changes` field before touching the world', () => {
    const w = createWorld({ headless: true })
    w.spawn([entry(Hp, { hp: 3 })])
    const good = w.snapshot()
    for (const changes of [
      [],
      { marks: {}, seen: {} },
      { marks: [['bogus', 'X', 1]], seen: {} },
      { marks: [['changed', 'X']], seen: {} },
      { marks: [['resource', 'R']], seen: { s: 2 } },
    ]) {
      expect(() => w.restore({ ...good, changes } as unknown as WorldSnapshot)).toThrow(
        /invalid snapshot changes/,
      )
      expect(w.listEntities([Hp])).toHaveLength(1)
    }
  })
})

describe('O-42: removal marks are pruned once seen', () => {
  it('does not report a removal twice and keeps no stale marks', () => {
    const w = createWorld({ headless: true })
    let seen = 0
    w.system('gone', { schedule: 'reactive', reactsTo: OnRemoved(Hp) }, ({ entities }) => {
      seen += entities.length
    })
    for (let i = 0; i < 100; i++) {
      const id = w.spawn([entry(Hp, { hp: 1 })])
      w.despawn(id)
      w.stepOnce()
    }
    expect(seen).toBe(100)
    expect(w.snapshot().changes).toBeUndefined()
    // A late OnRemoved reader starts at the end of the last tick.
    const q = w.query(OnRemoved(Hp))
    expect(q.size).toBe(0)
  })
})

// --- review follow-ups ---

interface Raf {
  advance(n: number): void
  restore(): void
}

function installRaf(): Raf {
  let clock = 0
  let queue: Array<(t: number) => void> = []
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: (t: number) => void) => number
    cancelAnimationFrame?: (h: number) => void
  }
  const prevRaf = g.requestAnimationFrame
  const prevCaf = g.cancelAnimationFrame
  g.requestAnimationFrame = (cb) => queue.push(cb)
  g.cancelAnimationFrame = () => {}
  return {
    advance(n) {
      for (let i = 0; i < n; i++) {
        clock += 16
        const due = queue
        queue = []
        for (const cb of due) cb(clock)
      }
    },
    restore() {
      if (prevRaf) g.requestAnimationFrame = prevRaf
      else delete g.requestAnimationFrame
      if (prevCaf) g.cancelAnimationFrame = prevCaf
      else delete g.cancelAnimationFrame
    },
  }
}

const Tag = defineComponent<{ t: number }>('CwTag', { defaults: { t: 0 } })
const Fx = defineComponent<{ el: number }>('CwFx', { defaults: { el: 0 }, transient: true })

function twinMatches(build: (w: World) => void, setup: (w: World) => void, steps = 3): void {
  const live = createWorld({ headless: true, seed: [5, 6, 7, 8] })
  build(live)
  setup(live)
  const snap = live.snapshot()
  const twin = createWorld({ headless: true, seed: [5, 6, 7, 8] })
  build(twin)
  twin.restore(JSON.parse(JSON.stringify(snap)) as WorldSnapshot)
  expect(JSON.stringify(twin.snapshot())).toBe(JSON.stringify(snap))
  for (let i = 0; i < steps; i++) {
    live.stepOnce()
    twin.stepOnce()
    expect(JSON.stringify(twin.snapshot())).toBe(JSON.stringify(live.snapshot()))
  }
}

describe('O-42 review follow-ups', () => {
  it('restoring a snapshot with marks repaints without ticking an idle loop', () => {
    const raf = installRaf()
    try {
      const w = createWorld()
      w.system('lag', { schedule: 'event', triggers: [Hit], query: OnChanged(Hp) }, () => {})
      const id = w.spawn([entry(Hp, { hp: 1 })])
      w.startLoop()
      raf.advance(4)
      w.markChanged(id, Hp)
      raf.advance(6)
      const snap = w.snapshot()
      expect(snap.changes).toBeDefined()
      w.restore(snap)
      raf.advance(6)
      expect(w.time.tick).toBe(snap.tick)
      w.stop()
    } finally {
      raf.restore()
    }
  })

  it('a deferred reactive re-trigger runs under an idle loop', () => {
    const raf = installRaf()
    try {
      const w = createWorld()
      const id = w.spawn([entry(Hp, { hp: 1 }), entry(Glyph, { ch: 'a' })])
      const log: string[] = []
      w.system('early', { schedule: 'reactive', reactsTo: OnChanged(Glyph) }, () => {
        log.push(`early@${w.time.tick}`)
      })
      w.system('late', { schedule: 'reactive', priority: 10, reactsTo: OnChanged(Hp) }, () => {
        log.push(`late@${w.time.tick}`)
        w.markChanged(id, Glyph)
      })
      w.startLoop()
      raf.advance(4)
      w.markChanged(id, Hp)
      raf.advance(6)
      expect(log.map((x) => x.split('@')[0])).toEqual(['late', 'early'])
      w.stop()
    } finally {
      raf.restore()
    }
  })

  it('marks no reader acts on do not keep an idle loop awake', () => {
    const raf = installRaf()
    try {
      const w = createWorld()
      const id = w.spawn([entry(Glyph, { ch: 'a' })])
      w.use(
        definePlugin({
          name: 'cw:end-marker',
          install: () => ({ onTickEnd: () => w.markChanged(id, Glyph) }),
        }),
      )
      w.startLoop()
      raf.advance(20)
      expect(w.time.tick).toBeLessThan(4)
      w.stop()
    } finally {
      raf.restore()
    }
  })

  it('systems sharing a name keep their own cursors', () => {
    const seen: string[] = []
    const build = (w: World): void => {
      w.system('dup', { schedule: 'tick', query: OnChanged(Hp) }, ({ entities }) => {
        for (const e of entities) seen.push(`tick:${e.id}`)
      })
      w.system('dup', { schedule: 'event', triggers: [Hit], query: OnChanged(Hp) }, () => {})
    }
    twinMatches(build, (w) => {
      const id = w.spawn([entry(Hp, { hp: 1 })])
      w.stepOnce()
      w.markChanged(id, Hp)
      w.stepOnce()
    })
  })

  it('a non-system OnRemoved query does not change what the snapshot carries', () => {
    let q: ReturnType<World['query']> | undefined
    twinMatches(
      (w) => {
        w.system('lag', { schedule: 'event', triggers: [Hit], query: OnChanged(Hp) }, () => {})
        q = w.query(OnRemoved(Tag))
      },
      (w) => {
        const id = w.spawn([entry(Tag, { t: 1 }), entry(Hp, { hp: 1 })])
        w.stepOnce()
        w.markChanged(id, Hp)
        w.despawn(id)
      },
    )
    expect(q).toBeDefined()
  })

  it('marks on transient components and missing entities round-trip', () => {
    twinMatches(
      (w) => {
        w.system('lag', { schedule: 'event', triggers: [Hit], query: OnChanged(Hp) }, () => {})
      },
      (w) => {
        w.stepOnce()
        w.spawn([entry(Hp, { hp: 1 }), entry(Fx, { el: 1 })])
      },
    )
  })

  it('a once system that has run does not hold marks', () => {
    const w = createWorld({ headless: true })
    w.system('boot', { schedule: 'once', query: OnRemoved(Hp) }, () => {})
    w.system('boot2', { schedule: 'once', query: OnChanged(Hp) }, () => {})
    w.stepOnce()
    for (let i = 0; i < 50; i++) {
      const id = w.spawn([entry(Hp, { hp: 1 })])
      w.markChanged(id, Hp)
      w.despawn(id)
      w.stepOnce()
    }
    expect(w.snapshot().changes).toBeUndefined()
  })

  it('reads stay proportional to the window while pruning is held back', () => {
    const w = createWorld({ headless: true })
    w.system('off', { schedule: 'tick', query: OnRemoved(Hp), enabled: () => false }, () => {})
    const q = w.query(OnRemoved(Hp))
    const t0 = performance.now()
    for (let i = 0; i < 5000; i++) {
      w.despawn(w.spawn([entry(Hp, { hp: 1 })]))
      w.stepOnce()
      expect(q.size).toBe(1)
    }
    expect(performance.now() - t0).toBeLessThan(3000)
  })

  it('markChanged on a component the entity lacks records nothing', () => {
    const w = createWorld({ headless: true })
    w.system('lag', { schedule: 'event', triggers: [Hit], query: OnChanged(Hp) }, () => {})
    const id = w.spawn([entry(Glyph, { ch: 'a' })])
    w.stepOnce()
    w.markChanged(id, Hp)
    const marks = w.snapshot().changes?.marks ?? []
    expect(marks.some((m) => m[0] === 'changed')).toBe(false)
  })
})

describe('change windows when a frame throws (O-53)', () => {
  it('a query read before a render throw does not report the same marks again', () => {
    const w = createWorld({ headless: true })
    const q = w.query(OnChanged(Hp))
    w.use(
      definePlugin({
        name: 'cw:throwing-renderer',
        install: () => ({
          onRender: () => {
            if (q.entities.length > 0) throw new Error('render boom')
          },
        }),
      }),
    )
    const id = w.spawn([entry(Hp, { hp: 1 })])
    w.stepOnce()
    w.markChanged(id, Hp)
    expect(() => w.stepOnce()).toThrow('render boom')
    // The renderer read the mark before throwing: the next frame is clean.
    expect(() => w.stepOnce()).not.toThrow()
  })
})

describe('change reads visit only the marks in the window (O-54)', () => {
  it('reports each changed holder once, in id order, across log compaction', () => {
    const w = createWorld({ headless: true })
    const ids: Entity[] = []
    for (let i = 0; i < 50; i++) ids.push(w.spawn([entry(Hp, { hp: i })]))
    const q = w.query(OnChanged(Hp))
    w.stepOnce()
    expect(q.entities).toEqual([])
    // Many re-marks of a few entities force the per-type log to compact.
    for (let round = 0; round < 100; round++) {
      for (const id of [ids[40]!, ids[3]!, ids[17]!]) w.markChanged(id, Hp)
    }
    expect(q.entities.map((e) => e.id)).toEqual([ids[3], ids[17], ids[40]])
    w.stepOnce()
    expect(q.entities).toEqual([])
  })

  it('drops an entity that lost the component or was despawned after its mark', () => {
    const w = createWorld({ headless: true })
    const a = w.spawn([entry(Hp, { hp: 1 })])
    const b = w.spawn([entry(Hp, { hp: 1 })])
    const c = w.spawn([entry(Hp, { hp: 1 })])
    const q = w.query(And(Has(Glyph), OnChanged(Hp)))
    const all = w.query(OnChanged(Hp))
    w.stepOnce()
    w.addComponent(c, Glyph, { ch: 'c' })
    for (const id of [a, b, c]) w.markChanged(id, Hp)
    w.removeComponent(a, Hp)
    w.despawn(b)
    expect(all.entities.map((e) => e.id)).toEqual([c])
    expect(q.entities.map((e) => e.id)).toEqual([c])
  })

  it('a restored mark for a component the entity lacks is not reported', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Hp, { hp: 1 })])
    const q = w.query(OnChanged(Hp))
    w.system('reader', { schedule: 'tick', query: OnChanged(Hp) }, () => {})
    w.stepOnce()
    w.markChanged(id, Hp)
    const snap = w.snapshot()
    const bag = snap.entities.find((e) => e.id === id)!
    const stripped = {
      ...snap,
      entities: snap.entities.map((e) => (e === bag ? { ...e, components: {} } : e)),
    }
    w.restore(stripped)
    expect(q.entities).toEqual([])
  })
})

describe('mark-log reads keep structural membership (O-54 review)', () => {
  const A = defineComponent<{ v: number }>('CwStA', { defaults: { v: 0 } })
  const T = defineComponent<{ v: number }>('CwStT', { defaults: { v: 0 }, transient: true })

  it('a restored mark for a stripped transient component does not match', () => {
    const w = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    const seen: Array<{ id: Entity; hasT: boolean }> = []
    w.system('s', { schedule: 'tick', query: And(OnChanged(A), OnChanged(T)) }, (ctx) => {
      for (const e of ctx.entities) seen.push({ id: e.id, hasT: 'CwStT' in e })
    })
    const e = w.spawn([entry(A, { v: 1 }), entry(T, { v: 1 })])
    w.step(1 / 60)
    w.markChanged(e, A)
    w.markChanged(e, T)
    w.restore(w.snapshot()) // T is transient: stripped, but its mark is carried
    // Enough members that the mark-log path is taken.
    for (let i = 0; i < 8; i++) w.spawn([entry(A, { v: 1 }), entry(T, { v: 1 })])
    seen.length = 0
    w.step(1 / 60)
    expect(seen.every((s) => s.hasT)).toBe(true)
    expect(seen.map((s) => s.id)).not.toContain(e)
  })
})
