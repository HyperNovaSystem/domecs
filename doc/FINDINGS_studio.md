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
