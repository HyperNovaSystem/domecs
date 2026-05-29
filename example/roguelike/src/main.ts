import { And, Changed, describeError, Has, tapErr, Where, type EntityView } from '@domecs/core'
import { defineView, mountDOM } from '@domecs/dom'
import { createInputPlugin } from '@domecs/input'
import {
  Actor,
  attemptMove,
  cameraOrigin,
  createRoguelike,
  enemyCount,
  Highlight,
  isWaitKey,
  movementDeltaFromKeys,
  Player,
  Position,
  Renderable,
  Resource,
  resourceCount,
  Tile,
  Visible,
} from './index.js'

const CELL = 16
const VIEW_W = 48
const VIEW_H = 32

const worldSlot = document.getElementById('world') as HTMLElement
const actorSlot = document.getElementById('actors') as HTMLElement
const viewport = document.getElementById('viewport') as HTMLElement
const statusEl = document.getElementById('status') as HTMLElement

viewport.style.width = `${VIEW_W * CELL}px`
viewport.style.height = `${VIEW_H * CELL}px`
document.documentElement.style.setProperty('--cell', `${CELL}px`)

const { world, playerId, width, height } = createRoguelike({ seed: 0xbadb01 })
worldSlot.style.width = `${width * CELL}px`
worldSlot.style.height = `${height * CELL}px`
actorSlot.style.width = `${width * CELL}px`
actorSlot.style.height = `${height * CELL}px`

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

function applyCamera(): void {
  const pos = world.getComponent(playerId, Position)
  if (!pos) return
  const camera = cameraOrigin({
    mapWidth: width,
    mapHeight: height,
    viewWidth: VIEW_W,
    viewHeight: VIEW_H,
    playerX: pos.x,
    playerY: pos.y,
  })
  const transform = `translate(${-camera.x * CELL}px, ${-camera.y * CELL}px)`
  worldSlot.style.transform = transform
  actorSlot.style.transform = transform
}

const actorView = defineView({
  slot: 'actors',
  query: Has(Renderable),
  changedOn: [Position, Highlight, Visible],
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
  const actor = world.getComponent(e.id, Actor)
  const isPlayer = world.has(e.id, Player)
  const isResource = world.has(e.id, Resource)
  const visible = isPlayer || !!world.getComponent(e.id, Visible)?.seen
  if (pos) el.style.transform = `translate(${pos.x * CELL}px, ${pos.y * CELL}px)`
  el.classList.toggle('player', isPlayer)
  el.classList.toggle('enemy', actor?.faction === 'monster')
  el.classList.toggle('resource', isResource)
  el.classList.toggle('hidden', !visible)
  el.classList.toggle('highlight', world.has(e.id, Highlight))
}

mountDOM(world, {
  slots: { world: worldSlot, actors: actorSlot },
  views: [tileView, actorView],
})

// BETTER_ERRORS — input failure is data; play continues in read-only mode.
// tapErr (#5) runs the side effect on the Err branch and passes the Result
// through; describeError (#4) renders the closed DomecsError union so the app
// no longer maintains a parallel case table.
tapErr(
  world.use(
    createInputPlugin({
      // Treat arrow keys, space, WASD as handled — prevent browser scroll.
      preventDefaultKeys: true,
    }),
  ),
  (e) => console.error('domecs: input plugin failed to install:', describeError(e)),
)

function paintStatus(): void {
  const pos = world.getComponent(playerId, Position)
  if (!pos) return
  // Leak-free one-shot count (#13): no live query registered per repaint.
  const visibleCount = world.count(And(Has(Tile), Where(Visible, (v) => v.seen)))
  statusEl.textContent = [
    `map: ${width}×${height}`,
    `view: ${VIEW_W}×${VIEW_H}`,
    `pos: (${pos.x}, ${pos.y})`,
    `tiles seen: ${visibleCount}`,
    `enemies: ${enemyCount(world)}`,
    `resources: ${resourceCount(world)}`,
    `tick: ${world.time.tick}`,
  ].join('\n')
}

// HUD/status is a nice fit for the new observe(...) sugar: update only after
// player movement rather than wiring an explicit reactive system by hand.
world.observe(And(Has(Position), Changed(Position)), {
  onChange: (e) => {
    if (e.id === playerId) {
      applyCamera()
      paintStatus()
    }
  },
})

// Initial render — step once so onRender fires with the starting state.
// Enable motion only after the initial camera snap so page load does not pan
// from map origin to the player.
world.step(0)
applyCamera()
viewport.classList.add('motion-ready')
paintStatus()
statusEl.textContent += '\nwelcome!'

// Input → MoveEvent. We read keyDelta.pressed out-of-tick (between turns) and
// issue a turn per press. We also keep a small auto-repeat for held keys.
let lastRepeatAt = 0
const REPEAT_MS = 130

function flashBlocked(): void {
  // A blocked move does not change Position, so the observe(Changed(Position))
  // repaint never fires — append the hint directly; the next accepted move
  // rebuilds the status line and clears it.
  statusEl.textContent += '\n⊘ blocked'
}

function tryMoveFromKeys(pressed: ReadonlySet<string>, held: ReadonlySet<string>): void {
  if (pressed.size > 0) {
    const d = movementDeltaFromKeys(pressed, held)
    if (d) {
      // world.action (#17): a structured verdict for the player command. A move
      // into a wall/edge is rejected and the turn is not consumed, so flash.
      const r = attemptMove(world, playerId, d[0], d[1])
      if (!r.accepted) flashBlocked()
      lastRepeatAt = performance.now()
      return
    }
    for (const code of pressed) {
      if (isWaitKey(code)) {
        attemptMove(world, playerId, 0, 0)
        return
      }
    }
  }

  const now = performance.now()
  if (now - lastRepeatAt >= REPEAT_MS) {
    const d = movementDeltaFromKeys(new Set(), held)
    if (d) {
      // Auto-repeat: don't flash on every blocked repeat frame.
      attemptMove(world, playerId, d[0], d[1])
      lastRepeatAt = now
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
