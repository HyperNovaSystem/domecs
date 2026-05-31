import { describe, expect, it } from 'vitest'
import { defineResource } from '../src/resource.js'
import { createWorld } from '../src/world.js'

const Score = defineResource<{ points: number }>('Score', {
  default: () => ({ points: 0 }),
})
const Config = defineResource<{ hard: boolean }>('Config') // no default

describe('world.describeResource — resource reflection (§6)', () => {
  it('reports name, hasDefault, and hasValue=false before first read', () => {
    const w = createWorld()
    const d = w.describeResource(Config)
    expect(d).toEqual({ name: 'Config', hasValue: false, hasDefault: false })
  })

  it('hasDefault is true when a default factory was declared', () => {
    const w = createWorld()
    expect(w.describeResource(Score).hasDefault).toBe(true)
  })

  it('hasValue flips to true after the resource is materialized', () => {
    const w = createWorld()
    expect(w.describeResource(Score).hasValue).toBe(false)
    w.getResource(Score) // materializes the default
    expect(w.describeResource(Score).hasValue).toBe(true)
  })

  it('resourceTypes() enumerates every touched resource type', () => {
    const w = createWorld()
    w.describeResource(Score)
    w.describeResource(Config)
    const names = w.resourceTypes().map((t) => t.name).sort()
    expect(names).toEqual(['Config', 'Score'])
  })
})
