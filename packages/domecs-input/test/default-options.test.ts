import { describe, expect, it } from 'vitest'
import { DEFAULT_INPUT_OPTIONS } from '../src/index.js'

describe('DEFAULT_INPUT_OPTIONS', () => {
  it('exposes the static input defaults', () => {
    expect(DEFAULT_INPUT_OPTIONS).toEqual({
      clearOnBlur: true,
      textInputSelector: 'input,textarea,[contenteditable="true"]',
      preventDefaultKeys: false,
    })
  })

  it('is frozen so callers cannot mutate the shared defaults', () => {
    expect(Object.isFrozen(DEFAULT_INPUT_OPTIONS)).toBe(true)
  })
})
