import { describe, expect, it } from 'vitest'
import { extractDoctests, tempFileName } from './doctest.mjs'

describe('extractDoctests', () => {
  it('extracts only fences whose info string starts with "ts doctest"', () => {
    const md = [
      '# Doc',
      '```ts',
      'const skip = 1 // plain ts, not a doctest',
      '```',
      'prose',
      '```ts doctest',
      "import { strict as assert } from 'node:assert'",
      'assert.equal(1 + 1, 2)',
      '```',
    ].join('\n')
    const blocks = extractDoctests(md, 'doc/api.md')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].code).toContain('assert.equal(1 + 1, 2)')
    expect(blocks[0].source).toBe('doc/api.md')
  })

  it('honors an explicit name= in the info string', () => {
    const md = ['```ts doctest name=event-tick-delay', 'const a = 1', '```'].join('\n')
    const blocks = extractDoctests(md, 'doc/api.md')
    expect(blocks[0].name).toBe('event-tick-delay')
  })

  it('falls back to <basename>-<index> when unnamed', () => {
    const md = ['```ts doctest', 'const a = 1', '```', '```ts doctest', 'const b = 2', '```'].join('\n')
    const blocks = extractDoctests(md, 'doc/api.md')
    expect(blocks.map((b) => b.name)).toEqual(['api-0', 'api-1'])
  })
})

describe('tempFileName', () => {
  it('produces a .ts filename from the block name', () => {
    expect(tempFileName({ name: 'event-tick-delay' })).toBe('event-tick-delay.ts')
  })
})
