import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractDoctests, tempFileName } from '../scripts/doctest.mjs'

test('extractDoctests extracts only fences whose info string starts with "ts doctest"', () => {
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
  assert.equal(blocks.length, 1)
  assert.ok(blocks[0].code.includes('assert.equal(1 + 1, 2)'))
  assert.equal(blocks[0].source, 'doc/api.md')
})

test('extractDoctests honors an explicit name= in the info string', () => {
  const md = ['```ts doctest name=event-tick-delay', 'const a = 1', '```'].join('\n')
  const blocks = extractDoctests(md, 'doc/api.md')
  assert.equal(blocks[0].name, 'event-tick-delay')
})

test('extractDoctests falls back to <basename>-<index> when unnamed', () => {
  const md = ['```ts doctest', 'const a = 1', '```', '```ts doctest', 'const b = 2', '```'].join('\n')
  const blocks = extractDoctests(md, 'doc/api.md')
  assert.deepEqual(blocks.map((b) => b.name), ['api-0', 'api-1'])
})

test('tempFileName produces a .ts filename from the block name', () => {
  assert.equal(tempFileName({ name: 'event-tick-delay' }), 'event-tick-delay.ts')
})
