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
