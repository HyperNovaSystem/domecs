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

// Long Animation Frame entries, kept with their start times so only the
// measured frames count (not page load, setup or warmup).
const loafEntries = []
let loafSupported = true
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) loafEntries.push({ start: e.startTime, duration: e.duration })
  }).observe({ type: 'long-animation-frame', buffered: true })
} catch {
  loafSupported = false
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
  let measuredFrom = 0
  let measuredTo = 0
  for (let f = 0; f < warmup + frames; f++) {
    const frameStart = await nextFrame()
    if (f === warmup) measuredFrom = frameStart
    const t0 = performance.now()
    harness.tick()
    const t1 = performance.now()
    void root.offsetHeight // force style + layout for what the tick changed
    const t2 = performance.now()
    if (f === warmup - 1) harness.resetCounts()
    if (f >= warmup) {
      script.push(t1 - t0)
      frame.push(t2 - t0)
      measuredTo = t2
    }
  }
  // A LoAF entry is delivered after its frame ends: wait a few frames so the
  // last measured frame's entry arrives before counting.
  for (let i = 0; i < 3; i++) await nextFrame()
  await new Promise((resolve) => setTimeout(resolve, 50))
  // A LoAF starts at its frame's first task, before that frame's rAF
  // timestamp, so attribute by overlap with the measured interval.
  const loaf = loafEntries
    .filter((e) => e.start + e.duration > measuredFrom && e.start <= measuredTo)
    .map((e) => e.duration)
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
    longAnimationFrames: loafSupported ? loaf.length : null,
    longAnimationFrameMs: Number(loaf.reduce((a, b) => a + b, 0).toFixed(1)),
    domSplit: harness.counts(),
    rowsMounted: rows,
    crossOriginIsolated: self.crossOriginIsolated,
  }
} catch (error) {
  window.__benchResult = { engine, error: String(error?.stack ?? error) }
}
