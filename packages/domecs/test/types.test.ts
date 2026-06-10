import { describe, expect, it } from 'vitest'
import { defineComponent } from '../src/component.js'
import { defineResource } from '../src/resource.js'
import type { ComponentValue, ResourceValue } from '../src/index.js'

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

const Score = defineResource<{ score: number }>('Score')
const Roster = defineResource<{ names: string[] }>('Roster')

describe('ResourceType<T> — T is load-bearing in the brand (O-27)', () => {
  it('ResourceTypes with different T are not mutually assignable', () => {
    // A phantom T makes every ResourceType structurally identical, so a
    // Roster could be passed where a Score is expected (and `setResource`
    // would happily accept the wrong value shape via the wrong handle).
    // @ts-expect-error — ResourceType<{score}> must not satisfy ResourceType<{names}>
    const wrongA: typeof Roster = Score
    // @ts-expect-error — and the reverse direction must fail too
    const wrongB: typeof Score = Roster
    expect(wrongA).toBe(Score)
    expect(wrongB).toBe(Roster)
  })

  it('ResourceValue<R> discriminates T between distinct resources', () => {
    type _ScoreVal = Expect<Equal<ResourceValue<typeof Score>, { score: number }>>
    type _RosterVal = Expect<Equal<ResourceValue<typeof Roster>, { names: string[] }>>
    type _NotEqual = Expect<
      Equal<Equal<ResourceValue<typeof Score>, ResourceValue<typeof Roster>>, false>
    >
    expect(true).toBe(true)
  })
})
