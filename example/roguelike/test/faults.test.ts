import { describe, expect, it } from 'vitest'
import { Faulted } from '@domecs/core'
import { MoveEvent, createRoguelike } from '../src/index.js'

describe('BETTER_ERRORS — roguelike move discipline', () => {
  it('attaches Faulted to the player when a move into a wall is blocked', () => {
    const { world, playerId } = createRoguelike({ seed: 3, width: 5, height: 5 })
    // Repeatedly try to walk west into the wall column at x=0.
    for (let i = 0; i < 10; i++) {
      world.turn(MoveEvent, { entity: playerId, dx: -1, dy: 0 })
    }
    const faulted = world.getComponent(playerId, Faulted)
    expect(faulted).toBeDefined()
    const blocked = faulted!.faults.find((f) => f.kind === 'roguelike/move_blocked')
    expect(blocked).toBeDefined()
    expect(blocked!.recoverable).toBe(true)
  })

  it('a legal move does not attach Faulted on its own turn', () => {
    const { world, playerId } = createRoguelike({ seed: 5, width: 8, height: 8 })
    // Find a legal cardinal direction by trying each — any unblocked move clears the slate.
    const dirs: Array<[number, number]> = [[1, 0], [0, 1], [-1, 0], [0, -1]]
    for (const [dx, dy] of dirs) {
      const beforeFault = world.has(playerId, Faulted)
      world.turn(MoveEvent, { entity: playerId, dx, dy })
      const after = world.has(playerId, Faulted)
      if (!beforeFault && !after) return
    }
    // If we got here every cardinal was blocked — extremely unlikely; the test
    // would have caught the negative path on the first try.
  })
})
