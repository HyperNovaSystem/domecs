# DOMECS Findings — studio

## 2026-05-13 - release validation must use packed scoped packages

Studio now imports `@domecs/core` and `@domecs/dom`, so it can smoke-test the
public package names. For local development the app can still point at
`file:../domecs/packages/*`, but release validation should stage the app
against packed tarballs. Folder-based npm lockfiles preserve workspace
internals such as `workspace:*`, while packed tarballs prove the publish
metadata, `dist` files, and static Vite build path.

## 2026-05-13 — schema reflection lacks field metadata

`studio` can call `world.componentTypes()` to enumerate guest component types, but the returned `ComponentType` only exposes the name and `create()` helper. DOMECS Studio therefore has to keep its own `ReflectedComponentSchema` registry to know field names, primitive types, enum options, and numeric ranges for inspector widgets.

Suggested follow-up: extend `defineComponent`/`ComponentOptions` with optional serializable schema metadata (or a first-party reflection plugin) so editor/inspector tooling can derive field widgets from the world alone.

## 2026-05-13 — plugin install cannot snapshot through its own onSnapshot hook

The Studio plugin captures an initial guest snapshot during `install()`. Because the plugin registry only adds the plugin after `install()` returns, `world.snapshot()` called inside `install()` does not run that plugin's `onSnapshot` hook. Studio works around this by calling the same redaction helper manually before pushing the initial ring entry.

Suggested follow-up: document this lifecycle ordering explicitly or provide a post-install hook for plugins that need to initialize from their own snapshot policy.

## 2026-05-13 — editor tooling needs a cheap live-entity enumeration API

The Studio entity tree currently uses `guestWorld.snapshot()` as the easiest way to enumerate every live guest entity and its component names. That is semantically wrong for an editor tree: it serializes/clones data, runs snapshot hooks such as Studio's own redaction, skips transient components, and may omit dev-only state that the editor actually wants to display.

Suggested follow-up: add a read-only live enumeration API such as `world.entities()` / `world.entityIds()` plus `world.componentsOf(entity)` that does not clone, serialize, or apply persistence redaction. Editors and devtools need an inspection surface distinct from save/export snapshots.

## 2026-05-13 — raw entity ids are not enough for multi-world references

Studio stores selection, hover, and highlight as editor-side components containing a raw `guestEntityId`. This works for one hosted world, but the reference is ambiguous once an editor can open multiple guest worlds, compare snapshots, or preserve selections across restore/replay. Entity ids are only meaningful inside one world lifetime.

Suggested follow-up: introduce an optional world identity / label and a standard `EntityRef` shape (`{ worldId, entity }`) for tooling. The core can remain numeric-id based internally, but editor-facing APIs and inspector components need scoped references to avoid cross-world confusion.

## 2026-05-13 — diff time-travel has to poll full snapshots

The Studio snapshot ring proves bounded diff-based time travel, but it computes diffs by taking full `world.snapshot()` objects and comparing serialized component values. That is acceptable for an exemplar and tests, but it duplicates work the core already tracks with Added/Removed/Changed sets and becomes too expensive for a 60-second, 60 Hz buffer on large guest worlds.

Suggested follow-up: provide a first-party diff snapshot/ring-buffer API, likely in `@domecs/persist` or `@domecs/inspector`, that consumes core change tracking directly and captures compact component deltas without a full clone each tick. This should include checkpoint policy, restore-from-diff, and plugin redaction hooks.

## 2026-05-13 — snapshot hooks see name-keyed data, not component identity

Studio's redaction hook removes `GuestDebugProbe` by string name from `WorldSnapshot.entities[].components`. By the time `onSnapshot` runs, the hook is operating on plain serialized records, not `ComponentType` identities or schema metadata. This is brittle for renamed components, migrations, and plugins that want to redact by capability or schema flag.

Suggested follow-up: expose snapshot filtering/redaction at the component-type layer before serialization, or include stable component ids/schema metadata in snapshot hook context. A plugin should be able to say "exclude this ComponentType or schema flag" without string-matching serialized component names.

## 2026-05-13 — projection sync wants keyed reconciliation primitives

Studio rebuilds entity-tree, inspector-field, and viewport projection entities by despawning and respawning transient editor entities during each sync. This is easy to reason about, but it causes avoidable structural churn and makes `Added`/`Removed` query traffic noisy in exactly the kind of tool that will run every frame during editing.

Suggested follow-up: add reusable keyed reconciliation helpers for transient projection entities and/or DOMECS DOM views. An editor should be able to reconcile `key -> entity/view` mappings, update components in place, and let removed keys despawn cleanly without every app hand-rolling a mini retained-mode renderer.

## 2026-05-13 — scene restore needs schema/codecs before data is useful

Studio can restore snapshots into an existing demo guest world because all guest `ComponentType` objects have already been registered. A real editor will load arbitrary scene files before all game modules are necessarily active, and the current name-keyed restore path can hold component bags that are difficult to validate, inspect, or migrate until matching component types are registered later.

Suggested follow-up: define an explicit scene-load/schema registry flow: restore should accept or consult component schemas/codecs, report unknown component types, and surface them to tools as inspectable unknown components rather than silently relying on later lazy registration.

## 2026-05-16 — `Plugin.install` Result migration breaks PluginHandle inference for studio bridge

Same drift as in `lighthouse_novel`: `createDomecsStudioPlugin` returned a bare `PluginHandle` from `install`. Under the post-Phase-1 contract the handle must be wrapped in `ok(...)`. The handle's lifecycle methods (`onTickEnd`, `onSnapshot`) also lost their previously inferred parameter types because the bare return shape no longer flows into `PluginHandle`; explicit `World` and `WorldSnapshot` annotations were required to recover the typing.

Suggested follow-up:

- Provide a tiny `definePlugin({ name, install })` helper in `@domecs/core` that wraps a returned object in `ok` and annotates the handle from `PluginHandle`. The repetitive `return ok({ onTickEnd(world: World) {…} })` boilerplate is the kind of papercut a one-line helper removes.
- Inspector/Studio coupling: with `@domecs/inspector` now present in `domecs/packages/`, the Studio bridge should consume `createInspector` instead of re-implementing redaction + ring-buffer snapshots. That migration is its own work item, but it would also close out the v0.2 *"Schema reflection"* and *"Diff-based snapshot ring buffer"* rows from `doc/exemplars.md`.

## 2026-05-16 — studio does not yet consume `@domecs/inspector`

`@domecs/inspector` shipped (see `doc/BETTER_ERRORS.md` Phase 3), but `studio` still wires its own `SnapshotRingBuffer` and `redactDevOnlyState` helpers directly in `src/plugin.ts`. The exemplar therefore demonstrates the *editor* surface (entity tree, component inspector) without exercising the first-party inspector observation surface that real devtools will sit on.

Suggested follow-up: have studio import `createInspector` and project its `InspectorView` into the existing editor entity tree, leaving redaction + ring buffer behavior as a thin app-level wrapper. That converts studio from an isolated demo into the canonical reference integration for `@domecs/inspector`.
