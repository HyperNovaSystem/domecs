// Koota: the same data operations as bench/baselines/koota.mjs, with the DOM
// written by hand the way a Koota app without a renderer would.
import { createWorld, trait } from 'koota'

export async function setup({ root, n, windowSize }) {
  const Telemetry = trait({ value: 0 })
  const Visible = trait({ rank: 0 })
  const world = createWorld()
  const counts = { create: 0, update: 0, remove: 0 }
  const entities = []
  for (let i = 0; i < n; i++) entities.push(world.spawn(Telemetry({ value: i })))
  const nodes = new Map()

  let windowStart = 0
  const visible = new Set()
  const tick = () => {
    const next = new Set()
    for (let k = 0; k < windowSize; k++) next.add(entities[(windowStart + k) % entities.length])
    for (const e of visible) {
      if (!next.has(e)) {
        e.remove(Visible)
        visible.delete(e)
        nodes.get(e).remove()
        nodes.delete(e)
        counts.remove++
      }
    }
    for (const e of next) {
      if (!visible.has(e)) {
        e.add(Visible({ rank: 0 }))
        visible.add(e)
        const el = document.createElement('div')
        el.className = 'row'
        el.append(document.createElement('span'), document.createElement('span'))
        el.firstChild.textContent = String(e.get(Telemetry).value)
        el.lastChild.textContent = '0'
        root.append(el)
        nodes.set(e, el)
        counts.create++
      } else {
        e.set(Visible, (prev) => ({ rank: ((prev?.rank ?? 0) + 1) % 1000 }))
        nodes.get(e).lastChild.textContent = String(e.get(Visible).rank)
        counts.update++
      }
    }
    windowStart = (windowStart + 3) % entities.length
  }

  return {
    tick,
    counts: () => ({ ...counts }),
    resetCounts: () => Object.assign(counts, { create: 0, update: 0, remove: 0 }),
  }
}
