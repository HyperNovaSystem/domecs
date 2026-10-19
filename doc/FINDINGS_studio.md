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

**Resolved in 2.1 (O-79, engine milestone E6):** every `RuleError` from
`compileRule` and `RulesHandle.update()` now carries `field: RuleDefPath`
(`'name' | 'schedule' | 'priority' | 'when' | { query: i } | { action: i;
part: 'set' | 'expr' }`), with `position` relative to that part's string.

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

## 2026-10-19 — `validateEventPayload` is not exported from `@domecs/core`

`world.action()` / `bridge.act()` reject a malformed payload for an event
declared with a `schema` (O-39) through `validateEventPayload`
(`packages/domecs/src/events.ts`). The function was `export`ed from its
module but not re-exported from the package entry point
(`packages/domecs/src/index.ts`), so a consumer of the published package
could not call it. Studio needs the same check to validate a command before
sending it (editor forms, the AI harness's act tool) and kept its own copy of
the validator, which can drift from the engine's rules (unknown fields,
`kind` checks, enum `options`) without any test noticing.

**Resolution (engine, 2026-10-19, `feat(core): export validateEventPayload
(studio finding)`):** `@domecs/core` exports
`validateEventPayload(type: EventType<unknown>, payload: unknown): string | null`
under that name (the name the harness spec already uses in §5 for rule
`emit` validation). `null` means valid (always `null` for a schema-less
event); otherwise it returns the reason fragment that `action()` reports as
`invalid payload for "<name>": <fragment>`. Documented in `doc/api.md`
(Events, doctest `validate-event-payload`); API surface updated; test
`packages/domecs/test/validate-event-payload.test.ts` pins the export and its
agreement with `world.action()`. Studio can drop its copy once it pins an
engine build that includes this commit. The 2.2.0 release-candidate tarballs (E13,
`vendor/domecs/domecs-*-2.2.0+g<sha>.tgz` beside the 2.1.0 set) include it;
the 2.1.0+g5cb0290 tarballs studio pins today do not.

**Verify pass (engine, 2026-10-19, `fix(E-fix): validateEventPayload checks
own keys only`):** the unknown-field check used `key in fields`, so a key
inherited from `Object.prototype` (`toString`, `constructor`, `__proto__` as
`JSON.parse` produces it) passed as "declared" and `action()` accepted the
payload. That matters now that studio validates LLM-built act payloads with
it. Conversely an absent declared field named like a prototype member was read
through the chain and rejected. Both checks now use own properties; tests in
`validate-event-payload.test.ts`. If studio's copy mirrors the old `in`
check, it has the same hole until it switches to the export.

**Not changed here:** studio's docs still say engine "milestones E1–E18"
(already noted in the harness spec's revision-3 verification notes). That
text lives in the studio repo; the follow-up (E1–E21) belongs there.

## 2026-10-19 — `walkFieldRefs` is not exported from `@domecs/rules`

Forwarded from studio's H4 notes (`../studio/FINDINGS.md`, H4.1–H4.3: "the
engine repo is read-only for this run"). `walkFieldRefs` lives in
`packages/domecs-rules/src/ast.ts` and is emitted in `dist/ast.js`, but the
package entry (`src/index.ts`) did not re-export it and `exports` has no
subpath, so a consumer of the published package could not import it. Studio's
component-rename rewriting needs the positions of the evaluated entity's own
field reads to splice new names into expressions, and mirrored the walk over
`parseExpression`'s AST instead, which can drift from the engine's walker as
the grammar grows. The 2.2 plan exported `walkComponentRefs` only.

**Resolution (engine, 2026-10-19, `feat(rules): export walkFieldRefs (studio
finding)`):** `@domecs/rules` exports
`walkFieldRefs(node: AstNode, visit: (component, field, pos) => void): void`
from its package entry, unchanged (the harness spec §5.2: "`walkFieldRefs`
keeps its current behaviour: it visits self fields only"). It visits
`C.f` and `self.C.f`, including inside the 2.2 forms' expression arguments
(`nearest(S, Range.r)`, `entity(Target.id)`, `??` operands), in source order
with each read's position; it never visits other entities' fields, sets or
`has` targets. Documented in `doc/api.md` (Rules, cross-entity forms; doctest
`rules-cross-entity`) and the rules README; API surface updated; test
`packages/domecs-rules/test/parser.test.ts` ("the package entry exports
walkFieldRefs…") pins the export.

**For studio:** once expressions use the 2.2 forms, a component rename must
also rewrite member reads (`first(P).C.f`), sets and `has` targets, so it
should visit names with `walkComponentRefs` (every role) plus `without[]`,
as the harness spec §5.2 "Studio" line says; `walkFieldRefs` alone is only
complete for self-only (2.1-style) expressions. **Positions are AST node
positions, not name tokens** (E-fix2 verify): only `C.f` reports the
component token; `self.C.f` reports `self`, `e.C.f` the start of the entity
(`first(`, `entity(`, …), and sets, aggregates and `has` the form's name. A
rename must not splice the new name at `pos` directly: it has to find the
name token from `pos` (for `self.C.f` it follows `self.`; for `e.C.f` it
follows the entity's closing `)` and `.`). The engine does not report name
token positions; if studio wants them, that is an additive engine request
(e.g. a name position on the visit callback) for the owner. Studio can drop its mirror once
it pins an engine build that includes this commit; the 2.2.0 release-candidate
tarballs already in `../studio/vendor/domecs/` (`2.2.0+g4631095`) predate it
and do not export it.
