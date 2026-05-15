# DOMECS Type-System Evaluation

Scope: TypeScript in `packages/domecs`, `packages/domecs-dom`, `packages/domecs-input`,
and the three exemplar apps under `example/`. Snapshot date: 2026-05-15
(commit `claude/evaluate-type-system-PjTTi`).

The codebase is opinionated and tight — `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`,
`noFallthroughCasesInSwitch` are all on in `tsconfig.base.json`. There is
exactly **one** load-bearing `any` in the entire `src/` tree, and it is
documented. The bones are good. What's left is a handful of pockets where
`unknown` is used as a stand-in for "I didn't wire the generic through" —
those are the targets in §3.

---

## 1. Overall verdict: anorexic in three small places, otherwise well-fed

| Area                                | Verdict   | Notes |
|-------------------------------------|-----------|-------|
| Component identity & spawning       | Good      | `ComponentType<T, Name>`, `entry<T>()`, `ComponentEntry<T>` carry T through heterogeneous tuples without `as never` at call sites. |
| Tuple-form query inference          | Good      | `FieldsFromComponents` + `UnionToIntersection` correctly distribute per-element T to per-Name fields. Justified type weight. |
| Event bus typing                    | Good      | `EventType<T>` is nominal via `eventTag` symbol; `EventView.of(T)` returns `readonly T[]`; internal `unknown[]` maps are correctly isolated. |
| Signals                             | Good      | `Signal<T>` / `EmittableSignal<T>` are minimal and fully typed. |
| RNG / time                          | Good      | Concrete shapes; no escape hatches. |
| **System context (`ctx.entities`, `ctx.world`, `ctx.state`)** | **Anorexic** | The two pieces every system body actually touches are typed `unknown`. See §3.1. |
| **Plugin options & snapshot hooks** | **Anorexic** | `Plugin.install(world, options?: unknown)`, `PluginHandle.onSnapshot/onRestore: (snap: unknown) => unknown`. See §3.2. |
| **Capability registry**             | **Anorexic** | `Capability<K extends string>` is literally `{ name: K }`. Every consumer (e.g. `example/roguelike/src/game.ts`) casts `as unknown as { rebuild, at, … }`. See §3.3. |
| DOM `world.ts` globals shim         | Minor smell | `addEventListener: Function` and `globalThis as unknown as { … }`. See §3.4. |

The library is **not bloated**. There is one moderately heavy type
(`FieldsFromComponents` via `UnionToIntersection`) and it pays its rent.

---

## 2. `any` and `unknown` inventory

### 2.1 The only `any` in src/

`packages/domecs/src/types.ts:34-36`:

```ts
export type ComponentBag =
  | ReadonlyMap<ComponentType<unknown>, unknown>
  | ReadonlyArray<ComponentEntry<any>>
```

The accompanying comment explains why `any` (not `unknown`) here:
`ComponentEntry<unknown>` re-introduces the `ComponentType<T>` invariance
assignability failure between tuple elements that `entry<T>()` was built
to avoid. **Keep as-is.** This is a deliberate, documented type-system
escape valve, scoped to a single union variant.

### 2.2 `unknown` usage by category

**Justified — keep:**

- `ComponentType<unknown>` / `ComponentEntry<unknown>` at bag/query boundary
  (`world.ts`, `query.ts`, `types.ts`). These are heterogeneous-collection
  type erasures; `T` cannot be propagated through a `Map<T, V>` where V is
  the union of all component values. The corresponding generic API surface
  (`addComponent<T>`, `getComponent<T>`, `markChanged<T>`, `entitiesWith<T>`,
  the tuple-form `query` overload) re-introduces `T` at call sites.
- `events.ts` internal `Map<symbol, unknown[]>` — heterogeneous-bus storage,
  re-typed at the `of<T>` / `emit<T>` boundary.
- `snapshot.ts` `cloneSerializable<T>` internal `Record<string, unknown>` —
  generic structural clone; unavoidable.
- `world.ts:472,973,1019` `globalThis as unknown as { requestAnimationFrame?, … }`
  — three RAF/visibility shims to dodge the DOM/Node lib mismatch when
  `headless` worlds run under `@types/node`. Could be replaced with a single
  small typed helper (see §3.4) but is not actively harmful.

**Anorexic — should be tightened:**

- `scheduler.ts:21,25,27,51` — `SystemContext.entities: ReadonlyArray<unknown>`,
  `world: unknown`, `state: unknown`, plus `SystemDef.state?: unknown`.
- `plugin.ts:7,15,16,30,54` — `Plugin.install(world, options?: unknown)`,
  `PluginHandle.onSnapshot/onRestore: (snap: unknown) => unknown`,
  `PluginRegistry.use(plugin, options?: unknown)`.
- `plugin.ts:42,45,108` — `Map<string, Record<string, unknown>>` capability
  registry + `as unknown as Capability<K>` cast.

**Minor — could be cleaned up but low priority:**

- `world.ts:976,1021` `addEventListener: Function; removeEventListener: Function`.
  TypeScript flags `Function` as a banned type in stricter lint configs;
  doesn't fail under the current tsconfig but is worth replacing with the
  real DOM types.

### 2.3 Casts (`as unknown as …`) in examples

Four casts in `example/roguelike/src/game.ts` (lines 103, 217, 251, 271)
follow the pattern:

```ts
const cap = world.capability('spatial-index') as unknown as {
  rebuild: () => void
  at: (x: number, y: number) => readonly number[]
  // …
}
```

Every one of these is a direct consequence of §3.3 (Capability is
anorexic). The plugin itself goes through the same dance in
`spatial.ts:62-69` to *publish* the capability. Fixing §3.3 deletes all
five sites.

There are zero `@ts-ignore` / `@ts-nocheck` directives in src/. One
`@ts-expect-error` in a test (`packages/domecs/test/world.basic.test.ts:63`)
asserts a type error, which is the correct use of the directive.

---

## 3. Tightening recommendations, in priority order

### 3.1 Type-parameterize `SystemContext` (highest ROI)

`packages/domecs/src/scheduler.ts:9-28`:

```ts
export interface SystemDef {
  query?: QueryDef
  // …
  state?: unknown
}

export interface SystemContext {
  entities: ReadonlyArray<unknown>
  // …
  world: unknown
  state: unknown
}
```

Every system body (`example/restaurant/src/sim.ts`, `example/dashboard/src/sim.ts`,
`example/roguelike/src/game.ts`) sidesteps the `unknown` by ignoring
`ctx.entities`/`ctx.world` entirely and closing over the outer
`world` / `customers` query references. The provided context is *less typed
than the closure*, which is the giveaway that the generic isn't wired up.

Proposal — make `SystemContext` generic, mirroring the existing tuple-form
query inference:

```ts
export interface SystemContext<Fields = Record<string, unknown>, State = unknown> {
  entities: ReadonlyArray<EntityView<Fields>>
  time:     Readonly<TimeState>
  input:    InputSnapshot
  events:   EventView
  world:    World
  rand:     Rng
  state:    State
}

export type System<Fields = Record<string, unknown>, State = unknown> =
  (ctx: SystemContext<Fields, State>) => void

export interface SystemDef<Fields = Record<string, unknown>, State = unknown> {
  query?:    QueryDef
  // …
  state?:    State
}
```

Add a typed `World.system` overload that mirrors `World.query`'s
tuple-form overload (line 95-98 in `world.ts`), so:

```ts
world.system(
  'movement',
  { query: [Position, Velocity] as const },
  ({ entities }) => {
    // entities: ReadonlyArray<EntityView<{ Position: …; Velocity: … }>>
    for (const e of entities) e.Position.x += e.Velocity.dx
  },
)
```

Notes:

- `world: unknown` is in the type because `scheduler.ts` would otherwise
  cyclic-import `world.ts`. The cycle is type-only — re-importing `World`
  as a `type` is safe (it's already done in `plugin.ts:1`). Switch
  `scheduler.ts` to `import type { World } from './world.js'`.
- The `state?: State` flow is the cleanest place to retire the third
  generic if it turns out callers don't reach for it. But state-bearing
  systems are a documented feature; they should be typed.

This is the single change that yields the most "real code becomes safer"
per line touched.

### 3.2 Type plugin options and snapshot hooks

`packages/domecs/src/plugin.ts:3-7`:

```ts
export interface Plugin {
  readonly name: string
  // …
  install(world: World, options?: unknown): PluginHandle | void
}
```

Two distinct issues here:

**(a) Plugin options.** Today's pattern (`createInputPlugin(opts)` →
`world.use(plugin)`) closes options over the factory, so the `options`
parameter to `install` is effectively dead. But the API also supports
`world.use(plugin, opts)` (see `world.ts:1034`) with `options: unknown`.
Either commit to factory-bound options and drop the `options` parameter
from `Plugin` / `world.use`, or make `Plugin` generic:

```ts
export interface Plugin<O = void> {
  readonly name: string
  install(world: World, options: O): PluginHandle | void
}
```

The factory pattern is currently used by every plugin in the repo, so
dropping the parameter is the simpler move.

**(b) Snapshot hooks.** Lines 15-16:

```ts
onSnapshot?(snap: unknown): unknown
onRestore?(snap: unknown): unknown
```

Then `world.ts:1069,1078`:

```ts
snap = entry.handle.onSnapshot(snap) as WorldSnapshot
// …
s = entry.handle.onRestore(s) as WorldSnapshot
```

`WorldSnapshot` is the only type that flows through here; the `unknown`
is just losing the type at one boundary and reasserting it at the next.
Change the signatures to `(snap: WorldSnapshot) => WorldSnapshot` and
delete both casts. This is a one-line change with no design implications.

### 3.3 Make `Capability<K>` actually typed

`packages/domecs/src/plugin.ts:19-21`:

```ts
export interface Capability<K extends string> {
  readonly name: K
}
```

This is the textbook anorexic type — the value returned at runtime is a
mutable object that consumers attach methods to (`spatial.ts:67-69`), but
the *type* only knows its name. Every read site needs a manual
`as unknown as { … }` ascription.

Two viable improvements:

**Lightweight (declaration-merge friendly):**

```ts
export interface CapabilityMap {}  // module-augmentable
export type Capability<K extends keyof CapabilityMap | string> =
  K extends keyof CapabilityMap ? CapabilityMap[K] & { readonly name: K }
                                : { readonly name: K }
```

Plugins augment a single map instead of the `Capability<K>` interface:

```ts
declare module '@domecs/core' {
  interface CapabilityMap {
    'spatial-index': {
      at(x: number, y: number): readonly number[]
      rebuild(): void
      nearest(x: number, y: number, r: number): number[]
    }
  }
}
```

Result: `world.capability('spatial-index')` returns the typed shape
directly, eliminating four casts in `roguelike/src/game.ts` and one in
`spatial.ts`.

**Stricter:** introduce `defineCapability<T>(name, impl)` and let
`world.capability(name)` look the type up by name. Heavier API change;
only worth doing if capabilities are about to grow more contract.

The lightweight version is the right v0.1 move.

### 3.4 Replace `Function` and shape `globalThis` access

`packages/domecs/src/world.ts:976,1021`:

```ts
document?: { hidden?: boolean; addEventListener: Function; removeEventListener: Function }
```

`Function` is too loose — `(type: string, listener: EventListenerOrEventListenerObject, options?: …) => void`
is the actual shape, and DOM lib already has it. The reason for the
hand-rolled `globalThis as unknown as { … }` shim in three places
(lines 472, 973, 1019) is to avoid pulling DOM globals into headless
contexts. A single typed helper in a sibling file resolves it cleanly:

```ts
// runtime-host.ts
interface RuntimeHost {
  requestAnimationFrame?: (cb: (t: number) => void) => number
  cancelAnimationFrame?:  (h: number) => void
  document?: {
    hidden?: boolean
    addEventListener(type: string, listener: (ev: Event) => void): void
    removeEventListener(type: string, listener: (ev: Event) => void): void
  }
}
export const host = globalThis as unknown as RuntimeHost
```

Three uses → one cast in a named location. Low impact, but the
`Function`-typed entries are the kind of thing a future stricter ESLint
config will catch first.

### 3.5 Minor: `ViewDef<Fields = Record<string, unknown>>` is fine

`packages/domecs-dom/src/view.ts:26` and `query.ts:62,66,78` all default
`Fields` to `Record<string, unknown>`. This is the *correct* default for
combinator-form queries (`And(Has(…), Not(…))`) where tuple-position
inference can't fire. The tuple-form `defineView` overload (lines 44-46
of `view.ts`) restores the typed shape. **No change recommended** — it's
documented at line 16-19 of `view.ts` and behaves correctly.

---

## 4. Bloat check

Searched for: deeply nested generics, conditional-type pyramids, dead
type aliases, redundant overloads.

- `FieldsFromComponents` (`query.ts:38-50`) uses `UnionToIntersection` to
  collapse a distributed union into an intersection. This is the standard
  TypeScript idiom for "per-element field" inference and is unavoidable
  given the structural goal. Worth its weight.
- `defineComponent` (`component.ts:13-24`) has two overloads — one with
  `const Name` for literal-name inference, one without. The comment in
  `doc/api.md:66-69` explains the partial-inference TypeScript limitation
  that forces both forms. Justified.
- `World.query` (`world.ts:95-98`) has the same two-overload pattern for
  the same reason. Justified.
- No dead type aliases found. `QueryDef = QueryShorthand` (`query.ts:18`)
  is a one-line re-export with a meaningful name; keep.
- Module augmentation in `example/roguelike/src/spatial.ts:14-20`
  augments `Capability<K>` with `K extends 'spatial-index' ?: never`
  branches. This is a code smell driven by §3.3 (the spec encourages
  declaration merging on a per-method basis instead of on a single
  capability-shape map). Goes away with §3.3.

No bloat to cut.

---

## 5. Suggested order of operations

1. **§3.2 (b)** — typed snapshot hooks. ~5 lines, zero risk.
2. **§3.3** — `CapabilityMap` augmentation point. Deletes 5 casts in the
   roguelike and unblocks every future plugin from doing the same dance.
3. **§3.1** — generic `SystemContext` + typed `World.system` overload.
   The high-value change. Touch surface is large (every example uses
   `world.system`) but no example actually relies on `ctx.entities`
   being `unknown`, so it's additive.
4. **§3.2 (a)** — decide between dropping `options` from `Plugin` or
   making it generic. Either way, an API decision, not a refactor.
5. **§3.4** — `RuntimeHost` shim. Cosmetic.

After 1-3, the only remaining `unknown` in user-facing types is the one
documented by `ComponentBag`, and the only `as unknown as` left in
example code is gone. That puts the type system on the well-fed side of
the line without adding any new heavy machinery.
