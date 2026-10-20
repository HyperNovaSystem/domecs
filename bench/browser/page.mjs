/**
 * Browser windowed-projection frame (PLAN WS-5 A0). One engine per page
 * load, chosen by ?engine=. Each frame runs the engine's tick (data change
 * plus DOM commit), then forces style and layout by reading offsetHeight,
 * so `frameMs` includes the layout the commit caused. Long Animation Frame
 * entries are collected for attribution when a frame runs long.
 */
const params = new URLSearchParams(location.search)
const engine = params.get('engine') ?? 'domecs'
const n = Number(params.get('n') ?? 2000)
const windowSize = Number(params.get('window') ?? 50)
const frames = Number(params.get('frames') ?? 300)
const warmup = Number(params.get('warmup') ?? 60)

const loaf = []
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) loaf.push(e.duration)
  }).observe({ type: 'long-animation-frame', buffered: true })
} catch {
  // Long Animation Frames unsupported: leave loaf empty.
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : 0
}

try {
  const root = document.getElementById('root')
  const { setup } = await import(`./engines/${engine}.mjs`)
  const harness = await setup({ root, n, windowSize })

  const script = []
  const frame = []
  for (let f = 0; f < warmup + frames; f++) {
    await nextFrame()
    const t0 = performance.now()
    harness.tick()
    const t1 = performance.now()
    void root.offsetHeight // force style + layout for what the tick changed
    const t2 = performance.now()
    if (f === warmup - 1) harness.resetCounts()
    if (f >= warmup) {
      script.push(t1 - t0)
      frame.push(t2 - t0)
    }
  }
  const rows = root.children.length
  window.__benchResult = {
    engine,
    entities: n,
    windowSize,
    frames,
    scriptP50Ms: pct(script, 0.5),
    scriptP95Ms: pct(script, 0.95),
    frameP50Ms: pct(frame, 0.5),
    frameP95Ms: pct(frame, 0.95),
    longAnimationFrames: loaf.length,
    longAnimationFrameMs: Number(loaf.reduce((a, b) => a + b, 0).toFixed(1)),
    domSplit: harness.counts(),
    rowsMounted: rows,
    crossOriginIsolated: self.crossOriginIsolated,
  }
} catch (error) {
  window.__benchResult = { engine, error: String(error?.stack ?? error) }
}
