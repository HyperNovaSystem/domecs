import {
  And,
  Changed,
  createWorld,
  defineEvent,
  entry,
  Has,
  Not,
  type SystemFault,
  type SystemResult,
  type World,
} from '@domecs/core'
import {
  Actor,
  Highlight,
  Player,
  Position,
  Renderable,
  Resource,
  Tile,
  Visible,
} from './components.js'
import { spatialIndexPlugin } from './spatial.js'

export const MAP_W = 128
export const MAP_H = 128
export const FOV_RADIUS = 6

const ENEMY_DENSITY = 512
const RESOURCE_DENSITY = 256

export const MoveEvent = defineEvent<{ entity: number; dx: number; dy: number }>('Move')

/**
 * BETTER_ERRORS — app-level fault union for the roguelike. A blocked move is
 * recoverable data on the actor's entity: the HUD can flash, an AI policy
 * can pick a new direction, and the inspector timeline gets the diagnostic.
 */
export type RoguelikeFault =
  | { kind: 'roguelike/move_blocked'; dx: number; dy: number; reason: 'wall' | 'edge' }

export interface RoguelikeOptions {
  seed?: number
  width?: number
  height?: number
  enemyCount?: number
  resourceCount?: number
}

function defaultEnemyCount(width: number, height: number): number {
  return Math.max(0, Math.floor((width * height) / ENEMY_DENSITY))
}

function defaultResourceCount(width: number, height: number): number {
  return Math.max(0, Math.floor((width * height) / RESOURCE_DENSITY))
}

function normalizeCount(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value))
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`
}

function reveal(world: World, entity: number): void {
  const visible = world.getComponent(entity, Visible)
  if (visible) {
    if (!visible.seen) {
      visible.seen = true
      world.markChanged(entity, Visible)
    }
    return
  }
  world.addComponent(entity, Visible, { seen: true })
  world.markChanged(entity, Visible)
}

export function createRoguelike(options: RoguelikeOptions = {}): {
  world: World
  playerId: number
  width: number
  height: number
} {
  const width = options.width ?? MAP_W
  const height = options.height ?? MAP_H
  const enemiesToSpawn = normalizeCount(options.enemyCount, defaultEnemyCount(width, height))
  const resourcesToSpawn = normalizeCount(options.resourceCount, defaultResourceCount(width, height))
  const world = createWorld({
    seed: options.seed ?? 0xd0dec5,
    fixedStep: 1 / 50,
    // Turn-based world: allow the realtime driver to sleep between actions.
    idle: true,
  })

  world.use(spatialIndexPlugin())

  // Map generation: noise-walled room. Deterministic: uses world.rand only.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1
      const kind: 'floor' | 'wall' = edge || world.rand.next() < 0.08 ? 'wall' : 'floor'
      world.spawn([
        entry(Position, { x, y }),
        entry(Tile, { kind }),
      ])
    }
  }

  // Find a floor tile near centre for the player.
  const cap = world.capability('spatial-index') as unknown as {
    rebuild: () => void
    at: (x: number, y: number) => readonly number[]
  }
  cap.rebuild()

  const isFloor = (x: number, y: number): boolean => cap
    .at(x, y)
    .some((id) => world.getComponent(id, Tile)?.kind === 'floor')
  const nearestFloor = (cx: number, cy: number): { x: number; y: number } | null => {
    const maxR = Math.max(width, height)
    for (let r = 0; r <= maxR; r++) {
      const minY = Math.max(0, cy - r)
      const maxY = Math.min(height - 1, cy + r)
      const minX = Math.max(0, cx - r)
      const maxX = Math.min(width - 1, cx + r)
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          if (isFloor(x, y)) return { x, y }
        }
      }
    }
    return null
  }

  const start = nearestFloor(Math.floor(width / 2), Math.floor(height / 2)) ?? {
    x: Math.floor(width / 2),
    y: Math.floor(height / 2),
  }
  const px = start.x
  const py = start.y

  const playerId = world.spawn([
    entry(Position, { x: px, y: py }),
    entry(Actor, { name: 'You', hp: 20, faction: 'player' as const }),
    entry(Player, {}),
    entry(Renderable, { glyph: '@' }),
    entry(Visible, { seen: true }),
  ])

  const occupied = new Set<string>([cellKey(px, py)])
  const reserveFloor = (minPlayerDistance: number): { x: number; y: number } | null => {
    if (width <= 0 || height <= 0) return null
    const minX = width > 2 ? 1 : 0
    const maxX = width > 2 ? width - 2 : width - 1
    const minY = height > 2 ? 1 : 0
    const maxY = height > 2 ? height - 2 : height - 1
    const spanX = Math.max(1, maxX - minX + 1)
    const spanY = Math.max(1, maxY - minY + 1)
    const attempts = Math.max(64, width * height * 2)
    for (let i = 0; i < attempts; i++) {
      const x = minX + Math.floor(world.rand.next() * spanX)
      const y = minY + Math.floor(world.rand.next() * spanY)
      const key = cellKey(x, y)
      if (occupied.has(key)) continue
      if (Math.abs(x - px) + Math.abs(y - py) < minPlayerDistance) continue
      if (!isFloor(x, y)) continue
      occupied.add(key)
      return { x, y }
    }
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const key = cellKey(x, y)
        if (occupied.has(key)) continue
        if (Math.abs(x - px) + Math.abs(y - py) < minPlayerDistance) continue
        if (!isFloor(x, y)) continue
        occupied.add(key)
        return { x, y }
      }
    }
    return null
  }

  const enemies = [
    { name: 'Cave rat', glyph: 'r', hp: 3 },
    { name: 'Goblin', glyph: 'g', hp: 5 },
    { name: 'Slime', glyph: 's', hp: 4 },
    { name: 'Bat', glyph: 'b', hp: 2 },
  ] as const
  for (let i = 0; i < enemiesToSpawn; i++) {
    const pos = reserveFloor(FOV_RADIUS + 2) ?? reserveFloor(0)
    if (!pos) break
    const enemy = enemies[Math.floor(world.rand.next() * enemies.length)] ?? enemies[0]
    world.spawn([
      entry(Position, pos),
      entry(Actor, { name: enemy.name, hp: enemy.hp, faction: 'monster' as const }),
      entry(Renderable, { glyph: enemy.glyph }),
    ])
  }

  const resources = [
    { kind: 'food', glyph: '%', min: 1, span: 3 },
    { kind: 'gold', glyph: '$', min: 5, span: 11 },
    { kind: 'crystal', glyph: '*', min: 1, span: 2 },
  ] as const
  for (let i = 0; i < resourcesToSpawn; i++) {
    const pos = reserveFloor(3) ?? reserveFloor(0)
    if (!pos) break
    const resource = resources[Math.floor(world.rand.next() * resources.length)] ?? resources[0]
    world.spawn([
      entry(Position, pos),
      entry(Resource, {
        kind: resource.kind,
        amount: resource.min + Math.floor(world.rand.next() * resource.span),
      }),
      entry(Renderable, { glyph: resource.glyph }),
    ])
  }

  // Movement system: consumes MoveEvent, respects walls.
  world.system(
    'movement',
    { schedule: 'event', triggers: [MoveEvent] },
    (ctx): SystemResult<RoguelikeFault> => {
      const cap = world.capability('spatial-index') as unknown as {
        at: (x: number, y: number) => readonly number[]
      }
      const errors: SystemFault<RoguelikeFault>[] = []
      for (const m of ctx.events.of(MoveEvent)) {
        const pos = world.getComponent(m.entity, Position)
        if (!pos) continue
        // Wait actions (dx=dy=0) are legal, not faults.
        if (m.dx === 0 && m.dy === 0) continue
        const nx = pos.x + m.dx
        const ny = pos.y + m.dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          errors.push({
            entity: m.entity,
            component: Position.name,
            error: { kind: 'roguelike/move_blocked', dx: m.dx, dy: m.dy, reason: 'edge' },
            recoverable: true,
          })
          continue
        }
        const here = cap.at(nx, ny)
        const blocked = here.some((id) => {
          const t = world.getComponent(id, Tile)
          return t?.kind === 'wall'
        })
        if (blocked) {
          errors.push({
            entity: m.entity,
            component: Position.name,
            error: { kind: 'roguelike/move_blocked', dx: m.dx, dy: m.dy, reason: 'wall' },
            recoverable: true,
          })
          continue
        }
        pos.x = nx
        pos.y = ny
        world.markChanged(m.entity, Position)
      }
      return { errors }
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
      // Placeholder FOV: reveal tiles/items/actors within radius of the player.
      const ppos = world.getComponent(playerId, Position)
      if (!ppos) return
      const cap = world.capability('spatial-index') as unknown as {
        nearest: (x: number, y: number, r: number) => number[]
      }
      const nearby = cap.nearest(ppos.x, ppos.y, FOV_RADIUS)
      for (const id of nearby) {
        if (world.has(id, Tile) || world.has(id, Renderable)) reveal(world, id)
      }
    },
  )

  // Seed the first render/FOV pass without advancing a turn in the factory.
  world.markChanged(playerId, Position)

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

/** Query helper: uncollected resource pickups. */
export function resourceCount(world: World): number {
  return world.query(Has(Resource)).size
}

/** Debug helper: highlight an entity (uses a transient component — omitted from snapshots). */
export function highlight(world: World, entity: number, color = 'red'): void {
  if (!world.has(entity, Highlight)) {
    world.addComponent(entity, Highlight, { color })
  }
}
