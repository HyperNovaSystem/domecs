import { defineComponent } from 'domecs'

export const Position = defineComponent<{ x: number; y: number }>('Position', {
  defaults: { x: 0, y: 0 },
})

export const Tile = defineComponent<{ kind: 'floor' | 'wall' }>('Tile', {
  defaults: { kind: 'floor' },
})

export const Actor = defineComponent<{ name: string; hp: number; faction: 'player' | 'monster' }>(
  'Actor',
  { defaults: { name: '', hp: 1, faction: 'monster' } },
)

export const Player = defineComponent<Record<string, never>>('Player', { defaults: {} })

export const Visible = defineComponent<{ seen: boolean }>('Visible', { defaults: { seen: false } })

export const Renderable = defineComponent<{ glyph: string }>('Renderable', {
  defaults: { glyph: '.' },
})

/** Transient marker: set when the UI is showing this entity, reset each tick. */
export const Highlight = defineComponent<{ color: string }>('Highlight', {
  transient: true,
  defaults: { color: 'yellow' },
})
