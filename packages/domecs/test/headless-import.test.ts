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

describe('@domecs/core headless import contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('imports and steps a headless world without browser globals', async () => {
    hideBrowserGlobals()
    vi.resetModules()

    const { createWorld, defineComponent, entry, Has } = await import('../src/index.js')

    const Position = defineComponent<{ x: number; y: number }>('Position')
    const world = createWorld({ headless: true })
    const entity = world.spawn([entry(Position, { x: 1, y: 2 })])
    let seen = 0

    world.system('advance', { schedule: 'tick', query: Has(Position) }, ({ entities }) => {
      seen += entities.length
      const pos = world.getComponent(entity, Position)
      if (!pos) return
      pos.x += 1
      world.markChanged(entity, Position)
    })

    world.step(1 / 60)

    expect(seen).toBe(1)
    expect(world.getComponent(entity, Position)).toEqual({ x: 2, y: 2 })
    expect(() => world.start()).toThrow(/headless/i)
  })
})
