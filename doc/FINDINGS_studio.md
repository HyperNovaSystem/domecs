# DOMECS Studio — findings surfaced against `@domecs/*`

Engine-side deficiencies discovered while building `../studio` (the exemplar
app). One entry per gap; app-observable symptoms and workarounds live in
`../studio/FINDINGS.md`, cross-referenced here where relevant. The curated
cross-app synthesis in this repo's root `FINDINGS.md` draws from files like
this one.

## 2026-07-25 — re-registering an existing component-type name does not update its live shape

`registerComponentTypes` (`packages/domecs-persist/src/schema.ts`) calls
`defineComponent()` fresh on every invocation, producing a new object
identity even when `name` is unchanged. `World` rejects a second distinct
`ComponentType` object sharing a name already registered in that world
(`world.ts`: "two distinct ComponentType objects share the name"). Studio's
`catalog.ts` (`reload()`) works around this by keeping whichever
`ComponentType` object first registered under a given name for the lifetime
of the `World`, discarding every subsequent `registerComponentTypes()` call's
freshly-defined object for names it has already seen.

Net effect: once a world has resolved a custom component type name once,
editing that type's **field shape** (same name, different `fields`) and
calling `reload()`/re-registering again does **not** propagate to the live
`ComponentType` — the world keeps serving the original field schema/defaults
until the world (and its catalog) are torn down and rebuilt from scratch
(e.g. app restart, or a fresh `createCatalog`/`World`). Only entirely new
names, or a name never previously resolved in that world, pick up correctly.

**Impact on Studio:** `catalog.registeredTypes()` reflects the live world and
can therefore show stale field metadata for a custom type immediately after
editing it, even though `session.doc.componentTypes` (the persisted source of
record) is already correct. Studio's M3 UI works around this for its own
Component Types panel by reading `session.doc.componentTypes` directly
instead of `registeredTypes()` (see `studio/src/panels/componentTypes.ts`),
but the Entity Types panel's component picker/defaults editor still uses
`registeredTypes()` (it needs built-ins too, which are never in
`session.doc`) and can show a stale field list for a just-edited custom type
within the same session. See `../studio/FINDINGS.md` for the app-observable
symptom.

**Suggested engine fix (not built here — Studio only consumes the public
API):** give `World` (or `defineComponent`) a way to update an
already-registered `ComponentType`'s schema/defaults in place by name,
instead of only accepting-or-rejecting a second distinct object under that
name. Out of scope for the Phase-1 Studio milestones; flagged for whoever
picks up engine-side component-type mutation.

## 2026-07-25 — composeTransforms only populates `World_` on a tick — no way to prime it without advancing `world.time.tick`

`composeTransforms` (`packages/domecs-scene/src/compose-transforms.ts`)
registers its resolver as a `{ schedule: 'tick' }` system — the only way to
run it is `world.step(dt)` / `world.stepOnce()`, both of which unconditionally
`time.tick += 1` (`world.ts`'s shared tick implementation) and run every
other tick-schedule system too, not just this one. There is no lower-level
"run this one system now" or "prime derived state without advancing time"
primitive on `World`.

**Impact on Studio:** a freshly spawned or freshly `restore()`d entity has no
`World_` component at all until the host world's *next* tick — even though
its `Local` value (and, for a root entity, therefore its true world value
too) has existed since spawn. Studio wired `composeTransforms` onto
`guestWorld` in M5 and switched its stage render to the composed
`WorldTransform`, but `createDomecsStudio()` never ticks the guest world on
construction (only user-driven Step/Play do), so the viewport would render
nothing at all immediately after load. Worked around app-side with a
`WorldTransform ?? GuestTransform` fallback (correct for roots by
construction; briefly approximate for an already-parented entity until the
next tick) rather than forcing a `stepOnce()` at construction time, which
would have muddied `time.tick`/history-checkpoint counts and run every other
`'tick'` system (e.g. this app's own demo motion system) as an unwanted side
effect just to warm up one derived component. See `../studio/FINDINGS.md`
("WorldTransform is unpopulated until the guest world's first tick") for the
app-observable symptom and workaround.

**Suggested engine fix (not built here):** either (a) let a plugin's
`install()` run its system once synchronously at install time (opt-in, e.g.
`composeTransforms(..., { primeOnInstall: true })`), or (b) expose a
`world.runSystem(name)` / `world.runSchedule(schedule)` primitive that runs
matching systems without touching `time.tick` or any other schedule — either
would let a derived-component plugin populate itself for entities that exist
at install time, and let a host app (like Studio) prime post-`restore()`
state on demand, without the caller having to reason about tick/history side
effects just to warm up one value.

## 2026-07-25 — `RuleError` has no field-level tag, so a per-field UI must re-derive attribution itself

`compileRule` (`packages/domecs-rules/src/rules.ts`) aggregates every defect
found while compiling one `RuleDef` — a bad `when`/action `expr` syntax error,
an unresolvable `Component` name in `query`/`when`/an action's `expr`, or a
malformed action `set` target — into a single flat `RuleError[]`, each entry
carrying only `{ rule, position, message }`. `position` is a character offset
*within whichever individual expression string produced it* (or `-1` for a
non-expression defect like a bad `query[i]` entry or `set` shape), but
nothing in the error says *which* expression that was: not `"when"` vs.
`"actions[2].expr"`, not an action index, nothing. For a rule with several
actions plus a `when`, a caller holding just the `RuleError[]` cannot tell
which specific input widget a given error belongs to without independently
re-parsing/re-resolving each field itself and comparing.

**Impact on Studio:** the Systems panel (`studio/src/panels/systems.ts`)
wants an inline error next to the *specific* `when`/action `expr`/action
`set` field the user is editing, live as they type. Since `compileRule`'s
aggregate result can't be attributed back to one field, Studio does not use
it for this — it calls `parseExpression` directly per field for syntax
feedback, and duplicates `compileRule`'s own tiny action-`set`-shape check
(`must be "Component.field"`) locally, both by necessity rather than choice.
Component-resolution errors (an unknown `Component` name) are consequently
*not* shown inline at all in Studio today — they only surface in aggregate,
per-rule, through `RulesHandle.update()`'s returned map, via the app's
problems strip. See `../studio/FINDINGS.md` for the reworked Systems panel
this decision shaped, and `../studio/PLAN.md`'s M7 entry for the milestone
that surfaced it.

**Suggested engine fix (not built here):** tag each `RuleError` with which
part of the `RuleDef` it came from — e.g. `field: 'when' | { action: number;
part: 'set' | 'expr' }` alongside the existing `position`/`message` — so a
caller can route each error to the right widget directly instead of
re-deriving that mapping with its own parallel (and necessarily
simplified/duplicated) validation pass.

## 2026-07-25 — `@domecs/dom`'s `mountDOM` has no caller-invoked "patch now" entry point, and a heartbeat step used to fake one re-fires `tickEnd`

Evaluated `packages/domecs-dom` (`mountDOM`/`defineView`) as the
implementation for Studio's M8 keyed `.stage` sprite patcher before hand-
rolling one; did not use it, for two related reasons.

`mountDOM(world, { slots, views })` paints entirely from the *world's own*
render phase — `plugins.callRender(world)` inside `runTick`, reached only via
`world.step(dt)` / `world.stepOnce()`. There is no lower-level "run the
renderer plugin's `onRender` now" primitive a caller can invoke directly and
synchronously. A host that needs to force an immediate repaint outside the
world's own tick cadence — e.g. right after re-mounting into a freshly
recreated DOM container, before the next natural tick — has only one lever:
an explicit `dt<=0` "heartbeat" `world.step(0)`, which the engine's own F-6
contract documents as running "plugin hooks, signals, and onRender" with no
system execution and no change-detection buffer swap.

The problem: that heartbeat **still emits `sigTickEnd`** (`world.ts`'s
`runTick`, the `dt <= 0` branch calls `plugins.callTickEnd(world)` then
`sigTickEnd.emit(time)` same as a real tick). Any host that has wired its own
UI re-render off `world.signals.tickEnd` — exactly Studio's `main.ts`
(`guestWorld.signals.tickEnd.subscribe(() => { sync(); render(); ... })`) —
would have that subscriber re-invoked *from inside* the very re-render path
that triggered the forced heartbeat, a synchronous re-entrancy hazard with no
guard against it in either `world.ts` or `@domecs/dom`.

**Impact:** not a Studio-observable bug today (Studio didn't adopt
`mountDOM` — see `../studio/FINDINGS.md`'s M8 entry for the full comparison
and the hand-rolled patcher it used instead), but it is a real integration
hazard for *any* `@domecs/dom` consumer that also drives its own re-render
off `tickEnd` and ever needs a forced off-cycle repaint (e.g. after
re-parenting a mounted slot).

**Suggested engine fix (not built here):** give `World` a "run the render
phase now" primitive distinct from `step`/`stepOnce` — one that invokes
`plugins.callRender(world)` (and, if `@domecs/dom` needs it, nothing else:
no `tickStart`/`tickEnd` signal, no system execution) so a host can force an
immediate repaint without also re-triggering every `tickEnd`-driven side
effect it or its plugins have wired up. `step(dt)`'s own public doc comment
already flags the heartbeat case ("`dt <= 0` → heartbeat: plugin hooks +
render fire, but system execution and change-detection buffer swap are
skipped") but doesn't say "signals" the way the internal `runTick` F-6
comment does — worth naming `tickEnd`/`tickStart` explicitly there too, so a
consumer discovers this specific hazard from the public signature alone
rather than needing to read `runTick`'s implementation.
