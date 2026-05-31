/**
 * codemod.test.mjs — self-test for domecs-v1.cjs jscodeshift transform.
 *
 * Runs the transform on __fixtures__/before.tsx and asserts the result
 * equals __fixtures__/after.tsx (normalizing trailing whitespace/newlines).
 *
 * Run: node --test tools/codemod/codemod.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// Load the transform (CommonJS)
const transform = require('./domecs-v1.cjs')

const FIXTURES = path.join(__dirname, '__fixtures__')
const beforeSrc = readFileSync(path.join(FIXTURES, 'before.tsx'), 'utf8')
const afterSrc = readFileSync(path.join(FIXTURES, 'after.tsx'), 'utf8')

/** Normalize: strip trailing whitespace on each line, normalize line endings,
 *  trim trailing newlines. */
function normalize(src) {
  return src
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trimEnd()
}

/**
 * Build a minimal jscodeshift API shim so we can call the transform directly
 * without spawning a worker.
 */
function buildApi(parser) {
  const jscodeshift = require('jscodeshift')
  const j = jscodeshift.withParser(parser || 'tsx')

  const reports = []
  const api = {
    jscodeshift: j,
    stats: () => {},
    report: (msg) => reports.push(msg),
  }
  return { api, reports }
}

test('domecs-v1 transform: fixture before.tsx → after.tsx', () => {
  const { api, reports } = buildApi('tsx')

  const result = transform(
    { source: beforeSrc, path: '__fixtures__/before.tsx' },
    api
  )

  const actual = normalize(result)
  const expected = normalize(afterSrc)

  // Diff helper for better error messages
  if (actual !== expected) {
    const actualLines = actual.split('\n')
    const expectedLines = expected.split('\n')
    const maxLines = Math.max(actualLines.length, expectedLines.length)
    const diffs = []
    for (let i = 0; i < maxLines; i++) {
      if (actualLines[i] !== expectedLines[i]) {
        diffs.push(`Line ${i + 1}:`)
        diffs.push(`  expected: ${JSON.stringify(expectedLines[i])}`)
        diffs.push(`  actual:   ${JSON.stringify(actualLines[i])}`)
      }
    }
    assert.fail(
      `Transform output does not match after.tsx:\n${diffs.slice(0, 40).join('\n')}`
    )
  }

  assert.equal(actual, expected)
  console.log('  Report:', reports[0] ?? '(none)')
})

test('markChanged identifier is NOT renamed', () => {
  const { api } = buildApi('tsx')
  const result = transform(
    { source: beforeSrc, path: '__fixtures__/before.tsx' },
    api
  )
  assert.ok(result.includes('markChanged'), 'markChanged must survive in output')
  assert.ok(!result.includes('markOnChanged'), 'markChanged must not become markOnChanged')
})

test('.step(dt) call is NOT renamed to .stepOnce()', () => {
  const { api } = buildApi('tsx')
  const result = transform(
    { source: beforeSrc, path: '__fixtures__/before.tsx' },
    api
  )
  assert.ok(result.includes('world.step(dt)'), '.step(dt) must survive untouched')
})

test('no-arg .step() IS renamed to .stepOnce()', () => {
  const { api } = buildApi('tsx')
  const result = transform(
    { source: beforeSrc, path: '__fixtures__/before.tsx' },
    api
  )
  assert.ok(result.includes('world.stepOnce()'), 'no-arg .step() must become .stepOnce()')
})

test('Added and Changed imports renamed to OnAdded and OnChanged', () => {
  const { api } = buildApi('tsx')
  const result = transform(
    { source: beforeSrc, path: '__fixtures__/before.tsx' },
    api
  )
  assert.ok(result.includes('OnAdded'), 'Added should be renamed to OnAdded')
  assert.ok(result.includes('OnChanged(SomeComp)'), 'Changed(SomeComp) call should become OnChanged(SomeComp)')
  // OnChangedResource was already the new name — should still be there, not double-renamed
  assert.ok(result.includes('OnChangedResource(SomeRes)'), 'OnChangedResource must remain')
  assert.ok(!result.includes('OnOnChangedResource'), 'OnChangedResource must not be double-renamed')
})

test('mountDOM call is flagged with CODEMOD-REVIEW comment', () => {
  const { api } = buildApi('tsx')
  const result = transform(
    { source: beforeSrc, path: '__fixtures__/before.tsx' },
    api
  )
  assert.ok(
    result.includes('CODEMOD-REVIEW: mountDOM()'),
    'mountDOM call must have CODEMOD-REVIEW comment'
  )
  // The call itself must NOT be modified
  assert.ok(result.includes('mountDOM(document.body, world)'), 'mountDOM call must be unchanged')
})

test('changedOn:[] is flagged with CODEMOD-REVIEW comment', () => {
  const { api } = buildApi('tsx')
  const result = transform(
    { source: beforeSrc, path: '__fixtures__/before.tsx' },
    api
  )
  assert.ok(
    result.includes('CODEMOD-REVIEW: changedOn:[]'),
    'changedOn:[] must have CODEMOD-REVIEW comment'
  )
  // The value must NOT be changed
  assert.ok(result.includes('changedOn: []'), 'changedOn:[] must be left unchanged')
})

test('world.count and world.select are renamed to countEntities/selectViews', () => {
  const { api } = buildApi('tsx')
  const result = transform(
    { source: beforeSrc, path: '__fixtures__/before.tsx' },
    api
  )
  assert.ok(result.includes('world.countEntities('), 'world.count should become world.countEntities')
  assert.ok(result.includes('world.selectViews('), 'world.select should become world.selectViews')
})

test('rng.next() and rng.int() are renamed to uniform/uniformInt', () => {
  const { api } = buildApi('tsx')
  const result = transform(
    { source: beforeSrc, path: '__fixtures__/before.tsx' },
    api
  )
  assert.ok(result.includes('rng.uniform()'), 'rng.next() should become rng.uniform()')
  assert.ok(result.includes('rng.uniformInt(6)'), 'rng.int(6) should become rng.uniformInt(6)')
})
