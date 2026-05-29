import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import type { ComponentValue } from '../src/index.js'

// Compile-time equality: tsc --noEmit is part of `npm test`, so a mismatch
// here is a hard test failure, not a silent pass.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B
  ? 1
  : 2
  ? true
  : false
type Expect<T extends true> = T

const Position = defineComponent<{ x: number; y: number }>('Position', {
  defaults: { x: 0, y: 0 },
})

describe('ComponentValue<C> — value-type extractor (review #3)', () => {
  it('extracts the component value type from a ComponentType', () => {
    // The whole point is the type-level assertion below; the runtime body
    // just gives vitest a green to report.
    type _Pos = Expect<Equal<ComponentValue<typeof Position>, { x: number; y: number }>>
    const v: ComponentValue<typeof Position> = Position.create({ x: 1, y: 2 })
    expect(v).toEqual({ x: 1, y: 2 })
  })

  it('matches ReturnType<typeof X.create> (the pattern it replaces)', () => {
    type _Same = Expect<
      Equal<ComponentValue<typeof Position>, ReturnType<typeof Position.create>>
    >
    expect(true).toBe(true)
  })
})
