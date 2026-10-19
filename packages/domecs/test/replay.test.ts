import { describe, expect, it } from 'vitest'
import { decodeInput, encodeInput } from '../src/index.js'
import type { InputSnapshot } from '../src/index.js'

// §7.1 (G4; O-80): act logs record what entered a world from outside, so a
// fresh world restored from the base replays to the same strict hashes.

function fullInput(): InputSnapshot {
  return {
    keys: new Set(['KeyW', 'ArrowLeft', 'Space']),
    keyDelta: { pressed: new Set(['Space', 'KeyA']), released: new Set(['KeyD']) },
    mods: { ctrl: true, alt: false, shift: true, meta: false },
    pointer: { x: 12.5, y: -3, buttons: 1, delta: { x: 2, y: -1 }, wheel: 40, entered: [7, 3] },
    gamepads: [
      { index: 0, axes: [0.5, -0.25], buttons: [{ pressed: true, value: 1 }, { pressed: false, value: 0.2 }] },
    ],
    focus: { activeTag: 'INPUT', consumesKeys: true },
  }
}

function emptyInputSnapshot(): InputSnapshot {
  return {
    keys: new Set(),
    keyDelta: { pressed: new Set(), released: new Set() },
    mods: { ctrl: false, alt: false, shift: false, meta: false },
    pointer: { x: 0, y: 0, buttons: 0, delta: { x: 0, y: 0 }, wheel: 0, entered: [] },
    gamepads: [],
    focus: { activeTag: '', consumesKeys: false },
  }
}

describe('encodeInput / decodeInput (§7.1 test 2)', () => {
  it('encodes every part with sorted key arrays', () => {
    const json = encodeInput(fullInput())
    expect(json).toEqual({
      keys: ['ArrowLeft', 'KeyW', 'Space'],
      pressed: ['KeyA', 'Space'],
      released: ['KeyD'],
      mods: { ctrl: true, alt: false, shift: true, meta: false },
      pointer: { x: 12.5, y: -3, buttons: 1, delta: { x: 2, y: -1 }, wheel: 40, entered: [7, 3] },
      gamepads: [
        { index: 0, axes: [0.5, -0.25], buttons: [{ pressed: true, value: 1 }, { pressed: false, value: 0.2 }] },
      ],
      focus: { activeTag: 'INPUT', consumesKeys: true },
    })
  })

  it('omits empty pressed/released and parts equal to the empty input', () => {
    expect(encodeInput(emptyInputSnapshot())).toEqual({ keys: [] })
    const onlyKeys = { ...emptyInputSnapshot(), keys: new Set(['b', 'a']) }
    expect(encodeInput(onlyKeys)).toEqual({ keys: ['a', 'b'] })
    const json = encodeInput({ ...emptyInputSnapshot(), pointer: { ...emptyInputSnapshot().pointer, x: -0 } })
    expect(Object.is(json.pointer?.x, -0)).toBe(true)
  })

  it('round-trips: decodeInput(encodeInput(x)) deep-equals x, with Sets rebuilt', () => {
    for (const input of [fullInput(), emptyInputSnapshot()]) {
      const back = decodeInput(encodeInput(input))
      expect(back).toEqual(input)
      expect(back.keys).toBeInstanceOf(Set)
      expect(back.keyDelta.pressed).toBeInstanceOf(Set)
      expect(back.keyDelta.released).toBeInstanceOf(Set)
    }
  })

  it('survives JSON.parse(JSON.stringify(…))', () => {
    const json = encodeInput(fullInput())
    const parsed = JSON.parse(JSON.stringify(json)) as typeof json
    expect(parsed).toEqual(json)
    expect(decodeInput(parsed)).toEqual(fullInput())
  })

  it('copies: the encoded value shares nothing with the snapshot, and vice versa', () => {
    const input = fullInput()
    const json = encodeInput(input)
    ;(input.pointer.entered as number[]).push(99)
    ;(input.gamepads[0]!.axes as number[])[0] = 9
    expect(json.pointer?.entered).toEqual([7, 3])
    expect(json.gamepads?.[0]?.axes).toEqual([0.5, -0.25])
    const decoded = decodeInput(json)
    ;(decoded.pointer.entered as number[]).push(1)
    expect(json.pointer?.entered).toEqual([7, 3])
  })
})
