import { describe, expect, it } from 'vitest'
import { BUILD_ID } from '../src/index.js'

// ED-15: every package exports BUILD_ID. Source builds say 'dev';
// scripts/pack-for-studio.mjs stamps '<version>+g<sha>[-dirty]' into the
// packed dist, and a published build carries the plain version.
describe('BUILD_ID', () => {
  it('is a string export of the package barrel, "dev" in source builds', () => {
    expect(typeof BUILD_ID).toBe('string')
    expect(BUILD_ID).toBe('dev')
  })
})
