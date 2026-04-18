import { describe, expect, it } from 'vitest'
import type { Plugin } from '../src/plugin.js'
import { createWorld } from '../src/world.js'

describe('plugins — install/teardown (SPEC §9.1)', () => {
  it('install receives the world and options', () => {
    const w = createWorld()
    let gotWorld: unknown
    let gotOpts: unknown
    const p: Plugin = {
      name: 't',
      install(world, options) {
        gotWorld = world
        gotOpts = options
      },
    }
    w.use(p, { foo: 1 })
    expect(gotWorld).toBe(w)
    expect(gotOpts).toEqual({ foo: 1 })
  })

  it('re-installing the same plugin name throws', () => {
    const w = createWorld()
    const p: Plugin = { name: 'same', install: () => {} }
    w.use(p)
    expect(() => w.use(p)).toThrowError(/already installed/)
  })

  it('teardown fires when the returned disposer is called', () => {
    const w = createWorld()
    let torn = false
    const off = w.use({
      name: 't',
      install: () => ({ teardown: () => { torn = true } }),
    })
    expect(torn).toBe(false)
    off()
    expect(torn).toBe(true)
  })

  it('disposer is idempotent', () => {
    const w = createWorld()
    let count = 0
    const off = w.use({
      name: 't',
      install: () => ({ teardown: () => { count++ } }),
    })
    off()
    off()
    expect(count).toBe(1)
  })
})

describe('plugins — lifecycle hooks (SPEC §9.4)', () => {
  it('onTickStart fires before tick systems; onTickEnd fires after render', () => {
    const w = createWorld()
    const order: string[] = []
    w.use({
      name: 'lx',
      install: () => ({
        onTickStart: () => order.push('start'),
        onRender: () => order.push('render'),
        onTickEnd: () => order.push('end'),
      }),
    })
    w.system('sys', {}, () => order.push('tick'))
    w.step(0.016)
    expect(order).toEqual(['start', 'tick', 'render', 'end'])
  })

  it('hooks run in plugin registration order', () => {
    const w = createWorld()
    const order: string[] = []
    const mk = (name: string): Plugin => ({
      name,
      install: () => ({
        onTickStart: () => order.push(`${name}:start`),
        onTickEnd: () => order.push(`${name}:end`),
      }),
    })
    w.use(mk('a'))
    w.use(mk('b'))
    w.step(0.016)
    expect(order).toEqual(['a:start', 'b:start', 'a:end', 'b:end'])
  })

  it('tearing down removes the plugin from lifecycle', () => {
    const w = createWorld()
    let ticks = 0
    const off = w.use({
      name: 't',
      install: () => ({ onTickStart: () => ticks++ }),
    })
    w.step(0.016)
    expect(ticks).toBe(1)
    off()
    w.step(0.016)
    expect(ticks).toBe(1)
  })
})

describe('plugins — depends (SPEC §9.2)', () => {
  it('installs fine when dependency is registered first', () => {
    const w = createWorld()
    const installed: string[] = []
    w.use({ name: 'a', install: () => { installed.push('a') } })
    w.use({ name: 'b', depends: ['a'], install: () => { installed.push('b') } })
    expect(installed).toEqual(['a', 'b'])
  })

  it('throws when a dependency is missing', () => {
    const w = createWorld()
    expect(() =>
      w.use({ name: 'b', depends: ['a'], install: () => {} }),
    ).toThrowError(/requires "a"/)
  })
})

describe('plugins — capability registry (SPEC §9.3)', () => {
  it('provider publishes a capability; consumer reads it', () => {
    const w = createWorld()
    w.use({
      name: 'spatial',
      provides: ['spatial-index'],
      install: (world) => {
        const cap = world.capability('spatial-index') as unknown as {
          query(b: { x: number }): number
        }
        cap.query = (b) => b.x * 2
      },
    })
    const cap = w.capability('spatial-index') as unknown as { query(b: { x: number }): number }
    expect(cap.query({ x: 21 })).toBe(42)
  })

  it('two plugins cannot provide the same capability', () => {
    const w = createWorld()
    w.use({ name: 'p1', provides: ['spatial-index'], install: () => {} })
    expect(() =>
      w.use({ name: 'p2', provides: ['spatial-index'], install: () => {} }),
    ).toThrowError(/already provided/)
  })

  it('tearing down the provider frees the capability for another plugin', () => {
    const w = createWorld()
    const off = w.use({ name: 'p1', provides: ['si'], install: () => {} })
    off()
    expect(() =>
      w.use({ name: 'p2', provides: ['si'], install: () => {} }),
    ).not.toThrow()
  })
})
