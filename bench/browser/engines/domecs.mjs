// DOMECS: Row component added/removed as the window moves; a view over
// [Row] creates, updates and removes the DOM rows on each commit.
import { createWorld, defineComponent, entry } from '@domecs/core'
import { defineView, mountDOM } from '@domecs/dom'

export async function setup({ root, n, windowSize }) {
  const Telemetry = defineComponent('Telemetry', { defaults: { value: 0 } })
  const Row = defineComponent('Row', { defaults: { rank: 0, label: '' } })
  const world = createWorld({ headless: true })
  const counts = { create: 0, update: 0, remove: 0 }
  const ids = []
  for (let i = 0; i < n; i++) ids.push(world.spawn([entry(Telemetry, { value: i })]))

  let windowStart = 0
  const visible = new Set()
  world.system('window-project', { schedule: 'tick' }, () => {
    const next = new Set()
    for (let k = 0; k < windowSize; k++) next.add(ids[(windowStart + k) % ids.length])
    for (const id of visible) {
      if (!next.has(id)) {
        world.removeComponent(id, Row)
        visible.delete(id)
      }
    }
    for (const id of next) {
      if (!visible.has(id)) {
        world.addComponent(id, Row, { rank: 0, label: String(world.getComponent(id, Telemetry).value) })
        visible.add(id)
      } else {
        const r = world.getComponent(id, Row)
        r.rank = (r.rank + 1) % 1000
        world.markChanged(id, Row)
      }
    }
    windowStart = (windowStart + 3) % ids.length
  })

  const mounted = mountDOM(world, {
    slots: { list: root },
    views: [
      defineView({
        slot: 'list',
        query: [Row],
        create(e) {
          counts.create++
          const el = document.createElement('div')
          el.className = 'row'
          el.append(document.createElement('span'), document.createElement('span'))
          el.firstChild.textContent = e.Row.label
          return el
        },
        update(el, e) {
          counts.update++
          el.lastChild.textContent = String(e.Row.rank)
        },
        destroy() {
          counts.remove++
        },
      }),
    ],
  })
  if (!mounted.ok) throw new Error(`mountDOM failed: ${JSON.stringify(mounted.error)}`)

  return {
    tick: () => world.step(1 / 60),
    counts: () => ({ ...counts }),
    resetCounts: () => Object.assign(counts, { create: 0, update: 0, remove: 0 }),
  }
}
