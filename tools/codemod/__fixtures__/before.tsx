import { createWorld, Added, Changed, OnChangedResource, Has } from '@domecs/core'
import { createRng } from '@domecs/core'
import { mountDOM } from '@domecs/dom'

// markChanged must survive — it contains "Changed" as a substring but is not an import
function markChanged(entity: number) {
  return entity
}

// World usage
const world = createWorld({})

// These should be renamed (receiver is known world)
const count = world.count(Has(SomeComp))
const views = world.select(Has(SomeComp))

// Rng usage
const rng = createRng(42)
const value = rng.next()
const roll = rng.int(6)

// .step() with no args → stepOnce()
world.step()

// .step(dt) must survive untouched
world.step(dt)

// SystemDef with suspect keys → flagged
const sys = {
  schedule: 'fixed',
  rateHz: 60,
  fn: () => {},
}

// changedOn: [] → flagged (not edited)
const def = {
  changedOn: [],
  fn: () => {},
}

// mountDOM → flagged (not edited)
const handle = mountDOM(document.body, world)

// Added and Changed used as query nodes
const q1 = Added(SomeComp)
const q2 = Changed(SomeComp)

// OnChangedResource should already be the new name — no double rename
const q3 = OnChangedResource(SomeRes)
