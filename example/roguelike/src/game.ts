import {
  And,
  Changed,
  createWorld,
  defineEvent,
  Has,
  Not,
  type World,
} from 'domecs'
import {
  Actor,
  Highlight,
  Player,
  Position,
  Renderable,
  Tile,
  Visible,
} from './components.js'
import { spatialIndexPlugin } from './spatial.js'

export const MAP_W = 128
export const MAP_H = 128

export const MoveEvent = defineEvent<{ entity: number; dx: number; dy: number }>('Move')

export interface RoguelikeOptions {
  seed?: number
  width?: number
  height?: number
}

export function createRoguelike(options: RoguelikeOptions = {}): {
  world: World
  playerId: number
  width: number
  height: number
} {
  const width = options.width ?? MAP_W
  const height = options.height ?? MAP_H
  const world = createWorld({ seed: options.seed ?? 0xd0dec5, fixedStep: 1 / 50 })

  world.use(spatialIndexPlugin())

  // Map generation: noise-walled room. Deterministic: uses world.rand only.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1
      const kind: 'floor' | 'wall' = edge || world.rand.next() < 0.08 ? 'wall' : 'floor'
      world.spawn([
        [Position as never, { x, y }],
        [Tile as never, { kind }],
      ])
    }
  }

  // Find a floor tile near centre for the player.
  const cap = world.capability('spatial-index') as unknown as {
    rebuild: () => void
    at: (x: number, y: number) => readonly number[]
  }
  cap.rebuild()
  let px = Math.floor(width / 2)
  let py = Math.floor(height / 2)
  for (let r = 0; r < 10; r++) {
    const ids = cap.at(px, py)
    const tile = ids
      .map((id) => world.getComponent(id, Tile))
      .find((t): t is { kind: 'floor' | 'wall' } => !!t)
    if (tile && tile.kind === 'floor') break
    px += 1
  }

  const playerId = world.spawn([
    [Position as never, { x: px, y: py }],
    [Actor as never, { name: 'You', hp: 20, faction: 'player' }],
    [Player as never, {}],
    [Renderable as never, { glyph: '@' }],
    [Visible as never, { seen: true }],
  ])

  // Movement system: consumes MoveEvent, respects walls.
  world.system(
    'movement',
    { schedule: 'event', triggers: [MoveEvent] },
    (ctx) => {
      const cap = world.capability('spatial-index') as unknown as {
        at: (x: number, y: number) => readonly number[]
      }
      for (const m of ctx.events.of(MoveEvent)) {
        const pos = world.getComponent(m.entity, Position)
        if (!pos) continue
        const nx = pos.x + m.dx
        const ny = pos.y + m.dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const here = cap.at(nx, ny)
        const blocked = here.some((id) => {
          const t = world.getComponent(id, Tile)
          return t?.kind === 'wall'
        })
        if (blocked) continue
        pos.x = nx
        pos.y = ny
        world.markChanged(m.entity, Position)
      }
    },
  )

  // FOV system: fire after movement. Reactive on Changed(Position) of the player.
  // R-1: Has(Position) would fire every tick; Changed gates to post-move ticks only.
  world.system(
    'fov',
    {
      schedule: 'reactive',
      reactsTo: And(Has(Player), Changed(Position)),
    },
    () => {
      // Placeholder FOV: mark Visible on tiles within radius 6 of the player.
      const ppos = world.getComponent(playerId, Position)
      if (!ppos) return
      const cap = world.capability('spatial-index') as unknown as {
        nearest: (x: number, y: number, r: number) => number[]
      }
      const nearby = cap.nearest(ppos.x, ppos.y, 6)
      for (const id of nearby) {
        if (world.has(id, Tile)) {
          const v = world.getComponent(id, Visible)
          if (v) v.seen = true
          else world.addComponent(id, Visible, { seen: true })
        }
      }
    },
  )

  return { world, playerId, width, height }
}

/** Convenience: what is the player standing on? */
export function describePlayerTile(world: World, playerId: number): string | null {
  const p = world.getComponent(playerId, Position)
  if (!p) return null
  const cap = world.capability('spatial-index') as unknown as {
    at: (x: number, y: number) => readonly number[]
  }
  const ids = cap.at(p.x, p.y)
  for (const id of ids) {
    const t = world.getComponent(id, Tile)
    if (t) return t.kind
  }
  return null
}

/** Query helper: living enemies. */
export function enemyCount(world: World): number {
  return world.query(And(Has(Actor), Not(Player))).size
}

/** Debug helper: highlight an entity (uses a transient component — omitted from snapshots). */
export function highlight(world: World, entity: number, color = 'red'): void {
  if (!world.has(entity, Highlight)) {
    world.addComponent(entity, Highlight, { color })
  }
}
