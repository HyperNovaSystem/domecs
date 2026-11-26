import { describe, expect, it } from 'vitest'
import { canonicalJson, createWorld, defineComponent, entry, hashSnapshot, type World, type WorldSnapshot } from '@domecs/core'
import {
  columnarCodec,
  createMemoryStorage,
  decodeSave,
  encodeSave,
  jsonCodec,
  load,
  peek,
  prepareSave,
  save,
  type SnapshotCodec,
} from '../src/index.js'

// H-11 (Harbor findings): save()/load() fixed the wire format to
// JSON.stringify(snapshot) — 3.07 MB for a 21,000-entity port — so an app
// with a better encoding had to re-implement the envelope, migrations and
// error mapping. H-12: saves carried no application version, and the only way
// to learn anything about a slot was to parse all of it. P-2: most of a large
// world is entities with one component of flat fields, which pack as tables.

const Box = defineComponent<{ x: number; owner: number; kind: string }>('SfBox', { defaults: { x: 0, owner: -1, kind: 'dry' } })
const Port = defineComponent<{ name: string; cash: number; log: string[] }>('SfPort', { defaults: { name: '', cash: 0, log: [] } })

function port(boxes = 50): World {
  const w = createWorld({ headless: true, seed: [5, 4, 3, 2] })
  w.spawn([entry(Port, { name: 'Ada', cash: 182_400, log: ['opened'] })])
  for (let i = 0; i < boxes; i++) w.spawn([entry(Box, { x: i * 1.5, owner: i % 7, kind: i % 3 === 0 ? 'reefer' : 'dry' })])
  w.stepOnce()
  return w
}
const strict = (w: World): string => hashSnapshot(w.snapshot(), { includeChanges: true })

describe('save reports what it wrote (O-29, H-11)', () => {
  it('returns the codec and the length of the stored text', () => {
    const storage = createMemoryStorage()
    const r = save(port(), storage, 'slot', { savedAt: 1 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const text = (storage.read('slot') as { value: string }).value
    expect(r.value.codec).toBe('json')
    expect(r.value.length).toBe(text.length)
  })
})

describe('the slot header (H-12)', () => {
  it('peek reads codec, versions, savedAt and meta without decoding the body', () => {
    const storage = createMemoryStorage()
    save(port(), storage, 'slot', { savedAt: 1234, appVersion: 3, meta: { day: 3, clock: '14:20' } })
    const h = peek(storage, 'slot')
    expect(h.ok && h.value).toEqual({
      codec: 'json',
      snapshotVersion: 4,
      savedAt: 1234,
      appVersion: 3,
      meta: { day: 3, clock: '14:20' },
      length: (storage.read('slot') as { value: string }).value.length,
    })
    // The body is never parsed: a corrupt body still peeks.
    const text = (storage.read('slot') as { value: string }).value
    storage.write('broken', text.slice(0, text.length - 20))
    expect(peek(storage, 'broken').ok).toBe(true)
    expect(peek(storage, 'empty')).toEqual({ ok: true, value: null })
  })

  it('a save from before the header loads and peeks (by parsing it)', () => {
    const w = port(3)
    const legacy = { ...w.snapshot(), meta: { savedAt: 77, appVersion: 1 } }
    const storage = createMemoryStorage({ old: JSON.stringify(legacy) })
    const h = peek(storage, 'old')
    expect(h.ok && h.value).toMatchObject({ codec: 'json', snapshotVersion: 4, savedAt: 77, appVersion: 1 })
    const fresh = createWorld({ headless: true })
    expect(load(fresh, storage, 'old').ok).toBe(true)
    expect(fresh.countEntities([Box])).toBe(3)
  })

  it('accept refuses a save by its header, before the body is decoded or the world touched', () => {
    const storage = createMemoryStorage()
    save(port(), storage, 'slot', { appVersion: 1 })
    const w = port(2)
    const before = strict(w)
    const r = load(w, storage, 'slot', {
      accept: (h) => (h.appVersion === 2 ? true : `this port was saved by format ${String(h.appVersion)}; this build reads format 2`),
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('persist_io')
    expect(JSON.stringify(r.error)).toContain('this port was saved by format 1')
    expect(strict(w)).toBe(before)
    expect(load(w, storage, 'slot', { accept: () => true }).ok).toBe(true)
    expect(load(w, storage, 'slot', { accept: () => false }).ok).toBe(false)
  })
})

describe('codecs (H-11)', () => {
  it('the json codec is canonical and lossless: -0 survives, which JSON.stringify lost', () => {
    const w = createWorld({ headless: true })
    const id = w.spawn([entry(Box, { x: -0, owner: 0, kind: 'dry' })])
    const storage = createMemoryStorage()
    save(w, storage, 'slot')
    const fresh = createWorld({ headless: true })
    load(fresh, storage, 'slot')
    expect(Object.is(fresh.getComponent(id, Box)!.x, -0)).toBe(true)
    expect(jsonCodec.name).toBe('json')
  })

  it('refuses to write a value JSON cannot carry, instead of writing null', () => {
    const w = createWorld({ headless: true })
    w.spawn([entry(Box, { x: Number.NaN, owner: 0, kind: 'dry' })])
    const storage = createMemoryStorage()
    const r = save(w, storage, 'slot')
    expect(r.ok).toBe(false)
    expect(storage.read('slot')).toEqual({ ok: true, value: null })
  })

  it('a custom codec is written by name and found by name on load', () => {
    const reversed: SnapshotCodec = {
      name: 'reversed',
      encode: (snap) => [...canonicalJson(snap)].reverse().join(''),
      decode: (text) => JSON.parse([...text].reverse().join('')),
    }
    const w = port(5)
    const storage = createMemoryStorage()
    expect(save(w, storage, 'slot', { codec: reversed }).ok).toBe(true)
    expect(peek(storage, 'slot').ok && (peek(storage, 'slot') as { value: { codec: string } }).value.codec).toBe('reversed')
    const fresh = createWorld({ headless: true })
    const missing = load(fresh, storage, 'slot')
    expect(missing.ok).toBe(false)
    expect(!missing.ok && missing.error.kind === 'persist_io' && missing.error.cause.message).toContain('unknown codec "reversed"')
    expect(load(fresh, storage, 'slot', { codecs: [reversed] }).ok).toBe(true)
    expect(strict(fresh)).toBe(strict(w))
  })

  it('encodeSave and decodeSave are the pure halves, for a host that stores the text itself', () => {
    const w = port(4)
    const snap = prepareSave(w, { savedAt: 9, appVersion: 'b' })
    expect(snap.meta).toMatchObject({ savedAt: 9, appVersion: 'b' })
    const encoded = encodeSave(snap)
    expect(encoded.ok).toBe(true)
    if (!encoded.ok) return
    const decoded = decodeSave(encoded.value.text)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(canonicalJson(decoded.value.snapshot)).toBe(canonicalJson(snap))
    expect(decoded.value.header).toEqual(encoded.value.header)
  })
})

describe('the columnar codec (P-2)', () => {
  it('packs one-component entities as tables: lossless, and much smaller', () => {
    const w = port(2000)
    const snap = prepareSave(w, { savedAt: 1 })
    const json = encodeSave(snap)
    const columnar = encodeSave(snap, { codec: columnarCodec })
    if (!json.ok || !columnar.ok) throw new Error('encode failed')
    expect(columnar.value.text.length).toBeLessThan(json.value.text.length * 0.6)
    const back = decodeSave(columnar.value.text)
    if (!back.ok) throw new Error('decode failed')
    expect(canonicalJson(back.value.snapshot)).toBe(canonicalJson(snap))
  })

  it('round-trips through save and load to an equal world, and keeps what does not fit a table', () => {
    const w = port(30)
    const mixed = w.spawn([entry(Box, { x: 1, owner: 2, kind: 'dry' }), entry(Port, { name: 'B', cash: 1, log: [] })])
    w.spawn([entry(Box, { x: -0, owner: 0, kind: 'odd' })])
    const storage = createMemoryStorage()
    expect(save(w, storage, 'slot', { codec: columnarCodec }).ok).toBe(true)
    const fresh = createWorld({ headless: true })
    expect(load(fresh, storage, 'slot').ok).toBe(true) // built in: found by name
    expect(strict(fresh)).toBe(strict(w))
    expect(fresh.getComponent(mixed, Port)!.name).toBe('B')
  })

  it('decodes only what it encoded', () => {
    expect(() => columnarCodec.decode('{"snapshot":1}')).toThrow()
    const r = decodeSave('domecs-save 1\n{"codec":"columnar","snapshotVersion":4,"savedAt":0}\n[]')
    expect(r.ok).toBe(false)
  })
})

describe('the envelope is a snapshot (unchanged contract)', () => {
  it('load still migrates and validates what it decoded', () => {
    const v1: WorldSnapshot = { version: 1, seed: [1, 2, 3, 4], tick: 3, entities: [{ id: 0 as never, components: { SfBox: { x: 1, owner: 0, kind: 'dry' } } }] }
    const storage = createMemoryStorage({ legacy: JSON.stringify(v1) })
    const w = createWorld({ headless: true })
    expect(load(w, storage, 'legacy').ok).toBe(true)
    expect(w.time.tick).toBe(3)
  })
})

describe('json saves stay plain JSON (H-12, without breaking hosts that parse their slots)', () => {
  it('a json slot is a snapshot any JSON reader can open, meta and version first', () => {
    const storage = createMemoryStorage()
    save(port(2), storage, 'slot', { savedAt: 5, meta: { label: 'Before first signal' } })
    const text = (storage.read('slot') as { value: string }).value
    expect(text.startsWith('{"meta":{')).toBe(true)
    const parsed = JSON.parse(text) as WorldSnapshot
    expect(parsed.meta).toEqual({ savedAt: 5, label: 'Before first signal' })
    expect(parsed.version).toBe(4)
    expect(Object.keys(parsed).slice(0, 2)).toEqual(['meta', 'version'])
  })

  it('peek reads only the prefix, whatever the meta strings hold', () => {
    const storage = createMemoryStorage()
    const meta = { note: 'a "quoted" {brace} [bracket] \\\\ back\\\\slash', nested: { deep: ['}', '{'] } }
    save(port(2), storage, 'slot', { savedAt: 7, meta })
    const text = (storage.read('slot') as { value: string }).value
    const cut = text.indexOf('"version":') + 12
    storage.write('cut', text.slice(0, cut)) // nothing after the version
    for (const slot of ['slot', 'cut']) {
      const h = peek(storage, slot)
      expect(h.ok && h.value).toMatchObject({ codec: 'json', snapshotVersion: 4, savedAt: 7, meta })
    }
  })

  it('other codecs keep the header line', () => {
    const storage = createMemoryStorage()
    save(port(2), storage, 'slot', { codec: columnarCodec })
    expect((storage.read('slot') as { value: string }).value.startsWith('domecs-save 1\n')).toBe(true)
  })
})
