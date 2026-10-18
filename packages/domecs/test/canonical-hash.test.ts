import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  canonicalSnapshot,
  HASH_ALGORITHM,
  hashEntities,
  hashSnapshot,
  hashValue,
} from '../src/canonical.js'
import * as core from '../src/index.js'
import { defineComponent } from '../src/component.js'
import { definePlugin } from '../src/plugin.js'
import { OnChanged } from '../src/query.js'
import type { WorldSnapshot } from '../src/snapshot.js'
import { entry, type Entity } from '../src/types.js'
import { createWorld, type World } from '../src/world.js'

// O-11 / spec §4.1: canonical JSON is JSON.stringify value semantics with
// object keys sorted by UTF-16 code unit, a lossless `-0`, and TypeErrors
// that name the offending path.

describe('canonicalJson', () => {
  it('sorts object keys by UTF-16 code unit at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
    // Code-unit order, not locale or numeric order: "10" < "2", "Z" < "a",
    // and an astral character (surrogate pair, 0xD83D…) sorts before U+FF5E.
    expect(canonicalJson({ 2: 'x', 10: 'y', a: 0, Z: 0 })).toBe('{"10":"y","2":"x","Z":0,"a":0}')
    expect(canonicalJson({ '～': 1, '\u{1F600}': 2 })).toBe('{"\u{1F600}":2,"～":1}')
  })

  it('matches JSON.stringify value semantics for undefined, functions and symbols', () => {
    const value = { a: undefined, f: () => 1, s: Symbol('s'), arr: [undefined, () => 1, Symbol('t'), 1] }
    expect(canonicalJson(value)).toBe('{"arr":[null,null,null,1]}')
    expect(canonicalJson([])).toBe('[]')
    expect(canonicalJson({})).toBe('{}')
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(true)).toBe('true')
    expect(canonicalJson('he said "hi"\n')).toBe(JSON.stringify('he said "hi"\n'))
    // Well-formed escaping of a lone surrogate.
    expect(canonicalJson('\ud800')).toBe('"\\ud800"')
  })

  it('writes numbers with Number::toString, except -0 which stays -0', () => {
    for (const n of [0, 1, -1, 0.1, 1e21, 1e-7, 123456789.125, Number.MAX_SAFE_INTEGER, 5e-324]) {
      expect(canonicalJson(n)).toBe(JSON.stringify(n))
    }
    expect(canonicalJson(-0)).toBe('-0')
    expect(canonicalJson({ a: -0 })).toBe('{"a":-0}')
    expect(canonicalJson([0, -0])).toBe('[0,-0]')
  })

  it('round-trips losslessly through JSON.parse, -0 included', () => {
    const values: unknown[] = [
      { a: -0, b: [1, -0, [0, -0, { c: -0 }]], d: undefined, e: 'x' },
      [[-0], { z: [{ y: -0, x: null }] }],
      -0,
    ]
    for (const x of values) {
      const once = canonicalJson(x)
      expect(canonicalJson(JSON.parse(once))).toBe(once)
    }
    expect(Object.is((JSON.parse(canonicalJson({ a: -0 })) as { a: number }).a, -0)).toBe(true)
    // JSON.stringify is not lossless: it drops the sign.
    expect(canonicalJson(JSON.parse(JSON.stringify({ a: -0 })))).not.toBe(canonicalJson({ a: -0 }))
  })

  it('throws a TypeError naming the path of a non-finite number', () => {
    expect(() => canonicalJson({ a: { b: [0, 1, NaN] } })).toThrow(TypeError)
    expect(() => canonicalJson({ a: { b: [0, 1, NaN] } })).toThrow('"a.b[2]"')
    expect(() => canonicalJson({ a: Infinity })).toThrow('"a"')
    expect(() => canonicalJson([{ x: -Infinity }])).toThrow('"[0].x"')
    expect(() => canonicalJson({ 'not ident': [NaN] })).toThrow('["not ident"][0]')
    expect(() => canonicalJson(NaN)).toThrow(TypeError)
  })

  it('throws a TypeError for BigInt and for cycles, but accepts shared references', () => {
    expect(() => canonicalJson({ n: 1n })).toThrow(TypeError)
    expect(() => canonicalJson({ n: 1n })).toThrow('"n"')
    const cyc: Record<string, unknown> = { a: 1 }
    cyc.self = cyc
    expect(() => canonicalJson(cyc)).toThrow(TypeError)
    const arr: unknown[] = []
    arr.push({ back: arr })
    expect(() => canonicalJson(arr)).toThrow(TypeError)
    const shared = { k: 1 }
    expect(canonicalJson({ a: shared, b: [shared] })).toBe('{"a":{"k":1},"b":[{"k":1}]}')
  })

  it('throws a TypeError for a top-level value with no JSON text', () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError)
    expect(() => canonicalJson(() => 1)).toThrow(TypeError)
  })
})

// Fixtures for the snapshot hash tests.
const Pos = defineComponent<{ x: number; y: number }>('ChPos', { defaults: { x: 0, y: 0 } })
const Vel = defineComponent<{ vx: number; vy: number }>('ChVel', { defaults: { vx: 0, vy: 0 } })
const Body = defineComponent<{ x: number; vx: number; side: number }>('ChBody', {
  defaults: { x: 0, vx: 0, side: 0 },
})

describe('FNV-1a-64 (hashValue)', () => {
  it('names its algorithm and is exported from the package barrel', () => {
    expect(HASH_ALGORITHM).toBe('fnv1a64')
    expect(core.HASH_ALGORITHM).toBe('fnv1a64')
    expect(core.hashSnapshot).toBe(hashSnapshot)
    expect(core.canonicalSnapshot).toBe(canonicalSnapshot)
    expect(core.canonicalJson).toBe(canonicalJson)
    expect(core.hashEntities).toBe(hashEntities)
    expect(core.hashValue).toBe(hashValue)
  })

  it('hashes the UTF-8 bytes of canonicalJson with the published FNV-1a-64 vectors', () => {
    // canonicalJson('a') is '"a"', so pin the raw algorithm through strings
    // whose canonical text is known: the vectors below are FNV-1a-64 of the
    // canonical text itself.
    expect(hashValue('')).toBe(fnvRef('""'))
    expect(hashValue('foobar')).toBe(fnvRef('"foobar"'))
    // Published reference vectors (draft-eastlake-fnv): fnvRef is checked
    // against them so the oracle itself is pinned.
    expect(fnvRef('')).toBe('cbf29ce484222325')
    expect(fnvRef('a')).toBe('af63dc4c8601ec8c')
    expect(fnvRef('foobar')).toBe('85944171f73967e8')
    // Multi-byte UTF-8 (2-, 3- and 4-byte sequences).
    expect(hashValue({ k: 'é€\u{1F600}' })).toBe(fnvRef('{"k":"é€\u{1F600}"}'))
    expect(hashValue({ b: 1, a: 2 })).toBe(hashValue({ a: 2, b: 1 }))
    expect(hashValue({ a: -0 })).not.toBe(hashValue({ a: 0 }))
    expect(hashValue([1, 2])).toMatch(/^[0-9a-f]{16}$/)
  })
})

/** Reference FNV-1a-64 with BigInt over TextEncoder bytes (test oracle only). */
function fnvRef(text: string): string {
  let h = 0xcbf29ce484222325n
  for (const b of new TextEncoder().encode(text)) {
    h ^= BigInt(b)
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return h.toString(16).padStart(16, '0')
}

describe('hashSnapshot / canonicalSnapshot', () => {
  it('1: same state reached through different component-add orders hashes equal', () => {
    const a = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    const ea = a.spawn([entry(Pos, { x: 1, y: 2 })])
    a.addComponent(ea, Vel, { vx: 3, vy: 4 })
    const b = createWorld({ headless: true, seed: [1, 2, 3, 4] })
    const eb = b.spawn([entry(Vel, { vx: 3, vy: 4 })])
    b.addComponent(eb, Pos, { x: 1, y: 2 })
    expect(ea).toBe(eb)
    const sa = a.snapshot()
    const sb = b.snapshot()
    // O-11: JSON.stringify depends on incidental key order…
    expect(JSON.stringify(sa)).not.toBe(JSON.stringify(sb))
    // …the canonical form does not.
    expect(canonicalSnapshot(sa)).toBe(canonicalSnapshot(sb))
    expect(hashSnapshot(sa)).toBe(hashSnapshot(sb))
    expect(hashSnapshot(sa, { includeChanges: true })).toBe(hashSnapshot(sb, { includeChanges: true }))
    expect(hashSnapshot(sa)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('scope: version, meta and changes are excluded unless asked for', () => {
    const w = createWorld({ headless: true, seed: [9, 8, 7, 6] })
    w.spawn([entry(Pos, { x: 1, y: 1 })])
    const s = w.snapshot()
    const text = canonicalSnapshot(s)
    expect(JSON.parse(text)).not.toHaveProperty('version')
    for (const k of ['seed', 'tick', 'scaledTime', 'nextId', 'entities']) {
      expect(JSON.parse(text)).toHaveProperty(k)
    }
    expect(hashSnapshot({ ...s, version: 1 })).toBe(hashSnapshot(s))
    const withMeta: WorldSnapshot = { ...s, meta: { label: 'x' } }
    expect(hashSnapshot(withMeta)).toBe(hashSnapshot(s))
    expect(hashSnapshot(withMeta, { includeMeta: true })).not.toBe(hashSnapshot(s, { includeMeta: true }))
    const withChanges: WorldSnapshot = { ...s, changes: { marks: [['changed', 'ChPos', 1 as Entity]], seen: { sys: 0 } } }
    expect(hashSnapshot(withChanges)).toBe(hashSnapshot(s))
    expect(hashSnapshot(withChanges, { includeChanges: true })).not.toBe(hashSnapshot(s, { includeChanges: true }))
    // Every other top-level field is state (rngRoot, rngStreams and
    // pendingEvents arrive in later 2.1 items).
    expect(hashSnapshot({ ...s, tick: s.tick + 1 })).not.toBe(hashSnapshot(s))
    expect(hashSnapshot({ ...s, resources: { R: { n: 1 } } })).not.toBe(hashSnapshot(s))
    expect(hashSnapshot({ ...s, rngRoot: [1, 2, 3, 4] } as WorldSnapshot)).not.toBe(hashSnapshot(s))
    // The input is not mutated.
    expect(s.version).toBeTypeOf('number')
  })

  it('2: round trip through canonicalJson is lossless; JSON.stringify is not; non-finite throws', () => {
    const w = createWorld({ headless: true })
    w.spawn([entry(Body, { x: 1, vx: -0, side: 0 })])
    const s = w.snapshot()
    const back = JSON.parse(canonicalJson(s)) as WorldSnapshot
    expect(canonicalJson(back)).toBe(canonicalJson(s))
    expect(hashSnapshot(back, { includeChanges: true })).toBe(hashSnapshot(s, { includeChanges: true }))
    // Keyframes must not use JSON.stringify: it loses the sign of -0.
    expect(hashSnapshot(JSON.parse(JSON.stringify(s)) as WorldSnapshot)).not.toBe(hashSnapshot(s))

    const bad = createWorld({ headless: true })
    bad.spawn([entry(Pos, { x: 0, y: 0 })])
    const id = bad.spawn([entry(Body, { x: 0, vx: NaN, side: 0 })])
    expect(() => hashSnapshot(bad.snapshot())).toThrow(TypeError)
    expect(() => hashSnapshot(bad.snapshot())).toThrow('"entities[1].components.ChBody.vx"')
    bad.getComponent(id, Body)!.vx = Infinity
    expect(() => canonicalSnapshot(bad.snapshot())).toThrow(TypeError)
  })

  it('3a: live vs restored twin over 600 fixed steps — equal strict hashes every 60 ticks', () => {
    const live = buildBouncer()
    for (let i = 0; i < 90; i++) live.step(1 / 60)
    const twin = buildBouncer()
    twin.restore(live.snapshot())
    for (let i = 1; i <= 600; i++) {
      live.step(1 / 60)
      twin.step(1 / 60)
      if (i % 60 === 0) {
        expect(hashSnapshot(twin.snapshot(), { includeChanges: true })).toBe(
          hashSnapshot(live.snapshot(), { includeChanges: true }),
        )
      }
    }
  })

  it('3b: a -0-sensitive fork matches live only through canonicalJson', () => {
    // The sim reads `1 / vx` after a bounce leaves vx === -0: the sign of
    // the infinity decides which way `side` walks.
    const live = buildBouncer()
    for (let i = 0; i < 30; i++) live.step(1 / 60)
    const id = live.listEntities([Body])[0]!
    live.getComponent(id, Body)!.vx = 0
    live.markChanged(id, Body)
    live.step(1 / 60) // bounce: vx = -vx → -0
    expect(Object.is(live.getComponent(id, Body)!.vx, -0)).toBe(true)
    const snap = live.snapshot()

    const viaCanonical = buildBouncer()
    viaCanonical.restore(JSON.parse(canonicalJson(snap)) as WorldSnapshot)
    const viaStringify = buildBouncer()
    viaStringify.restore(JSON.parse(JSON.stringify(snap)) as WorldSnapshot)
    for (let i = 0; i < 60; i++) {
      live.step(1 / 60)
      viaCanonical.step(1 / 60)
      viaStringify.step(1 / 60)
    }
    const strict = (w: World): string => hashSnapshot(w.snapshot(), { includeChanges: true })
    expect(strict(viaCanonical)).toBe(strict(live))
    expect(strict(viaStringify)).not.toBe(strict(live))
  })

  it('4: a heartbeat after a render changes `changes` but not the default hash', () => {
    const w = createWorld({ headless: true })
    let target: Entity | undefined
    let markOnRender = false
    w.use(
      definePlugin({
        name: 'ch:render-marker',
        install: () => ({
          onRender: (world: World) => {
            if (markOnRender && target !== undefined) world.markChanged(target, Pos)
          },
        }),
      }),
    )
    w.system('watch', { schedule: 'tick', query: OnChanged(Pos) }, () => {})
    target = w.spawn([entry(Pos, { x: 1, y: 1 })])
    w.stepOnce()
    w.stepOnce()
    const before = w.snapshot()
    markOnRender = true
    w.step(0) // heartbeat: render only, no systems
    const after = w.snapshot()
    expect(after.tick).toBe(before.tick)
    expect(JSON.stringify(after.changes)).not.toBe(JSON.stringify(before.changes))
    expect(hashSnapshot(after)).toBe(hashSnapshot(before))
    expect(hashSnapshot(after, { includeChanges: true })).not.toBe(hashSnapshot(before, { includeChanges: true }))
  })

  it('5: golden — a fixed snapshot fixture hashes to a committed constant', () => {
    const fixture: WorldSnapshot = {
      version: 2,
      seed: [1, 2, 3, 4],
      tick: 42,
      scaledTime: 0.7,
      entities: [
        { id: 1 as Entity, components: { Pos: { y: -0, x: 1.5 }, Tag: {} } },
        { id: 3 as Entity, components: { Name: { text: 'héllo €' }, Inv: { items: [{ qty: 2 }, null] } } },
      ],
      nextId: 4,
      resources: { Score: { n: 10 } },
      changes: { marks: [['changed', 'Pos', 1 as Entity]], seen: { mover: 0 } },
      meta: { label: 'golden' },
    }
    expect(canonicalSnapshot(fixture)).toBe(
      '{"entities":[{"components":{"Pos":{"x":1.5,"y":-0},"Tag":{}},"id":1},' +
        '{"components":{"Inv":{"items":[{"qty":2},null]},"Name":{"text":"héllo €"}},"id":3}],' +
        '"nextId":4,"resources":{"Score":{"n":10}},"scaledTime":0.7,"seed":[1,2,3,4],"tick":42}',
    )
    expect(hashSnapshot(fixture)).toBe(GOLDEN_DEFAULT)
    expect(hashSnapshot(fixture, { includeChanges: true, includeMeta: true })).toBe(GOLDEN_STRICT_META)
    expect(hashSnapshot(fixture)).toBe(fnvRef(canonicalSnapshot(fixture)))
  })

  it('6: hashEntities localizes a one-field difference to one entity', () => {
    const make = (): World => {
      const w = createWorld({ headless: true })
      for (let i = 0; i < 5; i++) w.spawn([entry(Pos, { x: i, y: i })])
      return w
    }
    const a = make()
    const b = make()
    const ids = b.listEntities([Pos])
    b.getComponent(ids[3]!, Pos)!.y = 99
    const ha = hashEntities(a.snapshot())
    const hb = hashEntities(b.snapshot())
    expect([...ha.keys()]).toEqual([...ha.keys()].sort((x, y) => x - y))
    expect([...ha.keys()]).toEqual(ids)
    const differing = [...ha.keys()].filter((id) => ha.get(id) !== hb.get(id))
    expect(differing).toEqual([ids[3]])
    expect(ha.get(ids[0]!)).toBe(hashValue({ ChPos: { x: 0, y: 0 } }))
  })
})

// Pinned FNV-1a-64 values (checked against the BigInt oracle fnvRef). A
// change here is a change to the hash algorithm or the canonical form.
const GOLDEN_DEFAULT = '759d0e48e1c17ee9'
const GOLDEN_STRICT_META = '5d71191e750bf2cb'

/** A bouncing body whose future depends on the sign of a zero velocity. */
function buildBouncer(): World {
  const w = createWorld({ headless: true, seed: [5, 6, 7, 8], fixedStep: 1 / 60 })
  w.system('move', { schedule: 'fixed', query: [Body] }, ({ entities }) => {
    for (const e of entities) {
      const b = w.getComponent(e.id, Body)!
      b.x += b.vx
      if (b.x > 10 || b.x < -10) b.vx = -b.vx
      if (b.vx === 0) {
        b.vx = -b.vx
        b.side += 1 / b.vx > 0 ? 1 : -1
      }
      w.markChanged(e.id, Body)
    }
  })
  w.system('drift', { schedule: 'tick', query: OnChanged(Body) }, ({ entities }) => {
    for (const e of entities) w.getComponent(e.id, Pos) && w.markChanged(e.id, Pos)
  })
  w.spawn([entry(Body, { x: 0, vx: 0.75, side: 0 }), entry(Pos, { x: 0, y: 0 })])
  w.spawn([entry(Body, { x: 3, vx: -1.25, side: 0 })])
  return w
}
