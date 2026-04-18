# DOMECS v0.1 — Implementation Findings

Log of SPEC/API ambiguities, contradictions, or gaps surfaced while building the alpha engine + roguelike exemplar. Each entry proposes a resolution. Decisions roll into a spec update after the alpha cycle.

Format: `## [F-N] Title` — status (`open` | `resolved` | `deferred`) — date.

---

## [F-1] `ComponentBag` string-keyed form has no registration path

**Status:** resolved — 2026-04-18
**Surfaced by:** `packages/domecs/test/world.basic.test.ts` — "spawn accepts a ComponentBag keyed by ComponentType.name".

**Problem.** `api.md` declares `type ComponentBag = Record<string, unknown>` with keys being `ComponentType.name`. SPEC §2.3 says worlds own their component stores and that *no global mutable state* survives between worlds. There is no specified moment at which a string key (`"Position"`) is bound to its `ComponentType<T>` inside a given world. If `spawn(bag)` is the first mention of the type, the world has never seen the `ComponentType` object, so it cannot look up the type from the string name without either (a) a process-global name→type registry (violates plural-worlds axiom), or (b) an eager registration step the SPEC does not describe.

**Resolution.** Redefine `ComponentBag` as identity-keyed, not name-keyed:

```ts
type ComponentBag =
  | ReadonlyMap<ComponentType<unknown>, unknown>
  | ReadonlyArray<readonly [ComponentType<unknown>, unknown]>
```

This removes the lookup ambiguity and keeps worlds self-contained. The `Record<string, unknown>` sugar can return post-alpha once a `createWorld({ components: [...] })` eager-registration option is specified. For alpha we use the identity form exclusively; the quick-start example in `api.md` (`Position: { x, y }`) should be treated as pseudocode pending that follow-up.

**Spec impact.** `api.md` §`World.spawn` + `ComponentBag` type. No SPEC normative-text impact beyond §2.3 staying intact.
