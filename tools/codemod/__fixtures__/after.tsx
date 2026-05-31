import { createWorld, OnAdded, OnChanged, OnChangedResource, Has } from '@domecs/core'
import { createRng } from '@domecs/core'
import { mountDOM } from '@domecs/dom'

// markChanged must survive — it contains "Changed" as a substring but is not an import
function markChanged(entity: number) {
  return entity
}

// World usage
const world = createWorld({})

// These should be renamed (receiver is known world)
const count = world.countEntities(Has(SomeComp))
const views = world.selectViews(Has(SomeComp))

// Rng usage
const rng = createRng(42)
const value = rng.uniform()
const roll = rng.uniformInt(6)

// .step() with no args → stepOnce()
world.stepOnce()

// .step(dt) must survive untouched
world.step(dt)

// SystemDef with suspect keys → flagged
// CODEMOD-REVIEW: SystemDef — check rateHz/triggers/reactsTo are valid for this schedule type in v1.0
const sys = {
  schedule: 'fixed',
  rateHz: 60,
  fn: () => {},
};

// changedOn: [] → flagged (not edited)
// CODEMOD-REVIEW: changedOn:[] → {mode:"legacy"} or {mode:"explicit",types:[...]} (manual migration)
const def = {
  changedOn: [],
  fn: () => {},
};

// mountDOM → flagged (not edited)
// CODEMOD-REVIEW: mountDOM() now returns Result<MountHandle, MountError> — unwrap .value / check isOk()
const handle = mountDOM(document.body, world);

// Added and Changed used as query nodes
const q1 = OnAdded(SomeComp)
const q2 = OnChanged(SomeComp)

// OnChangedResource should already be the new name — no double rename
const q3 = OnChangedResource(SomeRes)
