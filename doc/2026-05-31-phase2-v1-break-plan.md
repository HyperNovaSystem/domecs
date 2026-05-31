# Phase 2 — Coordinated v1.0 Break Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the single coordinated v1.0 breaking change for `@domecs/*` — the naming sweep (design §4) + type-strengthening (§5) + error legibility (§6 error bullet) — then migrate every consumer repo lockstep behind a no-push gate.

**Architecture:** One branch off `main`. Engine renames land one symbol-family per TDD task; each task updates the symbol + the engine's own tests, regenerates the committed `doc/api-surface/*.d.ts` (the no-drift gate turns each rename into a reviewed surface diff), and commits. After the engine surface is final, build a shared codemod + a `repo × change` coverage matrix, then instantiate the §10.4 consumer-upgrade runbook per repo. **The engine branch is not pushed to `main` until every consumer is green** (lockstep — §8).

**Tech Stack:** TypeScript 5.9.3 (pinned via lockfile), pnpm@10.30.2 workspace, vitest (package tests `packages/*/test/*.test.ts`), node:test (repo tests `test/*.test.mjs`), `pnpm api:surface` / `pnpm api:check` (Phase 0 contract harness).

---

## Scope boundary (read first)

This plan is **the engine break + its tooling**. Specifically in-scope:

- §4 naming sweep (RNG, query nodes, world accessors, driver).
- §5 type-strengthening (`SystemDef` union, `changedOn` union, one-shot selector narrowing, `mountDOM → Result`, `DomecsError` closure JSDoc).
- §6 **error bullet only** (`retryable` on all variants, `idempotent?` on `SystemFault`, `getErrorRepairHint`, `ERROR_KINDS`, `isKnownDomecsErrorKind`).
- API-surface regeneration + `LEGIBILITY.md` enforcement-marker flip (⏳→✅ for L3/L4/L5).
- The shared codemod + coverage matrix + per-repo consumer migration (gated).

**Explicitly NOT in this plan** (Phase 3+, additive — do not pull forward): `describeResource`/`resourceTypes`/`describeEvent`/`world.describe()`/`WorldManifest`, event payload schemas, inspector `export()`, `defineEvent` schema arg, doctests, `api.md` sync, `createPersistence` facade deletion.

**Already satisfied — verified during discovery (2026-05-31), no task needed:**
`InternalComponentType` and `internal()` are **already not exported** from `packages/domecs/src/index.ts` (only `component.ts` exports them, consumed solely inside `world.ts` via the sibling import `./component.js`). `world.describeComponent(type): ComponentDescriptor` already exists, is implemented (`world.ts:1059`) and tested (`describe-component.test.ts`); `ComponentDescriptor`/`ComponentSchema`/`FieldSchema`/`FieldKind` are already exported (`index.ts:53-56`). The §6 "remove `InternalComponentType` from the public barrel" item is therefore a no-op — Task 10 records this, it does not change code.

---

## Call-site inventory (discovery, 2026-05-31 — real, used by the tasks below)

All paths relative to `C:\dev\HyperNova\domecs`. "External" = outside the symbol's own def file; consumer-app repos are **not** counted here (they are the codemod's job, Task 12–13).

| Family | Symbol | Def | Rename | External engine+test sites |
|--------|--------|-----|--------|----------------------------|
| RNG | `next` | `rng.ts:4`/`:64` | `uniform` | `rng.test.ts` (9), `snapshot.test.ts` (lines 76,78,82), `world.rand-time.test.ts` (9,16,17); + internal `rng.ts:72,75` |
| RNG | `int` | `rng.ts:5`/`:68` | `uniformInt` | `rng.test.ts:25`; + internal `rng.ts:79,82` |
| RNG | `range` | `rng.ts:6`/`:74` | `uniformRange` | none (interface + body only) |
| RNG | `roll` | `rng.ts:8`/`:81` | `uniformRoll` | `rng.test.ts:36` |
| RNG | `pick`/`fork`/`seed` | — | **keep** | — |
| Query | `Added` | `query.ts:108` | `OnAdded` | `oneshot-query.test.ts:110,115,120`, `query.test.ts:212` |
| Query | `Removed` | `query.ts:111` | `OnRemoved` | `query.test.ts:226` |
| Query | `Changed` | `query.ts:105` | `OnChanged` | `domecs-dom/src/mount.ts:60`, `domecs-inspector/src/inspector.ts:193`, `query.test.ts:193,242`, `scheduler.test.ts:183,207,239,246(x2),266,289,314` |
| Query | `ChangedResource` | `query.ts:131` | `OnChangedResource` | `resources.test.ts:69,85,101,119,137,153,165,166,167` |
| Query | `Has`/`Where`/`Not`/`And`/`Or` | `query.ts:93-114` | **keep** | — |
| World | `resource` | iface `world.ts:152`, impl `:1011` | `getResource` | `resources.test.ts:13,19,26,33,34,35,41,42,140,190,191,199,215` |
| World | `count` | iface `:223`, impl `:1165` | `countEntities` | `oneshot-query.test.ts:19,20,21,29,30,31,38,48,60,110`, `resources.test.ts:165` |
| World | `entitiesMatching` | iface `:224`, impl `:1179` | `listEntities` | `oneshot-query.test.ts:62,77,85,120`, `resources.test.ts:166` |
| World | `select` | iface `:225-228`, impl `:1192` | `selectViews` | `oneshot-query.test.ts:61,93,102,115`, `resources.test.ts:167` |
| World | `entitiesWith` | iface `:194`, impl `:1041` | `iterEntitiesWith` | `world.basic.test.ts:98,108` |
| Driver | `start` | iface `:254`, impl `:1452` | `startLoop` | `lifecycle.test.ts` (17 sites), `code-review-fixes.test.ts:234`, `headless-import.test.ts:44` |
| Driver | `step(dt?)` | iface `:241`, impl `:1277` | `step(dt)` + new `stepOnce()` | 164 external (see Task 4 for the no-arg vs arg split); internal `world.ts:875,1415,1422,1433` |

`World` is a TS **interface** (`world.ts:118`, re-exported `index.ts:21`); the implementation is the `const world: World = {…}` object literal inside `createWorld()` (same file). Renames touch the interface signature + the object-literal method + every external site.

---

## File structure

Engine source files this plan edits (all under `packages/`):

- `domecs/src/rng.ts` — RNG `uniform*` rename (Task 1).
- `domecs/src/query.ts` — `On*` node rename + `QueryNodeKind` const + structural/temporal type split (Tasks 2, 7).
- `domecs/src/world.ts` — accessor + driver renames, `step`/`stepOnce` split, one-shot selector param types (Tasks 3, 4, 7).
- `domecs/src/scheduler.ts` — `SystemDef` discriminated union (Task 5).
- `domecs/src/errors.ts` — `retryable`/`idempotent?`/`getErrorRepairHint`/`ERROR_KINDS`/`isKnownDomecsErrorKind`/closure JSDoc (Task 8).
- `domecs/src/index.ts` — barrel: export new error symbols + `QueryNodeKind` (Tasks 2, 8).
- `domecs-dom/src/view.ts` — `changedOn` union type (Task 6).
- `domecs-dom/src/mount.ts` — `changedOn` consumption, `OnChanged` usage, `mountDOM → Result` (Tasks 2, 6, 9).
- `domecs-dom/src/index.ts` — export `MountError` (Task 9).
- `domecs-inspector/src/inspector.ts` — `OnChanged` usage (Task 2).

Tooling/docs:

- `tools/codemod/` (new) — shared jscodeshift/ts-morph transforms + dry-run (Task 12).
- `doc/api-surface/*.d.ts` — regenerated each task; full regen Task 11.
- `doc/LEGIBILITY.md` — marker flip (Task 11).
- `doc/phase2-coverage-matrix.md` (new) — `repo × change` matrix (Task 12).

---

## Branch setup (do once, before Task 1)

- [ ] **Create the break branch off `main`.**

```bash
cd /c/dev/HyperNova/domecs
git checkout main && git pull --ff-only
git checkout -b v1-break-phase2
git status   # clean, on v1-break-phase2
```

- [ ] **Confirm green baseline** (so later RED states are attributable to our edits).

```bash
pnpm install --frozen-lockfile
pnpm -r build && pnpm api:surface
git diff --exit-code -- doc/api-surface   # expect: no diff (surface already in sync)
pnpm -r --parallel typecheck && pnpm -r --parallel test
```

Expected: build + typecheck + tests all pass, no surface drift.

---

## Task 1: RNG `uniform*` family

**Files:**
- Modify: `packages/domecs/src/rng.ts` (interface lines 4-8, impl lines 64-83 incl. internal cross-calls at 72,75,79,82)
- Test: `packages/domecs/test/rng.test.ts`, `packages/domecs/test/snapshot.test.ts`, `packages/domecs/test/world.rand-time.test.ts`

- [ ] **Step 1: Update the tests to the new names (RED).** In `rng.test.ts` replace every `.next(` / `.int(` / `.range(` / `.roll(` receiver-method on an `Rng` with `.uniform(` / `.uniformInt(` / `.uniformRange(` / `.uniformRoll(` (sites: `rng.test.ts:9,16,25,36,53,56,57,68,70,71`; `snapshot.test.ts:76,78,82` on `w.rand`/`w2.rand`; `world.rand-time.test.ts:9,16,17`). Leave `.pick`/`.fork`/`.seed` untouched.

- [ ] **Step 2: Run typecheck to verify RED.**

```bash
pnpm --filter @domecs/core typecheck
```
Expected: FAIL — `Property 'uniform' does not exist on type 'Rng'` (and `uniformInt`/`uniformRange`/`uniformRoll`).

- [ ] **Step 3: Rename in the interface and implementation (GREEN).** In `rng.ts`: interface members `next`→`uniform`, `int`→`uniformInt`, `range`→`uniformRange`, `roll`→`uniformRoll` (lines 4,5,6,8). In `createRng` impl rename the method keys (lines 64,68,74,81) **and** the internal cross-calls: `api.next()`→`api.uniform()` (lines 72,75), `api.int(...)`→`api.uniformInt(...)` (lines 79,82). Keep `pick`/`fork`/`seed`.

- [ ] **Step 4: Run typecheck + tests to verify GREEN.**

```bash
pnpm --filter @domecs/core typecheck && pnpm --filter @domecs/core test
```
Expected: PASS.

- [ ] **Step 5: Regenerate surface + commit.**

```bash
pnpm -r build && pnpm api:surface
git diff -- doc/api-surface/core.d.ts   # review: Rng uniform* rename only
git add -A
git commit -m "refactor(core)!: rename Rng methods to uniform* family" \
  -m "next->uniform, int->uniformInt, range->uniformRange, roll->uniformRoll (design §4). pick/fork/seed unchanged. BREAKING CHANGE: Rng method names." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Query nodes `On*` family

**Files:**
- Modify: `packages/domecs/src/query.ts` (`Added`:108, `Removed`:111, `Changed`:105, `ChangedResource`:131), `packages/domecs/src/index.ts` (barrel lines 12-15)
- Modify (engine src consumers): `packages/domecs-dom/src/mount.ts:60`, `packages/domecs-inspector/src/inspector.ts:193`
- Test: `packages/domecs/test/oneshot-query.test.ts`, `query.test.ts`, `scheduler.test.ts`, `resources.test.ts`

- [ ] **Step 1: Update tests + barrel imports to new names (RED).** Rename in all sites from the inventory: `Added`→`OnAdded` (`oneshot-query.test.ts:110,115,120`; `query.test.ts:212`), `Removed`→`OnRemoved` (`query.test.ts:226`), `Changed`→`OnChanged` (`query.test.ts:193,242`; `scheduler.test.ts:183,207,239,246(x2),266,289,314`), `ChangedResource`→`OnChangedResource` (`resources.test.ts:69,85,101,119,137,153,165,166,167`). Update the test-file `import { … } from '@domecs/core'` lists accordingly. Leave `Has`/`Where`/`Not`/`And`/`Or`.

- [ ] **Step 2: Run typecheck to verify RED.**

```bash
pnpm -r --parallel typecheck
```
Expected: FAIL — `'OnAdded' is not exported`, etc.

- [ ] **Step 3: Rename exports + engine-src consumers (GREEN).** In `query.ts` rename the four `export function` declarations (and any internal references). In `index.ts:12-15` rename the re-exports. In `mount.ts:60` `Changed(c)`→`OnChanged(c)` (and its import on line 2). In `inspector.ts:193` `Changed(Faulted)`→`OnChanged(Faulted)` (and its import). Node `kind` string literals (`'added'`/`'changed'`/`'removed'`/`'changedResource'`) stay unchanged — only the exported constructor names change.

- [ ] **Step 4: Verify GREEN.**

```bash
pnpm -r --parallel typecheck && pnpm -r --parallel test
```
Expected: PASS.

- [ ] **Step 5: Regenerate surface + commit.**

```bash
pnpm -r build && pnpm api:surface
git diff -- doc/api-surface/core.d.ts   # review: On* node rename
git add -A
git commit -m "refactor(core)!: rename temporal query nodes to On* prefix" \
  -m "Added->OnAdded, Removed->OnRemoved, Changed->OnChanged, ChangedResource->OnChangedResource (design §4). Has/Where/Not/And/Or unchanged. BREAKING CHANGE: temporal query node names." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: World read accessors

**Files:**
- Modify: `packages/domecs/src/world.ts` (interface + object-literal impl: `resource` 152/1011, `count` 223/1165, `entitiesMatching` 224/1179, `select` 225-228/1192, `entitiesWith` 194/1041)
- Test: `resources.test.ts`, `oneshot-query.test.ts`, `world.basic.test.ts`

- [ ] **Step 1: Update tests to new names (RED).** Apply per inventory: `w.resource(`→`w.getResource(` (`resources.test.ts:13,19,26,33,34,35,41,42,140,190,191,199,215`), `.count(`→`.countEntities(` (`oneshot-query.test.ts:19,20,21,29,30,31,38,48,60,110`; `resources.test.ts:165`), `.entitiesMatching(`→`.listEntities(` (`oneshot-query.test.ts:62,77,85,120`; `resources.test.ts:166`), `.select(`→`.selectViews(` (`oneshot-query.test.ts:61,93,102,115`; `resources.test.ts:167`), `.entitiesWith(`→`.iterEntitiesWith(` (`world.basic.test.ts:98,108`).

- [ ] **Step 2: Verify RED.**

```bash
pnpm --filter @domecs/core typecheck
```
Expected: FAIL — `Property 'getResource' does not exist on type 'World'` (and the other four).

- [ ] **Step 3: Rename interface + impl (GREEN).** In `world.ts` rename each interface method signature and its object-literal implementation key. Keep the `select`/`selectViews` overload pair intact (just rename both overloads). No call-site exists inside `world.ts` for these five except the impl itself.

- [ ] **Step 4: Verify GREEN.**

```bash
pnpm --filter @domecs/core typecheck && pnpm --filter @domecs/core test
```
Expected: PASS.

- [ ] **Step 5: Regenerate surface + commit.**

```bash
pnpm -r build && pnpm api:surface
git diff -- doc/api-surface/core.d.ts   # review: World accessor renames
git add -A
git commit -m "refactor(core)!: rename World read accessors to verb-language" \
  -m "resource->getResource, count->countEntities, entitiesMatching->listEntities, select->selectViews, entitiesWith->iterEntitiesWith (design §4 L3). BREAKING CHANGE: World accessor method names." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Driver — `startLoop` + `step(dt)` / `stepOnce()` split

**Design decision (resolves the discovery-flagged third case):** current `step(dt?)` has three behaviors — no-arg `step()` = full tick with `d=0` (turn-based single advance); `step(dt>0)` = real-time tick; explicit `step(dt<=0)` = heartbeat (plugin hooks + render only, no system run, no change-buffer swap). The v1.0 shape:
- **`step(dt: number)`** — `dt` is now **required**. `dt>0` real-time tick; `dt<=0` retains the heartbeat behavior (so existing explicit-`step(0)` heartbeat sites keep working unchanged).
- **`stepOnce(): void`** — the former no-arg `step()` (full tick, `d=0`, turn-based).

Migration rule (drives the codemod in Task 12): **`step()` with no argument → `stepOnce()`; `step(x)` with any argument → unchanged.**

**Files:**
- Modify: `packages/domecs/src/world.ts` (iface `start`:254, `step`:241; impl `start`:1452, `step`:1277; internal forwards `frame`:875, `stepN`:1415, `turn`:1422, `action`:1433)
- Test: all `step`-using tests (inventory below) + `lifecycle.test.ts`/`code-review-fixes.test.ts`/`headless-import.test.ts` for `start`

- [ ] **Step 1: Write the failing behavioral test for `stepOnce` (RED).** Add to `packages/domecs/test/lifecycle.test.ts`:

```ts
it('stepOnce advances one tick with zero dt (turn-based)', () => {
  const w = createWorld()
  let ticks = 0
  let lastDt = -1
  w.system('count', {}, (ctx) => { ticks++; lastDt = ctx.time.delta })
  w.stepOnce()
  expect(ticks).toBe(1)
  expect(lastDt).toBe(0)
})

it('step requires a dt and advances real time', () => {
  const w = createWorld()
  let lastDt = -1
  w.system('count', {}, (ctx) => { lastDt = ctx.time.delta })
  w.step(0.5)
  expect(lastDt).toBeCloseTo(0.5)
})
```
(Adjust `ctx.time.delta` to the actual `TimeState` delta field name if different — confirm against `time.ts` while implementing.)

- [ ] **Step 2: Verify RED.**

```bash
pnpm --filter @domecs/core typecheck
```
Expected: FAIL — `Property 'stepOnce' does not exist on type 'World'`.

- [ ] **Step 3: Rename `start`→`startLoop`, split `step` (GREEN).** In `world.ts`:
  - Interface: `start`→`startLoop` (254); change `step(dt?: number): void` to `step(dt: number): void` (241); add `stepOnce(): void` (241-adjacent).
  - Impl: rename the `start` object-literal key to `startLoop` (1452). Refactor the `step` impl (1277): extract the existing tick body into an internal `runTick(d: number)`; `step(dt)` calls `runTick(dt)` (preserving the `dt<=0` heartbeat branch); add `stepOnce()` calling `runTick(0)` with the turn-based path.
  - Internal forwards: `frame()` (875) keeps `world.step(dtMs/1000)` (always positive). `stepN`/`turn`/`action` (1415/1422/1433) currently forward an optional `dt`; change each to: `dt === undefined ? world.stepOnce() : world.step(dt)`.

- [ ] **Step 4: Migrate engine `step`/`start` test call sites (still RED→GREEN).** Apply the migration rule across the 164 `step` sites + 19 `start` sites:
  - `start(`→`startLoop(` in `lifecycle.test.ts` (17), `code-review-fixes.test.ts:234`, `headless-import.test.ts:44`.
  - No-arg `step()`/`w.step()` → `stepOnce()`. Files with no-arg sites: `domecs-dom/test/lifecycle.test.ts`, `domecs/test/query.test.ts`, `resources.test.ts`, and others — find them precisely:

```bash
# no-arg step() calls across engine tests (-> stepOnce):
grep -rnE '\b\w+\.step\(\s*\)' packages/*/test
# arg step(x) calls (stay step):
grep -rnE '\b\w+\.step\([^)]+\)' packages/*/test
```
  Convert only the empty-parens matches to `stepOnce()`. Leave heartbeat `step(0)` (`scheduler.test.ts:293,303-305,316-317,328`) and all other `step(arg)` as `step(arg)`.

- [ ] **Step 5: Verify GREEN.**

```bash
pnpm -r --parallel typecheck && pnpm -r --parallel test
```
Expected: PASS.

- [ ] **Step 6: Regenerate surface + commit.**

```bash
pnpm -r build && pnpm api:surface
git diff -- doc/api-surface/core.d.ts   # review: startLoop + step(dt) + stepOnce
git add -A
git commit -m "refactor(core)!: rename start->startLoop, split step into step(dt)+stepOnce()" \
  -m "step(dt) now requires dt (dt<=0 keeps heartbeat); no-arg tick is stepOnce() (design §4). BREAKING CHANGE: driver method names and step() arity." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `SystemDef` discriminated union

**Files:**
- Modify: `packages/domecs/src/scheduler.ts` (`SystemDef`:11-30, `SystemSchedule`:9, `register` validation 121-158, system construction `world.ts:1215,1683`)
- Test: `packages/domecs/test/scheduler.test.ts`

- [ ] **Step 1: Write type-level + behavioral failing tests (RED).** Add to `scheduler.test.ts`:

```ts
it('rejects invalid schedule+field combinations at compile time', () => {
  const w = createWorld()
  // @ts-expect-error rateHz only valid on 'fixed'
  w.system('a', { schedule: 'tick', rateHz: 30 }, () => {})
  // @ts-expect-error triggers only valid on 'event'
  w.system('b', { schedule: 'once', triggers: [] }, () => {})
  // @ts-expect-error reactive requires reactsTo
  w.system('c', { schedule: 'reactive' }, () => {})
})

it('accepts each valid variant', () => {
  const w = createWorld()
  w.system('tick', { schedule: 'tick' }, () => {})
  w.system('default', {}, () => {})                       // defaults to tick
  w.system('fixed', { schedule: 'fixed', rateHz: 30 }, () => {})
  w.system('event', { schedule: 'event', triggers: [] }, () => {})
  w.system('once', { schedule: 'once' }, () => {})
  w.system('reactive', { schedule: 'reactive', reactsTo: OnChanged(SomeComp) }, () => {})
})
```

- [ ] **Step 2: Verify RED.**

```bash
pnpm --filter @domecs/core typecheck
```
Expected: FAIL — the `@ts-expect-error` lines are currently *not* errors (flat `SystemDef` allows the combos), so `@ts-expect-error` itself reports "unused".

- [ ] **Step 3: Replace flat `SystemDef` with the discriminated union (GREEN).** In `scheduler.ts`:

```ts
interface SystemDefBase<Fields, State> {
  query?: QueryDef
  priority?: number
  enabled?: () => boolean
  state?: State
  readonly __fields?: Fields
}
/** Per-tick system (the default when `schedule` is omitted). */
export interface TickSystemDef<F = Record<string, unknown>, S = unknown> extends SystemDefBase<F, S> { schedule?: 'tick' }
/** Fixed-rate system; `rateHz` must be a whole-number divisor of the world's base rate. */
export interface FixedSystemDef<F = Record<string, unknown>, S = unknown> extends SystemDefBase<F, S> { schedule: 'fixed'; rateHz?: number }
/** Event-driven system; runs when any of `triggers` fired this tick. */
export interface EventSystemDef<F = Record<string, unknown>, S = unknown> extends SystemDefBase<F, S> { schedule: 'event'; triggers?: EventType<unknown>[] }
/** Runs exactly once, on the first tick after registration. */
export interface OnceSystemDef<F = Record<string, unknown>, S = unknown> extends SystemDefBase<F, S> { schedule: 'once' }
/** Reactive system; `ctx.entities` is the change-delta from `reactsTo`. */
export interface ReactiveSystemDef<F = Record<string, unknown>, S = unknown> extends SystemDefBase<F, S> { schedule: 'reactive'; reactsTo: QueryDef }
export type SystemDef<F = Record<string, unknown>, S = unknown> =
  | TickSystemDef<F, S> | FixedSystemDef<F, S> | EventSystemDef<F, S> | OnceSystemDef<F, S> | ReactiveSystemDef<F, S>
```
  In `register`: the `'reactive' && !reactsTo` throw (125-129) is now unreachable from TS but **keep it** as a defensive runtime guard for untyped JS callers (add a comment: "defensive — unrepresentable in TS, retained for JS callers"). Keep the `reactsTo` must-contain-a-change-node throw (131-143) and the `rateHz` divisor throw (152-158) — both depend on runtime/world values, not type-level facts. Construction sites `world.ts:1215` (`'reactive'`, has `reactsTo`) and `world.ts:1683` (`'tick'`) already satisfy the union — verify they typecheck.

- [ ] **Step 4: Verify GREEN.**

```bash
pnpm --filter @domecs/core typecheck && pnpm --filter @domecs/core test
```
Expected: PASS (the `@ts-expect-error` lines now suppress real errors).

- [ ] **Step 5: Regenerate surface + commit.**

```bash
pnpm -r build && pnpm api:surface
git diff -- doc/api-surface/core.d.ts   # review: SystemDef union + new variant exports
git add -A
git commit -m "refactor(core)!: make SystemDef a discriminated union on schedule" \
  -m "Tick/Fixed/Event/Once/Reactive variants carry only valid fields; invalid combos now unrepresentable (design §5). BREAKING CHANGE: SystemDef shape." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `changedOn` union (`@domecs/dom`)

**Mapping (preserves current behavior):** omitted → `{mode:'auto'}` (derive `Changed(T)` from query `Has()` leaves); `[]` → `{mode:'legacy'}` (update every mounted entity every tick); `[T,…]` → `{mode:'explicit', types:[T,…]}`.

**Files:**
- Modify: `packages/domecs-dom/src/view.ts` (`changedOn`:29 on `ViewDef`), `packages/domecs-dom/src/mount.ts` (`resolveChangedTypes`:184-189, `mountDOM`:59-61)
- Test: `packages/domecs-dom/test/lifecycle.test.ts` (set-sites 21,91,124,150)

- [ ] **Step 1: Update tests to the union + add per-mode coverage (RED).** In `lifecycle.test.ts`: `changedOn: [Sprite]` (21,124,150) → `changedOn: { mode: 'explicit', types: [Sprite] }`; `changedOn: []` (91) → `changedOn: { mode: 'legacy' }`. Add one view with `changedOn` omitted asserting auto-derive still gates updates, and assert `{mode:'legacy'}` updates every tick.

- [ ] **Step 2: Verify RED.**

```bash
pnpm --filter @domecs/dom typecheck
```
Expected: FAIL — object literal not assignable to `ReadonlyArray<ComponentType>`.

- [ ] **Step 3: Replace the type + consumption (GREEN).** In `view.ts`:

```ts
export type ChangedOn =
  | { readonly mode: 'auto' }     // derive Changed(T) from the query's Has() leaves
  | { readonly mode: 'legacy' }   // update every mounted entity every tick
  | { readonly mode: 'explicit'; readonly types: ReadonlyArray<ComponentType<unknown>> }
// on ViewDef:
readonly changedOn?: ChangedOn
```
  In `mount.ts` `resolveChangedTypes` (184-189) branch on `def.changedOn?.mode`: `'explicit'` → `changedOn.types`; `'legacy'` → `[]` (forces always-update, current empty-array path); `'auto'` or `undefined` → existing `collectHasComponents(normalizeQuery(def.query))` derivation. Use `OnChanged` (renamed in Task 2) where it builds the change queries (line 60).

- [ ] **Step 4: Verify GREEN.**

```bash
pnpm --filter @domecs/dom typecheck && pnpm --filter @domecs/dom test
```
Expected: PASS.

- [ ] **Step 5: Regenerate surface + commit.**

```bash
pnpm -r build && pnpm api:surface
git diff -- doc/api-surface/dom.d.ts   # review: ChangedOn union on ViewDef
git add -A
git commit -m "refactor(dom)!: replace changedOn tri-state with ChangedOn union" \
  -m "{mode:'auto'|'legacy'|'explicit',types} replaces omitted/[]/[T] (design §5). BREAKING CHANGE: ViewDef.changedOn shape." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: One-shot selector type narrowing (reject `On*` nodes)

**Approach (from discovery — brand, not recursive tree-walk):** the `On*` constructors return a branded `TemporalQueryNode`; `countEntities`/`listEntities`/`selectViews` accept a new `OneShotQueryDef` that excludes the temporal brand. All current `On*` usages in one-shot selectors are top-level (never nested in `And`/`Or`), so the brand covers the real cases; nested mixed trees fall back to the runtime guard (`oneshotNode()`), which stays.

**Files:**
- Modify: `packages/domecs/src/query.ts` (node types, `OnAdded/OnRemoved/OnChanged/OnChangedResource` return types, new `OneShotQueryDef`, `QueryNodeKind` const), `packages/domecs/src/world.ts` (selector param types 223-228), `packages/domecs/src/index.ts` (export `QueryNodeKind`, `OneShotQueryDef`)
- Test: `packages/domecs/test/oneshot-query.test.ts`

- [ ] **Step 1: Convert the runtime-throw assertions to compile-time `@ts-expect-error` (RED).** In `oneshot-query.test.ts`, the lines that assert `count`/`select`/`entitiesMatching` throw on a temporal node (110,115,120 — now `countEntities(OnAdded(...))` etc. after Tasks 2-3) become:

```ts
// @ts-expect-error temporal On* nodes are illegal in one-shot selectors
w.countEntities(OnAdded(Enemy))
// @ts-expect-error
w.selectViews(OnAdded(Enemy))
// @ts-expect-error
w.listEntities(OnAdded(Enemy))
```
  Keep one runtime-throw assertion (e.g. via an `as any` cast) proving the JS-caller guard still fires.

- [ ] **Step 2: Verify RED.**

```bash
pnpm --filter @domecs/core typecheck
```
Expected: FAIL — `@ts-expect-error` unused (the selectors still accept `QueryDef`, so no type error yet).

- [ ] **Step 3: Add the brand + narrowed param type (GREEN).** In `query.ts`:

```ts
declare const TEMPORAL: unique symbol
export interface TemporalQueryNode extends QueryNode { readonly [TEMPORAL]?: true }
// OnAdded/OnRemoved/OnChanged/OnChangedResource now return TemporalQueryNode
// (Has/Where/Not/And/Or keep returning QueryNode)
export type OneShotQueryDef = ReadonlyArray<ComponentType<unknown>> | Exclude<QueryNode, TemporalQueryNode>
export const QueryNodeKind = ['has','changed','added','removed','where','changedResource','not','and','or'] as const
export type QueryNodeKind = (typeof QueryNodeKind)[number]
```
  In `world.ts` change `countEntities`/`listEntities`/`selectViews` params from `QueryDef` to `OneShotQueryDef` (keep `world.query`/reactive on `QueryDef`). Export `QueryNodeKind` + `OneShotQueryDef` from `index.ts`. Keep `oneshotNode()` runtime guard.

- [ ] **Step 4: Verify GREEN.**

```bash
pnpm --filter @domecs/core typecheck && pnpm --filter @domecs/core test
```
Expected: PASS.

- [ ] **Step 5: Regenerate surface + commit.**

```bash
pnpm -r build && pnpm api:surface
git diff -- doc/api-surface/core.d.ts   # review: OneShotQueryDef, QueryNodeKind, branded On* returns
git add -A
git commit -m "feat(core)!: reject temporal nodes in one-shot selectors at compile time" \
  -m "On* constructors return branded TemporalQueryNode; countEntities/listEntities/selectViews take OneShotQueryDef. Export QueryNodeKind const (design §5, L5). BREAKING CHANGE: selector param types." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Error legibility

**Files:**
- Modify: `packages/domecs/src/errors.ts` (`DomecsError`:23-31, `SystemFault`:84-89, `describeError`:39-55, new symbols), `packages/domecs/src/index.ts:24-25` (export new symbols)
- Test: `packages/domecs/test/errors.test.ts`

- [ ] **Step 1: Write failing tests (RED).** Add to `errors.test.ts`:

```ts
it('every DomecsError variant carries a boolean retryable', () => {
  for (const kind of ERROR_KINDS) {
    expect(typeof makeSampleError(kind).retryable).toBe('boolean')  // sample factory in test
  }
})
it('getErrorRepairHint returns a non-empty fix string for every kind', () => {
  for (const kind of ERROR_KINDS) {
    expect(getErrorRepairHint(makeSampleError(kind)).length).toBeGreaterThan(0)
  }
})
it('isKnownDomecsErrorKind discriminates', () => {
  expect(isKnownDomecsErrorKind('system_threw')).toBe(true)
  expect(isKnownDomecsErrorKind('nope')).toBe(false)
})
```
(Write `makeSampleError(kind)` constructing one of each of the 7 variants with valid fields incl. `retryable`.)

- [ ] **Step 2: Verify RED.**

```bash
pnpm --filter @domecs/core typecheck
```
Expected: FAIL — `ERROR_KINDS`, `getErrorRepairHint`, `isKnownDomecsErrorKind` not exported; `retryable` not a field.

- [ ] **Step 3: Implement (GREEN).** In `errors.ts`:
  - Add `retryable: boolean` to all 7 variants (23-31). Keep `migration_failed.recoverable` as-is (distinct field).
  - Add `idempotent?: boolean` to `SystemFault` (84-89).
  - Add closure JSDoc above the `DomecsError` union: `/** Closed union — adding a variant is a breaking change. */`.

```ts
export const ERROR_KINDS = ['plugin_install_failed','system_threw','persist_io','migration_failed','schema_mismatch','query_invalid','event_handler_threw'] as const
export type ErrorKind = (typeof ERROR_KINDS)[number]
export function isKnownDomecsErrorKind(k: string): k is ErrorKind {
  return (ERROR_KINDS as readonly string[]).includes(k)
}
export function getErrorRepairHint(e: DomecsError): string {
  return match(e, {
    plugin_install_failed: (x) => `Plugin "${x.plugin}" failed to install. Check its install() return and dependency order.`,
    system_threw:          (x) => `System "${x.system}" threw on tick ${x.tick}. Wrap its body in a Result or guard the faulting input.`,
    persist_io:            (x) => `Persistence ${x.op} failed. Verify the Storage backend is reachable and writable.`,
    migration_failed:      (x) => `Snapshot migration ${x.from}->${x.to} failed: ${x.reason}. ${x.recoverable ? 'Recoverable — retry with a fallback migrator.' : 'Not recoverable — discard or hand-migrate.'}`,
    schema_mismatch:       (x) => `Component "${x.component}" expected ${x.expected} but got ${x.got}. Align the schema or migrate stored values.`,
    query_invalid:         (x) => `Invalid query: ${x.reason}. Use a structural node (Has/Where/Not/And/Or) or a component tuple.`,
    event_handler_threw:   (x) => `Handler for event "${x.event}" threw. Guard the handler body and emit via Result.`,
  })
}
```
  Export `ERROR_KINDS`, `ErrorKind`, `isKnownDomecsErrorKind`, `getErrorRepairHint` from `errors.ts` and re-export from `index.ts:24-25`. Update every internal site that constructs a `DomecsError` to set `retryable` (grep `kind:` literals in src; set `retryable: true` for transient I/O/system faults, `false` for schema/query/migration-not-recoverable — decide per variant in the impl).

- [ ] **Step 4: Verify GREEN.**

```bash
pnpm --filter @domecs/core typecheck && pnpm --filter @domecs/core test
```
Expected: PASS.

- [ ] **Step 5: Regenerate surface + commit.**

```bash
pnpm -r build && pnpm api:surface
git diff -- doc/api-surface/core.d.ts   # review: retryable, idempotent?, ERROR_KINDS, isKnownDomecsErrorKind, getErrorRepairHint
git add -A
git commit -m "feat(core)!: add retryable + repair hints + ERROR_KINDS to error surface" \
  -m "retryable on every DomecsError variant, idempotent? on SystemFault, getErrorRepairHint, ERROR_KINDS const, isKnownDomecsErrorKind, closure JSDoc (design §5/§6 error bullet, L2/L5). BREAKING CHANGE: DomecsError variants gain required retryable." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `mountDOM → Result<MountHandle, MountError>`

**`MountError` design (from the 3 current throw conditions):** discriminated union —
`{ kind: 'slot_already_mounted'; slot: string }` (mount.ts:37), `{ kind: 'unregistered_slot'; slot: string }` (mount.ts:49), `{ kind: 'plugin_install_failed'; reason: string }` (mount.ts:95).

**Files:**
- Modify: `packages/domecs-dom/src/mount.ts` (`mountDOM`:33, throws 37/49/95, import line 2), `packages/domecs-dom/src/index.ts:4` (export `MountError`)
- Test: `packages/domecs-dom/test/headless-import.test.ts` (26,32), `slots.test.ts` (21,23,27,51,72,88), `lifecycle.test.ts` (32,70,99,130,160,194,226)

- [ ] **Step 1: Update call sites to unwrap Result + add failure-path tests (RED).** Rewrite the 15 success call sites to unwrap, e.g.:

```ts
const r = mountDOM(world, opts)
expect(isOk(r)).toBe(true)
const handle = r.value   // was: const handle = mountDOM(...)
```
  Add failure tests asserting each error kind is returned (not thrown):

```ts
it('returns err on duplicate slot mount', () => {
  const r1 = mountDOM(world, opts); expect(isOk(r1)).toBe(true)
  const r2 = mountDOM(world, opts)
  expect(isErr(r2)).toBe(true)
  if (isErr(r2)) expect(r2.error.kind).toBe('slot_already_mounted')
})
```

- [ ] **Step 2: Verify RED.**

```bash
pnpm --filter @domecs/dom typecheck
```
Expected: FAIL — `.value`/`isOk` on `MountHandle`; `MountError` unknown.

- [ ] **Step 3: Convert `mountDOM` to Result (GREEN).** In `mount.ts`: import `err`, `isErr`, type `Result` from `@domecs/core` (extend the existing line-2 `ok` import). Define + export `MountError`. Change the signature to `mountDOM(world: World, opts: MountOptions): Result<MountHandle, MountError>`. Replace the three `throw new Error(...)` (37/49/95) with `return err({ kind: …, … })`; wrap the success return as `return ok({ teardown })`. The plugin-install branch (95) maps `world.use(...)` failure to `err({ kind: 'plugin_install_failed', reason })`. Export `MountError` from `index.ts:4`.

- [ ] **Step 4: Verify GREEN.**

```bash
pnpm --filter @domecs/dom typecheck && pnpm --filter @domecs/dom test
```
Expected: PASS.

- [ ] **Step 5: Regenerate surface + commit.**

```bash
pnpm -r build && pnpm api:surface
git diff -- doc/api-surface/dom.d.ts   # review: mountDOM Result return + MountError
git add -A
git commit -m "feat(dom)!: mountDOM returns Result<MountHandle, MountError>" \
  -m "Failure is now enumerable (slot_already_mounted/unregistered_slot/plugin_install_failed) instead of thrown (design §5/§6). BREAKING CHANGE: mountDOM return type." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Confirm `InternalComponentType` barrel-removal is already satisfied (no code change)

**Files:** none (verification only).

- [ ] **Step 1: Prove it's not in any public barrel.**

```bash
grep -rn 'InternalComponentType\|\binternal\b' packages/*/src/index.ts
```
Expected: **no matches** — neither is re-exported from any package barrel.

- [ ] **Step 2: Confirm the descriptor reflection path exists.**

```bash
grep -n 'describeComponent' packages/domecs/src/world.ts
grep -n 'ComponentDescriptor\|ComponentSchema\|FieldSchema\|FieldKind' packages/domecs/src/index.ts
```
Expected: `describeComponent` on the `World` interface + impl; the four descriptor types exported.

- [ ] **Step 3: Record the finding in the plan log.** No commit (no change). The §6 "remove `InternalComponentType` from the public barrel" requirement is satisfied by the current state; the `__`-field reach-ins remain a private engine-internal path inside `world.ts` (acceptable — they are not public surface). Note for Phase 4: docstring-polish may add a "reflection via `describeComponent`, not `__` fields" note.

---

## Task 11: Full surface regen + flip `LEGIBILITY.md` enforcement markers

**Files:**
- Verify: `doc/api-surface/*.d.ts` (all 5)
- Modify: `doc/LEGIBILITY.md` (L3/L4/L5 markers + status lines)

- [ ] **Step 1: Full rebuild + regen + no-drift gate.**

```bash
pnpm -r build && pnpm api:surface
git diff --exit-code -- doc/api-surface   # expect: clean (all task-level regens already committed)
pnpm -r --parallel typecheck && pnpm -r --parallel test && pnpm api:check
```
Expected: all pass, no residual drift.

- [ ] **Step 2: Flip the markers.** In `LEGIBILITY.md`: change L3 (naming language), L4 (prove invalid states unrepresentable), and L5 (enumerable closed sets) headers from `⏳` to `✅`, and rewrite each "Enforcement status" paragraph from "lands in Phase 2" to "shipped in the v1.0 break (Phase 2)". Update the legend note if needed. Leave L2 and L6 as `⏳` (their full enforcement — `describe*`/`world.describe()` and doctests — is Phase 3/4); but note L2's error half (`retryable`+repair hint) shipped in Phase 2.

- [ ] **Step 3: Commit.**

```bash
git add -A
git commit -m "docs(legibility): mark L3/L4/L5 enforced after the v1.0 break" \
  -m "Naming language, prove-invalid-unrepresentable, and enumerable closed sets are now enforced in shipped types (Phase 2). L2 error half (retryable/repair hint) also shipped." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Shared codemod + `repo × change` coverage matrix

**Files:**
- Create: `tools/codemod/domecs-v1.cjs` (jscodeshift transform), `tools/codemod/README.md`
- Create: `doc/phase2-coverage-matrix.md`
- Modify: `package.json` (root) — add `"codemod": "jscodeshift -t tools/codemod/domecs-v1.cjs"` script + `jscodeshift` devDep

- [ ] **Step 1: Add `jscodeshift` + script (RED via self-test).**

```bash
pnpm add -Dw jscodeshift @types/jscodeshift
```
  Add to root `package.json` scripts: `"codemod": "jscodeshift --parser=tsx -t tools/codemod/domecs-v1.cjs"`.

- [ ] **Step 2: Write the transform.** `tools/codemod/domecs-v1.cjs` handles the **safe mechanical** transforms with receiver/import guards:
  - Import-specifier renames from `@domecs/core` / `@domecs/dom`: `Added→OnAdded`, `Removed→OnRemoved`, `Changed→OnChanged`, `ChangedResource→OnChangedResource` (rename both the import and its references in that file).
  - Member renames guarded to known receiver types where statically determinable, else **flagged** (not blind-replaced): `.resource(`→`.getResource(`, `.count(`→`.countEntities(`, `.entitiesMatching(`→`.listEntities(`, `.select(`→`.selectViews(`, `.entitiesWith(`→`.iterEntitiesWith(`, `.start(`→`.startLoop(`, RNG `.next/.int/.range/.roll`→`uniform*`.
  - `step()` no-arg → `stepOnce()`; `.step(arg)` left unchanged.
  - **Flagged-for-manual** (transform emits a `// CODEMOD-REVIEW:` comment + matrix entry, does not auto-edit): `mountDOM` Result-unwrap; `changedOn: []`→`{mode:'legacy'}` / `[T]`→`{mode:'explicit',types:[T]}`; `DomecsError` match arms needing `retryable`; now-invalid `SystemDef` combos; ambiguous receivers for the common member names (`.select/.count/.start/.next/.int/.range/.roll`).

- [ ] **Step 3: Self-test the codemod against a fixture (GREEN).** Create `tools/codemod/__fixtures__/before.tsx` / `after.tsx` covering one of each transform; add `tools/codemod/codemod.test.mjs` (node:test) asserting transform(before) === after. Run:

```bash
node --test tools/codemod/codemod.test.mjs
```
Expected: PASS.

- [ ] **Step 4: Build the coverage matrix by scanning consumers.** For each consumer repo (Task 13 list), run the codemod in **dry-run** (`--dry --print`) + the manual-touch greps; tabulate into `doc/phase2-coverage-matrix.md` as `repo × {imports, accessors, rng, query-nodes, step-split, changedOn, mountDOM, SystemDef, error-match}` with cell = count or "—". Empty row ⇒ that repo is unaffected.

- [ ] **Step 5: Commit.**

```bash
git add -A
git commit -m "build: add domecs v1 codemod + Phase 2 coverage matrix" \
  -m "jscodeshift transform for mechanical renames + step()->stepOnce(); flags semantic transforms (mountDOM Result, changedOn union, SystemDef combos, error retryable) for manual review. Coverage matrix scans every consumer." \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Consumer lockstep migration (gated — engine `main` not pushed until all green)

Instantiate the §10.4 runbook **once per consumer repo**, in dependency-free order. Known consumers (confirm each path + that it depends on `domecs` before running; skip any the matrix marks unaffected): in-repo/org apps first — `dashboard`, `restaurant`, `roguelike`, `railroad` (`C:\dev\HyperNova\railroad_game`), `fleet` (`C:\dev\HyperNova\fleet_app`); external snapshot-history repos last — `studio`, `tessera`, `lighthouse`. (Cross-ref Reqall #2681 external, #2682 in-repo; and the `domecs-demo-apps-deployment` memory for the GH-Pages demo repos' `file:`-dep wiring and `base:'./'` / load-bearing `domecs-workspace` dep.)

**Per-repo runbook (repeat verbatim for each consumer):**

- [ ] **Pin the engine.** Ensure the consumer's `file:../domecs/packages/*` source link resolves to this branch's commit; `pnpm install` (or `npm install`). Keep `"domecs-workspace": "file:../domecs"` and `vite base: './'`.
- [ ] **Baseline scan (dry run).**

```bash
pnpm --dir <repo> exec jscodeshift --parser=tsx --dry --print -t /c/dev/HyperNova/domecs/tools/codemod/domecs-v1.cjs <repo>/src
```
  Fill this repo's row in the coverage matrix. If every cell is empty → record "unaffected", stop.
- [ ] **Apply mechanical codemod** (drop `--dry --print`), commit as an isolated "mechanical rename" commit in the consumer repo.
- [ ] **Resolve the review-list** — confirm each `// CODEMOD-REVIEW:` ambiguous receiver (`.select`/`.next`/`.count`/`.start`/`.int`/`.range`/`.roll`).
- [ ] **Apply manual touch-points** in matrix order: `mountDOM` → `Result` unwrap; `changedOn: []`→`{mode:'legacy'}`, `[T]`→`{mode:'explicit',types:[T]}`; `DomecsError`/`match` arms gain `retryable`; fix any now-invalid `SystemDef` combo; (no `InternalComponentType` work — already private).
- [ ] **Verify (red/green — not done until green):** `tsc --noEmit` clean → `vite build` clean → app boots (first-paint smoke; input-driven apps confirm `tickStart` + `changedOn` first-paint per the `domecs-browser-app-gotchas` memory).
- [ ] **Commit** the migration on the consumer repo.

**After all consumers green — engine-side lockstep check + release gate:**

- [ ] Run `pnpm test:release` (`scripts/validate-release.mjs` — discovers org sibling apps, pins local `../fleet_app`). Expected: PASS.
- [ ] Re-run the full engine gate on `v1-break-phase2`: `pnpm -r --parallel typecheck && pnpm -r build && pnpm api:surface && git diff --exit-code -- doc/api-surface && pnpm -r --parallel test && pnpm api:check`.
- [ ] Only now is the branch eligible to merge to `main` (per session convention: user merges + pushes). **Do not push `main` before this gate is green** — that is the lockstep barrier.

---

## Self-review

**1. Spec coverage (Phase 2 = design §4 + §5 + §6-error + §8 lockstep):**
- §4 RNG → Task 1; query nodes → Task 2; world accessors → Task 3; driver (`startLoop`/`step`/`stepOnce`) → Task 4. ✅
- §5 `SystemDef` union → Task 5; `changedOn` union → Task 6; one-shot narrowing → Task 7; `mountDOM` Result → Task 9; `DomecsError` closure JSDoc → Task 8. ✅
- §6 error bullet (`retryable`/`idempotent?`/`getErrorRepairHint`/`ERROR_KINDS`/`isKnownDomecsErrorKind`) → Task 8; `InternalComponentType` barrel removal → Task 10 (already satisfied). ✅
- §8 lockstep consumer migration → Tasks 12-13; LEGIBILITY enforcement-marker flip → Task 11. ✅
- Out of scope correctly deferred: `describe*`/`world.describe()`/`WorldManifest`/event schemas/inspector export → Phase 3; doctests/`api.md` sync/persist facade → Phase 4. ✅

**2. Placeholder scan:** every task has the real symbol names, the real file:line inventory from discovery, exact commands with expected pass/fail, and full code for new type shapes (`SystemDef` union, `ChangedOn`, `OneShotQueryDef`/`QueryNodeKind`, `MountError`, error helpers). The consumer runbook (Task 13) is concrete because the *edits* are codemod output + a fixed manual touch-list — no "TBD". The one residual judgment call (per-variant `retryable` true/false) is specified as a rule, not left open.

**3. Type/name consistency:** selector names are identical across Task 3 (rename), Task 7 (param narrowing), and Task 13 (codemod): `countEntities`/`listEntities`/`selectViews`/`iterEntitiesWith`. `On*` node names identical across Tasks 2, 5 (`reactsTo: OnChanged(...)`), 7, 13. `stepOnce()`/`step(dt)` identical across Task 4 + codemod rule + runbook. `ChangedOn` discriminants (`auto`/`legacy`/`explicit`) identical across Task 6 + Task 13 manual touch-list. `MountError` kinds identical across Task 9 + runbook. `ERROR_KINDS`/`getErrorRepairHint`/`isKnownDomecsErrorKind` identical across Task 8 + Task 11 (L5 marker). Dependency order is sound: Task 7 needs Tasks 2+3 (On* + selector names); Task 6 uses `OnChanged` from Task 2; Task 12 needs the final surface from Tasks 1-11.

---

## Notes for the executor

- **Branch:** `v1-break-phase2` off `main`. Commit per task as specified. The user merges to `main` and pushes himself — **do not push** (and especially do not push before the Task 13 lockstep gate is green).
- **TDD discipline (`C:\dev\CLAUDE.md`):** every engine task is red→green; never commit a failing task. Keep Reqall (`hypernovasystem/domecs` #2725; todo #2703) updated as tasks land.
- **Cross-OS:** plan authored on Windows; CI runs on Linux. The Phase-0 `normalize()` + `.gitattributes eol=lf` + `newLine:"lf"` keep the no-drift gate stable across both — do not introduce CRLF in generated `.d.ts`.
- **Per-variant `retryable` (Task 8) rule of thumb:** transient/external faults (`persist_io`, `system_threw`, `event_handler_threw`, `plugin_install_failed`) → `retryable: true`; deterministic contract faults (`schema_mismatch`, `query_invalid`) → `false`; `migration_failed` → mirror its `recoverable`.
