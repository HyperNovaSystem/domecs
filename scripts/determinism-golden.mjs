#!/usr/bin/env node
/**
 * Dual-runtime determinism golden (spec §3.4; plan E8.1).
 *
 *   pnpm --filter @domecs/core build
 *   node scripts/determinism-golden.mjs                   # print one JSON line
 *   node scripts/determinism-golden.mjs --engine <dir>    # @domecs/core from <dir>/@domecs/core/dist
 *   node scripts/determinism-golden.mjs --write           # re-bless test/golden/determinism.json
 *   env ELECTRON_RUN_AS_NODE=1 /path/to/electron scripts/determinism-golden.mjs
 *
 * A plain ESM script with no test framework and no dependency besides the
 * built `@domecs/core` and `@domecs/rules` dists (rules' own `@domecs/core`
 * import is pointed at the same core build by a module resolve hook). It
 * builds fixed headless worlds, steps each 1000 fixed steps, and prints
 *
 *   { "buildId": …, "fixtures": { <name>: <strict hash> }, "dmathFingerprint": …, "dmath2Fingerprint": … }
 *
 * Strict hash = `hashSnapshot(world.snapshot(), { includeChanges: true })`.
 * Fixtures (2.1): `trig` (`dmath.sin` / `dmath.cos`, large arguments),
 * `random` (the shared stream, with spawns and despawns), `own-streams`
 * (`rng: 'own'` systems, a same-name `name#1` key, shared draws between
 * them) and `bounce0` (a bounce at velocity 0 that leaves `-0`, then a
 * sign-sensitive system). `dmathFingerprint` hashes the bit patterns of
 * `dmath.sin` / `dmath.cos` over a fixed input set.
 * 2.2 (plan E10.4) adds two rule-driven fixtures — `rules-chase` (`first`,
 * `atan2`, `hypot`, `countWithin` crowding) and `rules-keep-distance`
 * (`nearest`, `distanceTo`, `pow`, `sum`, `??`) — and `dmath2Fingerprint`
 * (`dmath.atan2` / `hypot` / `pow` bit patterns).
 * 2.3 (plan E18.1) adds `rules-event-chain`: event rules and effects
 * (`emit` chains, `spawn`, `despawn`) whose world is snapshotted at step 500
 * with events in flight (`snapshot({ pendingEvents: true })`, through
 * `canonicalJson` text), restored into a fresh build and stepped to 1000
 * beside the live world; the script throws unless both reach the same strict
 * hash (pending events included), and that hash is the fixture.
 *
 * The test (`test/golden.test.mjs`, `pnpm test:golden`) runs it under Node
 * and, when `DOMECS_ALT_RUNTIME` is set, under that command too, and requires
 * identical output. Studio runs the copy that `pack-for-studio` vendors next
 * to the tarballs with `--engine <its node_modules>` under its pinned
 * Electron (studio spec §10.1 G-engine).
 *
 * Engine paths only: no `Date.now`, no `Math.random`, no platform
 * transcendental. Only `buildId` may differ between builds; regenerate the
 * golden (`--write`) only for a deliberate change, and say so in CHANGELOG.
 */
import fs from 'node:fs'
import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

function usage(message) {
  console.error(message)
  process.exit(2)
}

function parseArgs(argv) {
  const opts = { engine: null, write: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--engine') {
      const dir = argv[++i]
      // Never fall back to the workspace build: studio would then pin
      // whatever sits next to the script instead of the build it installed.
      if (dir === undefined || dir.startsWith('--')) usage('--engine needs a node_modules directory')
      opts.engine = dir
    } else if (argv[i] === '--write') opts.write = true
    else usage(`unknown argument: ${argv[i]}`)
  }
  // Re-blessing writes ../test/golden next to this script: only the
  // workspace copy against its own build may do that, never a vendored copy.
  if (opts.write && opts.engine !== null) usage('--write re-blesses the workspace golden; it cannot be combined with --engine')
  return opts
}

const opts = parseArgs(process.argv.slice(2))
const coreEntry = opts.engine
  ? path.resolve(opts.engine, '@domecs/core/dist/index.js')
  : path.resolve(here, '../packages/domecs/dist/index.js')
if (!fs.existsSync(coreEntry)) {
  console.error(`missing ${coreEntry}; build it (pnpm --filter @domecs/core build) or pass --engine <node_modules dir>`)
  process.exit(2)
}
const rulesEntry = opts.engine
  ? path.resolve(opts.engine, '@domecs/rules/dist/index.js')
  : path.resolve(here, '../packages/domecs-rules/dist/index.js')
if (!fs.existsSync(rulesEntry)) {
  console.error(`missing ${rulesEntry}; build it (pnpm --filter @domecs/rules build) or pass --engine <node_modules dir>`)
  process.exit(2)
}
const coreUrl = pathToFileURL(coreEntry).href
// @domecs/rules imports '@domecs/core': resolve it to the same core build
// (in the workspace it would otherwise reach core's TypeScript source).
register(
  'data:text/javascript,' +
    encodeURIComponent(
      'export async function resolve(specifier, context, next) {' +
        `  if (specifier === '@domecs/core') return { url: ${JSON.stringify(coreUrl)}, shortCircuit: true };` +
        '  return next(specifier, context) }',
    ),
)
const core = await import(coreUrl)
const { BUILD_ID, canonicalJson, createWorld, defineComponent, defineEvent, dmath, entry, hashSnapshot, hashValue } = core
const { installRules } = await import(pathToFileURL(rulesEntry).href)

/** Inputs where V8 13.6 Math.sin (first three) / Math.cos differ from musl by 1 ulp. */
const KNOWN_DIFFERING = [
  -3.952543023042381, 5.6727100582793355, 5.555683663114905,
  2.4444008199498057, 0.7207945035770535, 4.211404654197395,
]
const SEED = [0x9e3779b9, 0x243f6a88, 0xb7e15162, 0x13198a2e]
const STEPS = 1000

/** Step `world` STEPS fixed steps and return its strict hash. */
function run(world) {
  const dt = world.time.fixedStep
  for (let i = 0; i < STEPS; i++) world.step(dt)
  return hashSnapshot(world.snapshot(), { includeChanges: true })
}

// ── trig: dmath.sin / dmath.cos with small and large arguments ──────────

function trig() {
  const Orbit = defineComponent('GoldOrbit', { defaults: { angle: 0, w: 0, r: 0, x: 0, y: 0, s: 0 } })
  const world = createWorld({ headless: true, seed: SEED })
  for (let i = 0; i < 16; i++) {
    // Angles from 0 to ~2^40, so argument reduction takes every branch.
    world.spawn([entry(Orbit, { angle: i * i * i * 1234.5678 * 2 ** (i * 2), w: 0.5 + i * 0.37, r: 1 + i })])
  }
  // Angles where V8 13.6 (Node 24) Math.sin / Math.cos differ from musl by
  // 1 ulp: a platform transcendental here changes the hash on that runtime.
  const Probe = defineComponent('GoldProbe', { defaults: { a: 0, sx: 0, cy: 0 } })
  for (const a of KNOWN_DIFFERING) world.spawn([entry(Probe, { a })])
  world.system('probe', { schedule: 'fixed', query: [Probe] }, (ctx) => {
    for (const e of ctx.entities) {
      const p = e.GoldProbe
      p.sx = dmath.sin(p.a)
      p.cy = dmath.cos(p.a)
      ctx.world.markChanged(e.id, Probe)
    }
  })
  world.system('orbit', { schedule: 'fixed', query: [Orbit] }, (ctx) => {
    for (const e of ctx.entities) {
      const o = e.GoldOrbit
      o.angle += o.w * ctx.time.fixedStep
      o.x = o.r * dmath.cos(o.angle)
      o.y = o.r * dmath.sin(o.angle)
      // Feed results back into an argument: a 1-ulp difference compounds.
      o.s = dmath.sin(o.x * o.y * 1e6 + o.s) + dmath.cos(o.angle * 1e9)
      ctx.world.markChanged(e.id, Orbit)
    }
  })
  return run(world)
}

// ── random: the shared stream, with spawns and despawns ─────────────────

function random() {
  const Walker = defineComponent('GoldWalker', { defaults: { x: 0, y: 0, age: 0 } })
  const world = createWorld({ headless: true, seed: SEED })
  for (let i = 0; i < 8; i++) world.spawn([entry(Walker, { x: i, y: -i, age: 0 })])
  world.system('walk', { schedule: 'fixed', query: [Walker] }, (ctx) => {
    for (const e of ctx.entities) {
      const w = e.GoldWalker
      w.x += ctx.rand.uniform() - 0.5
      w.y += ctx.rand.uniformRange(-1, 1)
      w.age += 1
      ctx.world.markChanged(e.id, Walker)
    }
  })
  world.system('churn', { schedule: 'fixed', query: [Walker] }, (ctx) => {
    if (ctx.rand.uniform() < 0.1 && ctx.entities.length > 2) {
      ctx.world.despawn(ctx.rand.pick(ctx.entities).id)
    }
    if (ctx.rand.uniformInt(10) === 0) {
      ctx.world.spawn([entry(Walker, { x: ctx.rand.uniform() * 10, y: 0, age: 0 })])
    }
  })
  return run(world)
}

// ── own-streams: rng 'own' systems keyed by cursor key ──────────────────

function ownStreams() {
  const Noise = defineComponent('GoldNoise', { defaults: { a: 0, b: 0, c: 0, shared: 0 } })
  const world = createWorld({ headless: true, seed: SEED })
  for (let i = 0; i < 4; i++) world.spawn([entry(Noise, {})])
  const own = (field) => (ctx) => {
    for (const e of ctx.entities) {
      e.GoldNoise[field] += ctx.rand.uniform()
      ctx.world.markChanged(e.id, Noise)
    }
  }
  world.system('noise', { schedule: 'fixed', rng: 'own', query: [Noise] }, own('a'))
  // Shared draws between two own systems must not move either stream.
  world.system('shared', { schedule: 'fixed', query: [Noise] }, (ctx) => {
    for (const e of ctx.entities) {
      e.GoldNoise.shared += ctx.rand.uniform()
      ctx.world.markChanged(e.id, Noise)
    }
  })
  world.system('noise', { schedule: 'fixed', rng: 'own', query: [Noise] }, own('b')) // key noise#1
  world.system('jitter', { schedule: 'fixed', rng: 'own', query: [Noise] }, own('c'))
  return run(world)
}

// ── bounce0: a bounce at velocity 0 leaves -0, then a sign-sensitive rule ─

function bounce0() {
  const Ball = defineComponent('GoldBall', { defaults: { x: 0, vx: 0, y: 0, vy: 0, side: 0, hits: 0 } })
  const world = createWorld({ headless: true, seed: SEED })
  // Balls 0..3 start at rest against the right wall and on the floor: the
  // wall bounce turns their vx of 0 into -0 for good.
  for (let i = 0; i < 8; i++) {
    world.spawn([entry(Ball, { x: i < 4 ? 10 : i, vx: i < 4 ? 0 : 1 - i * 0.3, y: i < 4 ? 0 : i * 2, vy: 0 })])
  }
  world.system('bounce', { schedule: 'fixed', query: [Ball] }, (ctx) => {
    const dt = ctx.time.fixedStep
    for (const e of ctx.entities) {
      const b = e.GoldBall
      b.x += b.vx * dt
      b.y += b.vy * dt
      if (b.x <= 0) {
        b.vx = Math.abs(b.vx) * 0.5
        b.hits += 1
      } else if (b.x >= 10) {
        b.vx = -Math.abs(b.vx) * 0.5 // 0 → -0
        b.hits += 1
      }
      if (b.y <= 0) {
        b.vy = -b.vy * 0.25 // 0 → -0; the resting balls never gain speed
        if (b.y < 0) b.y = 0
      } else {
        b.vy -= 9.8 * dt
      }
      ctx.world.markChanged(e.id, Ball)
    }
  })
  // Sign-sensitive: 1 / -0 is -Infinity, so `side` tells -0 from 0.
  world.system('side', { schedule: 'fixed', query: [Ball] }, (ctx) => {
    for (const e of ctx.entities) {
      const b = e.GoldBall
      b.side += 1 / b.vx > 0 ? 1 : -1
      ctx.world.markChanged(e.id, Ball)
    }
  })
  return run(world)
}

// ── rules-chase: first(), atan2, hypot, countWithin crowding (2.2) ──────

function rulesWorld(types, defs, { events = [], prefabs } = {}) {
  const world = createWorld({ headless: true, seed: SEED })
  if (events.length > 0) {
    const registered = world.register(...events)
    if (!registered.ok) throw new Error(`golden events failed to register: ${JSON.stringify(registered.error)}`)
  }
  const byName = new Map(types.map((t) => [t.name, t]))
  const errors = installRules(world, [], (n) => byName.get(n), {
    order: 'stable',
    rng: 'own',
    spatial: { component: 'GoldPos', cellSize: 4 },
    ...(prefabs ? { prefabs } : {}),
  }).update(defs)
  if (errors.size > 0) throw new Error(`golden rules failed to compile: ${JSON.stringify([...errors])}`)
  return world
}

function rulesChase() {
  const Pos = defineComponent('GoldPos', { defaults: { x: 0, y: 0 } })
  const Steer = defineComponent('GoldSteer', { defaults: { a: 0, speed: 0, d: 0, crowd: 0 } })
  const Player = defineComponent('GoldPlayer', { defaults: { t: 0 } })
  const Chaser = defineComponent('GoldChaser', { defaults: {} })
  const world = rulesWorld(
    [Pos, Steer, Player, Chaser],
    [
      {
        name: 'orbit', schedule: 'fixed', priority: -1, query: ['GoldPlayer', 'GoldPos'],
        actions: [
          { set: 'GoldPlayer.t', expr: 'GoldPlayer.t + 1' },
          { set: 'GoldPos.x', expr: 'cos(GoldPlayer.t * 0.013) * 40 + sin(tick * 0.5) * 0.25' },
          { set: 'GoldPos.y', expr: 'sin(GoldPlayer.t * 0.017) * 40' },
        ],
      },
      {
        name: 'crowd', schedule: 'fixed', query: ['GoldChaser', 'GoldSteer'],
        actions: [
          { set: 'GoldSteer.crowd', expr: 'countWithin(GoldChaser, 3)' },
          { set: 'GoldSteer.speed', expr: '0.6 / (1 + GoldSteer.crowd) + random() * 0.05' },
        ],
      },
      {
        name: 'chase', schedule: 'fixed', query: ['GoldChaser', 'GoldSteer', 'GoldPos'],
        actions: [
          { set: 'GoldSteer.a', expr: 'atan2(first(GoldPlayer).GoldPos.y - GoldPos.y, first(GoldPlayer).GoldPos.x - GoldPos.x)' },
          { set: 'GoldSteer.d', expr: 'hypot(first(GoldPlayer).GoldPos.x - GoldPos.x, first(GoldPlayer).GoldPos.y - GoldPos.y)' },
          { set: 'GoldPos.x', expr: 'GoldPos.x + cos(GoldSteer.a) * min(GoldSteer.speed, GoldSteer.d)' },
          { set: 'GoldPos.y', expr: 'GoldPos.y + sin(GoldSteer.a) * min(GoldSteer.speed, GoldSteer.d)' },
        ],
      },
    ],
  )
  world.spawn([entry(Player, { t: 0 }), entry(Pos, { x: 40, y: 0 })])
  for (let i = 0; i < 32; i++) {
    const a = i * 0.7
    world.spawn([entry(Chaser, {}), entry(Steer, {}), entry(Pos, { x: 60 * dmath.cos(a) + i, y: 60 * dmath.sin(a) - i })])
  }
  return run(world)
}

// ── rules-keep-distance: nearest(), distanceTo, pow, sum, ?? (2.2) ──────

function rulesKeepDistance() {
  const Pos = defineComponent('GoldPos', { defaults: { x: 0, y: 0 } })
  const Bot = defineComponent('GoldBot', { defaults: { d: 0, e: 1, near: -1 } })
  const Coin = defineComponent('GoldCoin', { defaults: { v: 0 } })
  const world = rulesWorld(
    [Pos, Bot, Coin],
    [
      {
        name: 'drift', schedule: 'fixed', query: ['GoldCoin', 'GoldPos'],
        actions: [
          { set: 'GoldPos.x', expr: 'GoldPos.x + (random() - 0.5) * 0.2' },
          { set: 'GoldCoin.v', expr: 'pow(GoldCoin.v + 1, 0.5)' },
        ],
      },
      {
        name: 'keep', schedule: 'fixed', query: ['GoldBot', 'GoldPos'],
        actions: [
          { set: 'GoldBot.near', expr: 'nearest(GoldCoin, 30).id ?? -1' },
          { set: 'GoldBot.d', expr: 'distanceTo(nearest(GoldCoin, 30)) ?? 0' },
          { set: 'GoldPos.x', expr: 'GoldPos.x + (nearest(GoldCoin, 30).GoldPos.x - GoldPos.x) * (GoldBot.d - 5) / max(GoldBot.d, 0.001) * 0.1 ?? GoldPos.x + 0.3' },
          { set: 'GoldPos.y', expr: 'GoldPos.y + (nearest(GoldCoin, 30).GoldPos.y - GoldPos.y) * (GoldBot.d - 5) / max(GoldBot.d, 0.001) * 0.1 ?? GoldPos.y' },
          { set: 'GoldBot.e', expr: 'pow(GoldBot.e, 0.999) + sum(GoldCoin, GoldCoin.v) * 0.000001 + (avg(GoldCoin, GoldCoin.v) ?? 0) * 0.0000001 + pow(1 - GoldBot.d * 0.000000001, 3000000000) * 0.001' },
        ],
      },
    ],
  )
  for (let i = 0; i < 12; i++) world.spawn([entry(Coin, { v: i }), entry(Pos, { x: (i % 4) * 15, y: Math.floor(i / 4) * 15 })])
  for (let i = 0; i < 24; i++) {
    world.spawn([entry(Bot, {}), entry(Pos, { x: (i * 7) % 50 - 5, y: (i * 11) % 40 - 5 })])
  }
  return run(world)
}

// ── rules-event-chain: event rules, effects, a fork with events in flight (2.3) ─

/** Strict hash with the in-flight events: what a fork must reproduce. */
function strictPending(world) {
  return hashSnapshot(world.snapshot({ pendingEvents: true }), { includeChanges: true })
}

function eventChainWorld() {
  const Pos = defineComponent('GoldPos', { defaults: { x: 0, y: 0 } })
  const Cell = defineComponent('GoldCell', { defaults: { charge: 0, hits: 0, last: -1 } })
  const Spark = defineComponent('GoldSpark', { defaults: { life: 0, vx: 0 } })
  const fields = { target: { kind: 'number' }, power: { kind: 'number' } }
  const Ping = defineEvent('GoldPing', { schema: { fields } })
  const Pong = defineEvent('GoldPong', { schema: { fields } })
  const spark = [entry(Spark, {}), entry(Pos, {})]
  const world = rulesWorld(
    [Pos, Cell, Spark],
    [
      {
        // Each cell starts a chain every 37 ticks (staggered by id).
        name: 'kick', schedule: 'fixed', query: ['GoldCell'], when: '(tick + self.id) % 37 == 0',
        actions: [],
        effects: [{ emit: 'GoldPing', payload: { target: 'self.id', power: '0.5 + random() * 0.5' } }],
      },
      {
        // A ping charges its cell, answers the nearest other cell and throws a spark.
        name: 'ping', schedule: 'event', on: 'GoldPing', self: 'event.target', query: ['GoldCell', 'GoldPos'],
        actions: [
          { set: 'GoldCell.charge', expr: 'GoldCell.charge + sin(event.power * 3 + GoldPos.x)' },
          { set: 'GoldCell.last', expr: 'tick' },
        ],
        effects: [
          { emit: 'GoldPong', payload: { target: 'nearest(GoldCell).id ?? event.target', power: 'event.power * (0.8 + random() * 0.15)' } },
          {
            spawn: 'spark',
            at: { x: 'GoldPos.x + cos(GoldCell.charge) * 2', y: 'GoldPos.y + sin(GoldCell.charge) * 2' },
            set: { 'GoldSpark.life': '5 + floor(random() * 20)', 'GoldSpark.vx': 'event.power - 0.5' },
          },
        ],
      },
      { name: 'pong', schedule: 'event', on: 'GoldPong', self: 'event.target', query: ['GoldCell'], actions: [{ set: 'GoldCell.hits', expr: 'GoldCell.hits + 1' }] },
      {
        // The chain decays: a pong relays a ping until its power falls under 0.1.
        name: 'relay', schedule: 'event', on: 'GoldPong', self: 'event.target', query: ['GoldCell'], when: 'event.power > 0.1',
        actions: [],
        effects: [{ emit: 'GoldPing', payload: { target: 'self.id', power: 'event.power' } }],
      },
      {
        name: 'drift', schedule: 'fixed', query: ['GoldSpark', 'GoldPos'],
        actions: [
          { set: 'GoldSpark.life', expr: 'GoldSpark.life - 1' },
          { set: 'GoldPos.x', expr: 'GoldPos.x + GoldSpark.vx * 0.1' },
        ],
      },
      {
        // An expired spark goes (deferred despawn) and pings the first cell weakly.
        name: 'expire', schedule: 'fixed', query: ['GoldSpark'], when: 'GoldSpark.life <= 0',
        actions: [],
        effects: [{ despawn: 'self' }, { emit: 'GoldPong', payload: { target: 'first(GoldCell).id ?? -1', power: '0.05' } }],
      },
    ],
    { events: [Ping, Pong], prefabs: (name) => (name === 'spark' ? spark : undefined) },
  )
  return { world, Pos, Cell }
}

function rulesEventChain() {
  const { world: live, Pos, Cell } = eventChainWorld()
  for (let i = 0; i < 8; i++) live.spawn([entry(Cell, {}), entry(Pos, { x: (i % 4) * 6 - 9, y: Math.floor(i / 4) * 6 })])
  const dt = live.time.fixedStep
  const half = STEPS / 2
  for (let i = 0; i < half; i++) live.step(dt)
  // Fork with events in flight, through the text a studio save would hold.
  const snap = live.snapshot({ pendingEvents: true })
  const inFlight = snap.pendingEvents?.length ?? 0
  if (inFlight === 0) throw new Error('rules-event-chain: no events in flight at the fork point')
  const { world: fork } = eventChainWorld()
  fork.restore(JSON.parse(canonicalJson(snap)))
  for (let i = half; i < STEPS; i++) {
    live.step(dt)
    fork.step(dt)
  }
  const a = strictPending(live)
  const b = strictPending(fork)
  if (a !== b) throw new Error(`rules-event-chain: the fork restored with events in flight diverged (${a} vs ${b})`)
  return a
}

// ── dmath fingerprint ───────────────────────────────────────────────────

function dmathFingerprint() {
  const dv = new DataView(new ArrayBuffer(8))
  const fromWords = (hi, lo) => {
    dv.setUint32(0, hi >>> 0)
    dv.setUint32(4, lo >>> 0)
    return dv.getFloat64(0)
  }
  const hex = (x) => {
    if (Number.isNaN(x)) return 'nan'
    dv.setFloat64(0, x)
    return dv.getUint32(0).toString(16).padStart(8, '0') + dv.getUint32(4).toString(16).padStart(8, '0')
  }
  // mulberry32, integer-only: the inputs are part of the golden.
  let s = 0x2545f491
  const next = () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return (t ^ (t >>> 14)) >>> 0
  }
  const inputs = [0, -0, Infinity, -Infinity, NaN, Math.PI, -Math.PI, Math.PI / 2, 1e-300, 5e-324, 1e300, ...KNOWN_DIFFERING]
  // Finite doubles with exponents spanning subnormal to 2^1023.
  while (inputs.length < 4096) {
    const hi = next() & 0xffefffff // never the all-ones exponent (inf/NaN)
    inputs.push(fromWords(hi, next()))
  }
  // Integer and half-integer multiples of pi/4 up to 2^20.
  for (let k = 1; k <= 1024; k++) inputs.push(k * k * (Math.PI / 4))
  const out = inputs.map((x) => `${hex(x)}:${hex(dmath.sin(x))}:${hex(dmath.cos(x))}`)
  return hashValue(out)
}

// ── dmath 2.2 fingerprint: atan2 / hypot / pow ──────────────────────────

function dmath2Fingerprint() {
  const dv = new DataView(new ArrayBuffer(8))
  const fromWords = (hi, lo) => {
    dv.setUint32(0, hi >>> 0)
    dv.setUint32(4, lo >>> 0)
    return dv.getFloat64(0)
  }
  const hex = (x) => {
    if (Number.isNaN(x)) return 'nan'
    dv.setFloat64(0, x)
    return dv.getUint32(0).toString(16).padStart(8, '0') + dv.getUint32(4).toString(16).padStart(8, '0')
  }
  let s = 0x7f4a7c15
  const next = () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return (t ^ (t >>> 14)) >>> 0
  }
  const specials = [0, -0, 1, -1, 0.5, 2, -3, Infinity, -Infinity, NaN, 5e-324, 1e300]
  const pairs = []
  for (const a of specials) for (const b of specials) pairs.push([a, b])
  // Random finite bit patterns (every exponent), everyday values, and pow
  // bases near 1 with large exponents.
  while (pairs.length < 3072) {
    const k = pairs.length % 3
    if (k === 0) pairs.push([fromWords(next() & 0xffefffff, next()), fromWords(next() & 0xffefffff, next())])
    else if (k === 1) pairs.push([(next() / 2 ** 32 - 0.5) * 20, (next() / 2 ** 32 - 0.5) * 20])
    else pairs.push([fromWords(next() & 1 ? 0x3fefffff : 0x3ff00000, next()), (next() / 2 ** 32 - 0.5) * 2 ** 34])
  }
  const out = pairs.map(([a, b]) => `${hex(a)}:${hex(b)}:${hex(dmath.atan2(a, b))}:${hex(dmath.hypot(a, b))}:${hex(dmath.pow(Math.abs(a), b))}:${hex(dmath.pow(a, b))}`)
  return hashValue(out)
}

const result = {
  buildId: BUILD_ID,
  fixtures: {
    trig: trig(),
    random: random(),
    'own-streams': ownStreams(),
    bounce0: bounce0(),
    'rules-chase': rulesChase(),
    'rules-event-chain': rulesEventChain(),
    'rules-keep-distance': rulesKeepDistance(),
  },
  dmathFingerprint: dmathFingerprint(),
  dmath2Fingerprint: dmath2Fingerprint(),
}

if (opts.write) {
  const goldenFile = path.resolve(here, '../test/golden/determinism.json')
  const golden = {
    note: 'Pinned by scripts/determinism-golden.mjs (spec §3.4). Regenerate with --write only for a deliberate change.',
    fixtures: result.fixtures,
    dmathFingerprint: result.dmathFingerprint,
    dmath2Fingerprint: result.dmath2Fingerprint,
  }
  fs.writeFileSync(goldenFile, `${JSON.stringify(golden, null, 2)}\n`)
  console.error(`wrote ${path.relative(process.cwd(), goldenFile)}`)
}
console.log(JSON.stringify(result))
