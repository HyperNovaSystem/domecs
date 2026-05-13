// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const browserGlobals = [
  'document',
  'window',
  'navigator',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const

function hideBrowserGlobals(): void {
  for (const name of browserGlobals) vi.stubGlobal(name, undefined)
}

describe('@domecs/dom headless import contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('imports and installs an empty renderer without a live document', async () => {
    hideBrowserGlobals()
    vi.resetModules()

    const [{ createWorld }, { mountDOM }] = await Promise.all([
      import('@domecs/core'),
      import('../src/index.js'),
    ])

    const world = createWorld({ headless: true })
    const mount = mountDOM(world, { slots: {}, views: [] })

    expect(() => world.step(0)).not.toThrow()
    expect(() => mount.teardown()).not.toThrow()
  })
})
