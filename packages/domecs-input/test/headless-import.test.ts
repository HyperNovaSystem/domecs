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

describe('@domecs/input headless import contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('imports and publishes empty snapshots without browser globals', async () => {
    hideBrowserGlobals()
    vi.resetModules()

    const [{ createWorld }, { createInputPlugin }] = await Promise.all([
      import('@domecs/core'),
      import('../src/index.js'),
    ])

    const world = createWorld({ headless: true })
    const dispose = world.use(createInputPlugin())

    world.step(1 / 60)

    expect(world.input.keys.size).toBe(0)
    expect(world.input.keyDelta.pressed.size).toBe(0)
    expect(world.input.keyDelta.released.size).toBe(0)
    expect(world.input.gamepads).toEqual([])
    expect(world.input.focus).toEqual({ activeTag: '', consumesKeys: false })

    dispose()
  })
})
