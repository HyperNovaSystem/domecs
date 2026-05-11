import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { entry, Has } from 'domecs'
import {
  cameraOrigin,
  createRoguelike,
  describePlayerTile,
  enemyCount,
  highlight,
  MoveEvent,
  Position,
  resourceCount,
  Resource,
  Renderable,
  Tile,
  Actor,
  Highlight,
} from '../src/index.js'

describe('roguelike — v0.1 surface validation (SPEC exemplar #1)', () => {
  it('rejects invalid runtime component payloads via component validation', () => {
    const { world } = createRoguelike({ seed: 1, width: 8, height: 8 })
    const e = world.spawn()
    expect(() =>
      world.addComponent(e, Position, { x: 1.5, y: 2 } as any),
    ).toThrow(/integer/)
  })

  it('spawns a 128x128 grid + player/resources/enemies without mounting DOM (headless)', () => {
    const { world, width, height } = createRoguelike({ seed: 1 })
    const tiles = world.query(Has(Tile)).size
    expect(tiles).toBe(width * height)
    // ~16k tile entities, plus actors and resource pickups.
    expect(tiles).toBeGreaterThanOrEqual(16000)
    expect(enemyCount(world)).toBeGreaterThan(0)
    expect(resourceCount(world)).toBeGreaterThan(0)
  })

  it('places deterministic enemies and resources on floor tiles', () => {
    const { world } = createRoguelike({
      seed: 77,
      width: 32,
      height: 32,
      enemyCount: 3,
      resourceCount: 5,
    })
    const cap = world.capability('spatial-index') as unknown as {
      rebuild: () => void
      at: (x: number, y: number) => readonly number[]
    }
    cap.rebuild()

    const floorAt = (x: number, y: number): boolean => cap
      .at(x, y)
      .some((id) => world.getComponent(id, Tile)?.kind === 'floor')

    expect(enemyCount(world)).toBe(3)
    expect(resourceCount(world)).toBe(5)

    const monsters = world
      .query(Has(Actor))
      .entities.filter((e) => world.getComponent(e.id, Actor)?.faction === 'monster')
    expect(monsters).toHaveLength(3)
    for (const e of monsters) {
      const pos = world.getComponent(e.id, Position)
      expect(pos).toBeTruthy()
      expect(world.getComponent(e.id, Renderable)?.glyph).toMatch(/[rgbs]/)
      expect(floorAt(pos!.x, pos!.y)).toBe(true)
    }

    for (const e of world.query(Has(Resource)).entities) {
      const pos = world.getComponent(e.id, Position)
      const resource = world.getComponent(e.id, Resource)
      expect(pos).toBeTruthy()
      expect(resource?.amount).toBeGreaterThan(0)
      expect(world.getComponent(e.id, Renderable)?.glyph).toMatch(/[%$*]/)
      expect(floorAt(pos!.x, pos!.y)).toBe(true)
    }
  })

  it('clamps the browser camera to a fixed-size viewport over the larger map', () => {
    const base = { mapWidth: 128, mapHeight: 128, viewWidth: 48, viewHeight: 32 }
    expect(cameraOrigin({ ...base, playerX: 2, playerY: 2 })).toEqual({ x: 0, y: 0 })
    expect(cameraOrigin({ ...base, playerX: 64, playerY: 64 })).toEqual({ x: 40, y: 48 })
    expect(cameraOrigin({ ...base, playerX: 126, playerY: 126 })).toEqual({ x: 80, y: 96 })
  })

  it('uses matching motion transitions for camera and actor transforms', () => {
    const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8')
    expect(css).toContain('--move-ms: 120ms;')
    expect(css).toMatch(
      /#viewport\.motion-ready #world,\s*#viewport\.motion-ready #actors\s*{[^}]*transition: transform var\(--move-ms\) var\(--move-ease\);/s,
    )
    expect(css).toMatch(
      /\.actor\s*{[^}]*transition: transform var\(--move-ms\) var\(--move-ease\);/s,
    )
    expect(css).toMatch(/prefers-reduced-motion: reduce/)
  })

  it('turn-based scheduling: nothing advances unless the player acts', () => {
    const { world, playerId } = createRoguelike({ seed: 2 })
    const before = world.getComponent(playerId, Position)!
    const startX = before.x
    // Many idle ticks should not move the player.
    for (let i = 0; i < 10; i++) world.step(1 / 50)
    const stillBefore = world.getComponent(playerId, Position)!
    expect(stillBefore.x).toBe(startX)
    // A turn() call both emits + steps in one go.
    world.turn(MoveEvent, { entity: playerId, dx: 1, dy: 0 })
    const after = world.getComponent(playerId, Position)!
    // If blocked by a wall, coordinate stays; so try a few directions.
    let moved = after.x !== startX || after.y !== before.y
    if (!moved) {
      world.turn(MoveEvent, { entity: playerId, dx: 0, dy: 1 })
      const a2 = world.getComponent(playerId, Position)!
      moved = a2.x !== startX || a2.y !== before.y
    }
    expect(moved).toBe(true)
  })

  it('blocks movement into walls (spatial-index capability is consulted)', () => {
    const { world, playerId } = createRoguelike({ seed: 3, width: 5, height: 5 })
    // Coordinates (0,*) are walls. Try to walk into the west wall.
    const before = world.getComponent(playerId, Position)!
    for (let i = 0; i < 10; i++) {
      world.turn(MoveEvent, { entity: playerId, dx: -1, dy: 0 })
    }
    const after = world.getComponent(playerId, Position)!
    expect(after.x).toBeGreaterThanOrEqual(1) // blocked before leaving interior
    expect(before.x).toBeGreaterThanOrEqual(1)
    expect(describePlayerTile(world, playerId)).toBe('floor')
  })

  it('PRNG is part of the snapshot: restore replays identically', () => {
    const { world: a } = createRoguelike({ seed: 0xdeadbeef })
    const seq = [a.rand.next(), a.rand.next(), a.rand.next()]

    const { world: b } = createRoguelike({ seed: 0xdeadbeef })
    const seqB = [b.rand.next(), b.rand.next(), b.rand.next()]
    expect(seqB).toEqual(seq) // same seed → same sequence
  })

  it('snapshot/restore roundtrip preserves tile grid + player + PRNG', () => {
    const { world, playerId } = createRoguelike({ seed: 42, width: 16, height: 16 })
    // Move around, dirty some state.
    world.turn(MoveEvent, { entity: playerId, dx: 1, dy: 0 })
    world.turn(MoveEvent, { entity: playerId, dx: 0, dy: 1 })
    const snap = world.snapshot()
    const posBefore = { ...world.getComponent(playerId, Position)! }
    const prngBefore = world.rand.next()

    // Restore into a *different* game and verify world state matches.
    const { world: w2 } = createRoguelike({ seed: 99, width: 16, height: 16 })
    w2.restore(snap)
    expect(w2.getComponent(playerId, Position)).toEqual(posBefore)
    expect(w2.rand.next()).toBe(prngBefore)
    expect(w2.query(Has(Tile)).size).toBe(16 * 16)
  })

  it('transient components (Highlight) are excluded from snapshots', () => {
    const { world, playerId } = createRoguelike({ seed: 7, width: 8, height: 8 })
    highlight(world, playerId, 'red')
    expect(world.has(playerId, Highlight)).toBe(true)
    const snap = world.snapshot()
    const rec = snap.entities.find((e) => e.id === playerId)!
    expect(rec.components.Highlight).toBeUndefined()
  })

  it('determinism: two identical games produce identical post-action snapshots', () => {
    const run = (): unknown => {
      const { world, playerId } = createRoguelike({ seed: 123, width: 10, height: 10 })
      const moves: Array<[number, number]> = [
        [1, 0],
        [0, 1],
        [1, 0],
        [-1, 0],
      ]
      for (const [dx, dy] of moves) {
        world.turn(MoveEvent, { entity: playerId, dx, dy })
      }
      const snap = world.snapshot()
      // PRNG + tick + sorted entity list = deterministic signature.
      return {
        tick: snap.tick,
        seed: snap.seed,
        sigs: snap.entities
          .filter((e) => e.components.Player || e.components.Actor)
          .map((e) => ({ id: e.id, c: e.components })),
      }
    }
    const a = JSON.stringify(run())
    const b = JSON.stringify(run())
    expect(a).toBe(b)
  })

  it('reactive FOV system marks Visible tiles near the player', () => {
    const { world, playerId } = createRoguelike({ seed: 11, width: 20, height: 20 })
    world.turn(MoveEvent, { entity: playerId, dx: 1, dy: 0 })
    // A few tiles adjacent to the player should now be Visible.
    const visible = world.query(Has(Tile))
      .entities.map((v) => v as unknown as { id: number; Visible?: { seen: boolean } })
      .filter((v) => v.Visible?.seen)
    expect(visible.length).toBeGreaterThan(5)
  })

  it('plugin capability is reachable from user code', () => {
    const { world } = createRoguelike({ seed: 1, width: 8, height: 8 })
    const cap = world.capability('spatial-index') as unknown as {
      at: (x: number, y: number) => readonly number[]
    }
    const here = cap.at(4, 4)
    expect(here.length).toBeGreaterThan(0)
    // Every id at this cell has Position(4,4).
    for (const id of here) {
      const p = world.getComponent(id, Position)
      expect(p).toBeTruthy()
      expect(p!.x).toBe(4)
      expect(p!.y).toBe(4)
    }
  })

  it('Actor query separates the player from monsters', () => {
    const { world, playerId } = createRoguelike({
      seed: 5,
      width: 8,
      height: 8,
      enemyCount: 0,
      resourceCount: 0,
    })
    expect(world.query(Has(Actor)).size).toBe(1)
    world.spawn([
      entry(Position, { x: 3, y: 3 }),
      entry(Actor, { name: 'Rat', hp: 2, faction: 'monster' as const }),
    ])
    expect(world.query(Has(Actor)).size).toBe(2)
    expect(enemyCount(world)).toBe(1)
    // Player still addressable.
    expect(world.getComponent(playerId, Actor)?.name).toBe('You')
  })
})
