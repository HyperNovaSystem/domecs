/**
 * Falsifiable cold-agent legibility app (PLAN WS-3).
 *
 * Built from AGENTS.md + skills/domecs/SKILL.md only:
 * createWorld, defineComponent, defineEvent, entry, createAgentBridge,
 * system(event), observe → act → step → snapshot → reset.
 *
 * Resolves @domecs/core from built dist (published layout), not engine src.
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const coreDist = join(root, 'packages/domecs/dist/index.js')
if (!existsSync(coreDist)) {
  console.error('Build @domecs/core first: pnpm --filter @domecs/core build')
  process.exit(1)
}

const {
  createWorld,
  createAgentBridge,
  defineComponent,
  defineEvent,
  entry,
} = await import(pathToFileURL(coreDist).href)

const Score = defineComponent('Score', { defaults: { value: 0 } })
const Add = defineEvent('Add')

const world = createWorld({ headless: true, seed: [11, 22, 33, 44] })
world.system('apply-add', { schedule: 'event', triggers: [Add] }, ({ events, world: w }) => {
  for (const payload of events.of(Add)) {
    for (const id of w.listEntities([Score])) {
      const s = w.getComponent(id, Score)
      if (!s) continue
      s.value += payload.delta
      w.markChanged(id, Score)
    }
  }
})

const entity = world.spawn([entry(Score, { value: 0 })])
const bridge = createAgentBridge(world)
bridge.captureBaseline()

const observation = bridge.observe()
if (!observation.manifest.components.some((c) => c.name === 'Score')) {
  throw new Error('observe() must surface Score via world.describe()')
}

bridge.act(Add, { delta: 5 })
bridge.step()
bridge.act(Add, { delta: 2 })
bridge.step()
const mid = world.getComponent(entity, Score).value
const snapA = JSON.stringify(bridge.snapshot())

bridge.reset()
if (world.getComponent(entity, Score).value !== 0) {
  throw new Error('reset() must restore baseline score 0')
}

bridge.act(Add, { delta: 5 })
bridge.step()
bridge.act(Add, { delta: 2 })
bridge.step()
const finalScore = world.getComponent(entity, Score).value
const snapB = JSON.stringify(bridge.snapshot())

const result = {
  ok: finalScore === 7 && mid === 7 && snapA === snapB,
  finalScore,
  deterministic: snapA === snapB,
  observation: {
    tick: observation.tick,
    entityCount: observation.entityCount,
    hasScoreComponent: true,
  },
}

console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exit(1)
