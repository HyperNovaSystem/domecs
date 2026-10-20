// Plain JS: an array of records and hand-written DOM, no framework.
export async function setup({ root, n, windowSize }) {
  const counts = { create: 0, update: 0, remove: 0 }
  const records = []
  for (let i = 0; i < n; i++) records.push({ id: i, value: i, rank: 0, el: null })

  let windowStart = 0
  const visible = new Set()
  const tick = () => {
    const next = new Set()
    for (let k = 0; k < windowSize; k++) next.add(records[(windowStart + k) % records.length])
    for (const r of visible) {
      if (!next.has(r)) {
        visible.delete(r)
        r.el.remove()
        r.el = null
        counts.remove++
      }
    }
    for (const r of next) {
      if (!visible.has(r)) {
        visible.add(r)
        r.rank = 0
        const el = document.createElement('div')
        el.className = 'row'
        el.append(document.createElement('span'), document.createElement('span'))
        el.firstChild.textContent = String(r.value)
        el.lastChild.textContent = '0'
        root.append(el)
        r.el = el
        counts.create++
      } else {
        r.rank = (r.rank + 1) % 1000
        r.el.lastChild.textContent = String(r.rank)
        counts.update++
      }
    }
    windowStart = (windowStart + 3) % records.length
  }

  return {
    tick,
    counts: () => ({ ...counts }),
    resetCounts: () => Object.assign(counts, { create: 0, update: 0, remove: 0 }),
  }
}
