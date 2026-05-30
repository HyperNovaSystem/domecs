import { describe, expect, it } from 'vitest'
import { definePlugin } from '../src/plugin.js'
import { err, ok } from '../src/result.js'
import { createWorld } from '../src/world.js'

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`expected ok(); got err(${JSON.stringify(r.error)})`)
  return r.value
}

describe('definePlugin — authoring helper (review #6)', () => {
  it('accepts an install that returns void (auto-wrapped as ok)', () => {
    const w = createWorld()
    let installed = false
    const p = definePlugin({
      name: 'voidy',
      install: () => {
        installed = true
      },
    })
    const r = w.use(p)
    expect(r.ok).toBe(true)
    expect(installed).toBe(true)
  })

  it('accepts an install that returns a bare PluginHandle (auto-wrapped)', () => {
    const w = createWorld()
    let ticks = 0
    const p = definePlugin({
      name: 'bare-handle',
      install: () => ({ onTickStart: () => ticks++ }),
    })
    const off = unwrap(w.use(p))
    w.step(0.016)
    expect(ticks).toBe(1)
    off()
    w.step(0.016)
    expect(ticks).toBe(1)
  })

  it('accepts an install that already returns a Result (passed through)', () => {
    const w = createWorld()
    let torn = false
    const p = definePlugin({
      name: 'result-form',
      install: () => ok({ teardown: () => { torn = true } }),
    })
    const off = unwrap(w.use(p))
    off()
    expect(torn).toBe(true)
  })

  it('propagates a returned err() through the registry quarantine', () => {
    const w = createWorld()
    const p = definePlugin({
      name: 'fails',
      provides: ['cap'],
      install: () =>
        err({ kind: 'plugin_install_failed', plugin: 'fails', cause: { message: 'nope' } }),
    })
    const r = w.use(p)
    expect(r.ok).toBe(false)
    // capability was unwound — another plugin can claim it.
    const r2 = w.use(definePlugin({ name: 'other', provides: ['cap'], install: () => {} }))
    expect(r2.ok).toBe(true)
  })

  it('passes name/version/depends/provides through to the Plugin', () => {
    const w = createWorld()
    w.use(definePlugin({ name: 'dep', install: () => {} }))
    const p = definePlugin({
      name: 'consumer',
      version: '1.2.3',
      depends: ['dep'],
      install: () => {},
    })
    expect(p.name).toBe('consumer')
    expect(p.version).toBe('1.2.3')
    expect(p.depends).toEqual(['dep'])
    expect(w.use(p).ok).toBe(true)
    // depends enforced: missing dependency throws.
    expect(() =>
      w.use(definePlugin({ name: 'orphan', depends: ['missing'], install: () => {} })),
    ).toThrowError(/requires "missing"/)
  })

  it('options are typed and forwarded to install', () => {
    const w = createWorld()
    let seen = 0
    const p = definePlugin<{ n: number }>({
      name: 'opts',
      install: (_world, options) => {
        seen = options.n
      },
    })
    w.use(p, { n: 99 })
    expect(seen).toBe(99)
  })
})
