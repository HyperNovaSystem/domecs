import { defineComponent } from '@domecs/core'

export const Position = defineComponent<{ x: number; y: number }>('Position', {
  defaults: { x: 0, y: 0 },
  validate: (value) => {
    if (!Number.isInteger(value.x)) return 'x must be an integer'
    if (!Number.isInteger(value.y)) return 'y must be an integer'
    return true
  },
})

export const Tile = defineComponent<{ kind: 'floor' | 'wall' }>('Tile', {
  defaults: { kind: 'floor' },
  validate: (value) => (value.kind === 'floor' || value.kind === 'wall') || 'tile kind must be "floor" or "wall"',
})

export const Actor = defineComponent<{ name: string; hp: number; faction: 'player' | 'monster' }>(
  'Actor',
  {
    defaults: { name: '', hp: 1, faction: 'monster' },
    validate: (value) => {
      if (typeof value.name !== 'string') return 'name must be a string'
      if (!Number.isFinite(value.hp) || value.hp <= 0) return 'hp must be a positive finite number'
      if (value.faction !== 'player' && value.faction !== 'monster') return 'faction must be "player" or "monster"'
      return true
    },
  },
)

export type ResourceKind = 'food' | 'gold' | 'crystal'

export const Resource = defineComponent<{ kind: ResourceKind; amount: number }>('Resource', {
  defaults: { kind: 'food', amount: 1 },
  validate: (value) => {
    if (value.kind !== 'food' && value.kind !== 'gold' && value.kind !== 'crystal') {
      return 'resource kind must be "food", "gold", or "crystal"'
    }
    if (!Number.isInteger(value.amount) || value.amount <= 0) return 'amount must be a positive integer'
    return true
  },
})

export const Player = defineComponent<Record<string, never>>('Player', { defaults: {} })

export const Visible = defineComponent<{ seen: boolean }>('Visible', {
  defaults: { seen: false },
  validate: (value) => typeof value.seen === 'boolean' || 'seen must be a boolean',
})

export const Renderable = defineComponent<{ glyph: string }>('Renderable', {
  defaults: { glyph: '.' },
  validate: (value) => (typeof value.glyph === 'string' && value.glyph.length > 0) || 'glyph must be a non-empty string',
})

/** Transient marker: set when the UI is showing this entity, reset each tick. */
export const Highlight = defineComponent<{ color: string }>('Highlight', {
  transient: true,
  defaults: { color: 'yellow' },
  validate: (value) => (typeof value.color === 'string' && value.color.length > 0) || 'color must be a non-empty string',
})
