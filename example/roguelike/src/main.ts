import { Changed, Has, type EntityView } from 'domecs'
import { defineView, mountDOM } from 'domecs-dom'
import { createInputPlugin } from 'domecs-input'
import {
  createRoguelike,
  Highlight,
  MoveEvent,
  Position,
  Renderable,
  Tile,
  Visible,
} from './index.js'

const CELL = 16
const WIDTH = 48
const HEIGHT = 32

const worldSlot = document.getElementById('world') as HTMLElement
const actorSlot = document.getElementById('actors') as HTMLElement
const viewport = document.getElementById('viewport') as HTMLElement
const statusEl = document.getElementById('status') as HTMLElement

viewport.style.width = `${WIDTH * CELL}px`
viewport.style.height = `${HEIGHT * CELL}px`
document.documentElement.style.setProperty('--cell', `${CELL}px`)

const { world, playerId } = createRoguelike({ seed: 0xbadb01, width: WIDTH, height: HEIGHT })

const tileView = defineView({
  slot: 'world',
  query: Has(Tile),
  changedOn: [Tile, Visible],
  create(e: EntityView) {
    const el = document.createElement('div')
    el.className = 'tile'
    applyTile(el, e)
    return el
  },
  update(el, e) {
    applyTile(el, e)
  },
})

function applyTile(el: HTMLElement, e: EntityView): void {
  const pos = world.getComponent(e.id, Position)
  const tile = world.getComponent(e.id, Tile)
  const vis = world.getComponent(e.id, Visible)
  if (!pos || !tile) return
  el.style.transform = `translate(${pos.x * CELL}px, ${pos.y * CELL}px)`
  el.classList.toggle('wall', tile.kind === 'wall')
  el.classList.toggle('floor', tile.kind === 'floor')
  el.classList.toggle('seen', !!vis?.seen)
}

const actorView = defineView({
  slot: 'actors',
  query: Has(Renderable),
  changedOn: [Position, Highlight],
  create(e) {
    const el = document.createElement('div')
    el.className = 'actor'
    el.textContent = world.getComponent(e.id, Renderable)?.glyph ?? '?'
    applyActor(el, e)
    return el
  },
  update(el, e) {
    const glyph = world.getComponent(e.id, Renderable)?.glyph
    if (glyph && el.textContent !== glyph) el.textContent = glyph
    applyActor(el, e)
  },
})

function applyActor(el: HTMLElement, e: EntityView): void {
  const pos = world.getComponent(e.id, Position)
  if (pos) el.style.transform = `translate(${pos.x * CELL}px, ${pos.y * CELL}px)`
  el.classList.toggle('highlight', world.has(e.id, Highlight))
}

mountDOM(world, {
  slots: { world: worldSlot, actors: actorSlot },
  views: [tileView, actorView],
})

world.use(
  createInputPlugin({
    // Treat arrow keys, space, WASD as handled — prevent browser scroll.
    preventDefaultKeys: true,
  }),
)

const KEY_TO_DELTA: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  KeyD: [1, 0],
  KeyW: [0, -1],
  KeyS: [0, 1],
  KeyH: [-1, 0],
  KeyL: [1, 0],
  KeyK: [0, -1],
  KeyJ: [0, 1],
}

// HUD + status system: reports position, visible count; reactive on Changed(Position).
world.system(
  'hud',
  { schedule: 'reactive', reactsTo: Changed(Position) },
  () => {
    const pos = world.getComponent(playerId, Position)
    if (!pos) return
    const visibleCount = world
      .query(Has(Tile))
      .entities.filter((v) => world.getComponent(v.id, Visible)?.seen).length
    statusEl.textContent = `pos: (${pos.x}, ${pos.y})\ntiles seen: ${visibleCount}\ntick: ${world.time.tick}`
  },
)

// Initial render — step once so onRender fires with the starting state.
world.step(0)
statusEl.textContent = `pos: (${world.getComponent(playerId, Position)?.x}, ${
  world.getComponent(playerId, Position)?.y
})\nwelcome!`

// Input → MoveEvent. We read keyDelta.pressed out-of-tick (between turns) and
// issue a turn per press. We also keep a small auto-repeat for held keys.
let lastRepeatAt = 0
const REPEAT_MS = 130

function tryMoveFromKeys(pressed: ReadonlySet<string>, held: ReadonlySet<string>): void {
  for (const code of pressed) {
    const d = KEY_TO_DELTA[code]
    if (d) {
      world.turn(MoveEvent, { entity: playerId, dx: d[0], dy: d[1] })
      lastRepeatAt = performance.now()
      return
    }
    if (code === 'Space' || code === 'Period') {
      world.turn(MoveEvent, { entity: playerId, dx: 0, dy: 0 })
      return
    }
  }
  const now = performance.now()
  if (now - lastRepeatAt >= REPEAT_MS) {
    for (const code of held) {
      const d = KEY_TO_DELTA[code]
      if (d) {
        world.turn(MoveEvent, { entity: playerId, dx: d[0], dy: d[1] })
        lastRepeatAt = now
        return
      }
    }
  }
}

// Drive pressed-delta via onTickStart: every world.step pulls fresh input.
// We need a frame loop to poll input while idle (no turn means no step). So:
// rAF → call world.step(0) just to refresh input snapshot → consume pressed.
function frame(): void {
  requestAnimationFrame(frame)
  // Step once to let the input plugin publish a fresh snapshot at step 0.
  world.step(0)
  const { pressed } = world.input.keyDelta
  const held = world.input.keys
  if (pressed.size > 0 || held.size > 0) {
    tryMoveFromKeys(pressed, held)
  }
}
requestAnimationFrame(frame)
