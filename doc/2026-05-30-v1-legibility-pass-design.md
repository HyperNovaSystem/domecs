# domecs v1.0 — Agent-Legibility Pass

*Design spec. Date: 2026-05-30. Status: approved for planning.*

Source rubric: [`doc/agent-legible-api-design.md`](./agent-legible-api-design.md). This spec
applies that rubric to the domecs public surface, grounded in a verified 68-finding audit of the
shipped `.d.ts` across 11 surface areas.

---

## 1. Goal & posture

Make the domecs public surface **decidable from signature + one-line doc, spelled exactly one way,
with errors that say how to fix.** An agent moving forward token-by-token should guess the right
method, pass args in the right order, and self-correct from any failure — and the same properties
make the surface harder for humans to misuse.

**Posture (decided):**

- **Pre-v1.0 last break.** This is the final opportunity to rename/reshape for legibility before the
  v1.0 freeze. Breaking changes are on the table.
- **One coordinated break.** All breaking changes land as a single major bump; consumer apps migrate
  in lockstep; then v1.0 freezes additively.
- **Ground truth = the shipped `.d.ts`.** `api.md` becomes a derived/regenerated view, not an
  independent source. Drift between source and `dist/` is the single largest current legibility
  failure and is fixed first.
- **Full canonical sweep + full self-describing root.** No conservative subset.

**Non-goals (YAGNI — §9):** framework adapters, networked rollback, runtime `dev`/`diag` proxy
diagnostics, and reworking the `defineComponent` dual-overload `Name` duplication (a documented
TypeScript limitation — keep, document).

---

## 2. The work-list (ranked audit → §1 deliverable)

The audit produced 13 ranked changes. Rank order = legibility payoff. `kind` and `migration` drive
the rollout (§8) and the consumer map (§10).

| # | Change | Sections | Kind | Payoff | Migration |
|---|--------|----------|------|--------|-----------|
| 1 | Commit a generated API-surface snapshot (`dist/` is gitignored) + first CI gate (typecheck/build/test/no-drift) | V.1, V.3, VII.2 | additive | high | none |
| 2 | `DomecsError` self-describing: `retryable` on every variant + `getErrorRepairHint` + `ERROR_KINDS` | I.3, IV.1–3, II.2 | breaking | high | medium |
| 3 | Split `SystemDef` into schedule-discriminated union | VIII.1, II.4, I.1 | breaking | high | medium |
| 4 | Unify selector family: `countEntities`/`listEntities`/`selectViews`/`iterEntitiesWith` | II.3, V.4, VI.2 | breaking | high | low |
| 5 | `world.resource()` → `world.getResource()` | II.3 | breaking | medium | low |
| 6 | Temporal query nodes → `OnAdded`/`OnRemoved`/`OnChanged`/`OnChangedResource` | II.3, I.1 | breaking | medium | low |
| 7 | Rng → `uniform*` family | II.3 | breaking | medium | low |
| 8 | `step(dt?)` → `step(dt)` + `stepOnce()`; `start()` → `startLoop()` | II.4, I.4, V.4 | breaking | medium | low |
| 9 | Ship component/resource reflection; remove `InternalComponentType` from public barrel | V.1, I.1, VII | breaking | medium | medium |
| 10 | `world.describe(): WorldManifest` — single self-describing root | V.1, VI.2 | new | medium | none |
| 11 | DOM: `mountDOM` → `Result<MountHandle, MountError>`; `changedOn` → discriminated union | I.3, IV.1, II.1 | breaking | medium | high |
| 12 | Sync `api.md` to types + authoritative banner + tested doctests | V.2–3, VII.2 | additive | medium | none |
| 13 | Docstring/units polish (no rename) | I.2, IV, V.4, VI.1 | additive | low | none |

---

## 3. `LEGIBILITY.md` — the contributor guideline (§2 deliverable / the spine)

A standing review checklist for every future public change. Lands at `domecs/doc/LEGIBILITY.md`. Six laws:

- **L1 — The shipped `.d.ts` is the contract.** Regenerate `dist/` on every public change; CI gates
  no-drift between `src/` and `dist/`. `api.md` is a derived view: regenerate it or banner-mark it
  "authoritative source is the types."
- **L2 — Self-describing schemas and errors are first-class.** Every new error variant ships with a
  `retryable` flag and a repair hint. Every new descriptor kind (component/resource/event) is
  enumerable through a typed `describe*` surface. `world.describe()` is the root that composes them.
- **L3 — One naming language (§4), published as law.** Reads = `get*` / `count*` / `list*` /
  `select*` (name encodes return cardinality + cost). Descriptors = `define*`; live instances =
  `create*`. Mutation = `add` / `set` / `mark`. RNG = `uniform*`. Temporal query nodes = `On*`.
  No single-module change may reintroduce a sixth accessor shape.
- **L4 — Prove invalid states unrepresentable (enforcement gradient: prove > check > witness).**
  Options that fork behavior are modeled as discriminated unions, not optional flags. Registration-
  time/call-time throws are a last resort, not the design.
- **L5 — Closed sets are enumerable; the constructor↔discriminant mapping is explicit.** Every
  discriminated union exports its `kind` set as a const (`ERROR_KINDS`, `QueryNodeKind`) and, where
  applicable, a constructor→kind map.
- **L6 — Examples are tested documentation.** Every public entry point gets at least one runnable,
  snippet-CI'd example, explicitly covering each behavioral branch (tick-delay events, the
  `changedOn` modes, reactive entities-as-delta) so examples cannot drift from the shipped types.

---

## 4. The naming language (full canonical sweep)

The whole surface adopts one verb language. Renames below are exhaustive for v1.0.

| Class | Law | Renames |
|-------|-----|---------|
| **Read (singular)** | `get*(x): X \| undefined` | `world.resource(R)` → `world.getResource(R)` |
| **Selectors** | all take `QueryDef`; name encodes return cardinality + hydration cost | `count` → `countEntities` (→ `number`); `entitiesMatching` → `listEntities` (→ `Entity[]`); `select` → `selectViews` (→ `EntityView[]`); `entitiesWith` → `iterEntitiesWith` (→ lazy `Iterable<{id,value}>`) |
| **Query nodes** | `On*` = temporal (illegal in one-shot selectors); bare PascalCase = structural/logical | `Added`→`OnAdded`, `Removed`→`OnRemoved`, `Changed`→`OnChanged`, `ChangedResource`→`OnChangedResource` (keep `Has`/`Where`/`Not`/`And`/`Or`) |
| **RNG** | single `uniform*` family | `next`→`uniform`, `int`→`uniformInt`, `range`→`uniformRange`, `roll`→`uniformRoll` (keep `pick`/`fork`/`seed`) |
| **Driver** | scope in the name | `start`→`startLoop`; `step(dt?)`→`step(dt)` + `stepOnce()` |
| **Factory** | `define*` = descriptor; `create*` = live/effectful instance | already consistent — codify the rule in L3, no renames |
| **Mutate** | `add` = first attach, `set` = replace-or-create, `mark*Changed` = signal-without-replace | already consistent — codify in L3 |

**Selector legality (pairs with §5):** the `count/list/select` one-shot selectors reject temporal
nodes. The `On*` prefix makes that visible at the call site; §5 also narrows the one-shot `QueryDef`
at the type level so an `On*` node is a compile error, not a runtime throw.

---

## 5. Type-strengthening (prove-it)

- **`SystemDef` → discriminated union** keyed on `schedule`:
  `TickSystemDef | FixedSystemDef | EventSystemDef | OnceSystemDef | ReactiveSystemDef`. Each variant
  carries only its valid fields (`rateHz` on Fixed; `triggers` on Event; `reactsTo` on Reactive),
  making invalid combinations unrepresentable instead of throwing at registration. Document the
  `schedule → 'tick'` default, the `enabled` per-tick gate, and the reactive `entities`-as-delta
  semantics in docstrings.
- **`ViewDef.changedOn` tri-state → union.** Today omitted / `[]` / `[Types]` encode three behaviors
  by presence/emptiness. Replace with `{mode:'auto'} | {mode:'legacy'} | {mode:'explicit'; types}`.
- **One-shot selector `QueryDef` narrowing.** Type-level guard so `OnAdded`/`OnRemoved`/`OnChanged`/
  `OnChangedResource` cannot be passed to `countEntities`/`listEntities`/`selectViews`.
- **`mountDOM` → `Result<MountHandle, MountError>`** (see §6) — failure becomes enumerable.
- **`DomecsError` closure marker** — JSDoc declaring the union closed (adding a variant is breaking).

---

## 6. Self-describing root (full)

The headline priority. Endpoint: one machine-readable manifest an agent reads to learn the whole
live world.

- **Component.** Ship `describeComponent(type): ComponentDescriptor`; export
  `ComponentDescriptor`/`ComponentSchema`/`FieldSchema`/`FieldKind` from `index`. **Remove
  `InternalComponentType` (`__schema`/`__validate`/`__defaults`/`__tag`) from the public barrel** —
  the typed descriptor becomes the only reflection path, not the `__` fields.
- **Resource.** Add `world.resourceTypes(): ResourceType[]` and
  `describeResource(type): ResourceDescriptor { name; hasValue; hasDefault }` — parity with components.
- **Error.** Add `retryable: boolean` to **every** `DomecsError` variant (today only
  `migration_failed` carries a signal); optional `idempotent?` on `SystemFault`; export
  `getErrorRepairHint(e): string` (fix-only, exhaustive `match`); export `ERROR_KINDS` const +
  `isKnownDomecsErrorKind` guard; closure JSDoc.
- **Event.** `defineEvent(name, { schema? })` reusing the component `FieldSchema` vocabulary so an
  optional payload schema becomes the event's self-description; `describeEvent()`; docstring that
  `name` is an opaque diagnostic label (identity is the internal symbol); tested define→emit→
  subscribe→tick-delay doctest.
- **Root.** `world.describe(): WorldManifest` composes the partial reflectors and carries the
  debug-tooling necessaries so an inspector/agent can render world state without further probing:
  ```ts
  interface WorldManifest {
    // schema surface (composed from the describe* family)
    components: ComponentDescriptor[]
    resources: ResourceDescriptor[]
    events: { name: string }[]
    systems: { name: string; schedule: SystemSchedule; enabled: boolean }[]
    plugins: InstalledPlugin[]
    capabilities: string[]
    snapshotVersion: number
    // debug-tooling necessaries (decided 2026-05-30)
    entityCount: number                                   // total live entities
    componentCounts: Record<string, number>               // componentName → instances
    archetypes: { components: string[]; entityCount: number }[]  // distinct component-set populations
  }
  ```
  The schema fields answer "what *can* exist"; the debug fields answer "what *does* exist right now"
  — archetype populations + per-component instance counts + total entity count are the minimum an
  inspector needs to summarize a running world. All counts are O(1)/O(archetype) reads, not full
  scans, so `describe()` stays cheap enough to poll.
- **Inspector.** `InspectorView.export(): InspectorSnapshot` (currently records faults/timeline but
  is human-only); document `PluginRegistry`/`InstalledPlugin` in `api.md`.

---

## 7. Drift-fix, persist canonical path, examples (additive)

- **Committed API-surface snapshot + first CI gate (rank 1).** *Premise correction (verified
  2026-05-30):* `packages/*/dist/` is **gitignored**, consumers import **source**
  (`exports → ./src/index.ts`), and a **fresh** `pnpm -r build` emits a `dist/index.d.ts` that
  faithfully mirrors `src/index.ts` — `defineResource`/`ResourceType`/`ChangedResource`/
  `SNAPSHOT_VERSION` etc. are all present. The symbols that looked "missing" were a **stale local
  `dist/` build artifact**, not a source bug. So the real gap is not "rebuild dist" — it is that
  there is **no committed, reviewable machine-readable contract** (dist can't be committed) and **no
  CI** (none exists). Fix: a generator script writes each package's emitted barrel to a committed
  `doc/api-surface/<pkg>.d.ts`; the first CI workflow runs typecheck → build → regenerate snapshot →
  `git diff --exit-code` (the no-drift gate) → test. This makes the public surface a reviewed,
  diffable artifact and is the prerequisite for every later change to be *visible*. Zero runtime
  change.
- **Persist canonical-path decision (decided 2026-05-30).** `api.md` documents an aspirational
  `createPersistence` / `Persistence` facade that the package does **not** ship; the shipped reality
  is Result-typed free functions (`save`/`load`/`migrate` over a `Storage`). **Decision: bless the
  shipped free functions as canonical and delete the `createPersistence`/`Persistence` facade from
  `api.md`** (§II.1 one canonical path; the free functions are already the more legible, Result-typed
  surface). No code change — this is an `api.md` correction folded into Phase 4 sync; no consumer
  migration (nothing imported the facade because it never shipped).
- **Tested doctests + sync.** Export `DEFAULT_INPUT_OPTIONS` (machine-readable input defaults);
  snippet-CI'd examples for input defaults+override+read, event tick-delay, all four `changedOn`
  modes, and `Result` error handling. Fix `api.md` prose-vs-type drifts (`InspectorOptions` real
  fields are `bufferSize`/`recordStateChanges`/`timelineBufferSize`, not `slot`/`hotkey`/`detect`;
  `Plugin` fields are `readonly`; `MountOptions.slots` is `Readonly`). Add an authoritative-source
  banner.
- **Docstring/units polish (rank 13).** `PointerSnapshot.entered: readonly Entity[]`; document
  `wheel`/`delta` units + sign; `GamepadSnapshot` button `value` range; `FaultEntry.detail` shape;
  reference `MAX_CAUSE_DEPTH` from `normalizeCause`; `Signal.subscribe` unsubscribe idempotency;
  export `QueryNodeKind` const map; document the `defineComponent` overload trade-off and the
  `QueryDef` tuple-vs-combinator inference fork.

---

## 8. Rollout — one coordinated v1.0 break

| Phase | Content | Kind | Consumers |
|-------|---------|------|-----------|
| **0** | Drift-fix + CI no-drift gate (rank 1) | additive | none — ship immediately |
| **1** | Write `LEGIBILITY.md` (§3) | docs | none |
| **2** | **The single breaking bump:** naming sweep (§4) + `SystemDef` union + error `retryable`/`repairHint` + `changedOn` union + `mountDOM` Result + remove Internal types | breaking | **migrate all consumer apps lockstep** (§10) |
| **3** | Additive self-describing root (§6): `describe*` family + `world.describe()` + event schemas + inspector export | additive (new) | opt-in |
| **4** | Examples + `api.md` sync + docstring polish (§7) → **freeze v1.0** | additive | none |

Phase 2 is the only consumer-breaking event; everything before is additive and everything after is
additive. Phase 3 depends on rank-9 (`describeComponent`) landing first.

---

## 9. Out of scope (YAGNI)

- `defineComponent` dual-overload `Name` duplication — documented TypeScript limitation; keep both
  overloads, add a signature-level docstring on the trade-off.
- First-party framework adapters (Svelte/React) — post-v1.0 roadmap.
- Networked rollback / Worker host — long-term roadmap.
- Runtime `dev`/`diag` proxy diagnostics (mutation-without-mark warnings) — explicitly deferred;
  must never change `Changed(T)` semantics.

---

## 10. Consumer migration map

**Why a map:** the demo apps consume the engine via `file:../domecs/packages/*` exporting **source**
(`exports → ./src/index.ts`, no pre-build), so the Phase-2 renames break them at typecheck/runtime
immediately. They must migrate in lockstep. Ties reqall **#2681** (external-app remainder) and
**#2682** (in-repo apps, resolved).

### 10.1 Consumer inventory

| Repo / folder | Location | Depends on engine | Notes |
|---------------|----------|-------------------|-------|
| dashboard | standalone repo, cloned alongside `domecs` | yes | demo app (GH Pages) |
| restaurant | standalone repo | yes | demo app |
| roguelike | standalone repo | yes | demo app; uses `action()` |
| railroad | `C:\dev\HyperNova\railroad_game` | yes | demo app; full optional-package coverage |
| fleet | `C:\dev\HyperNova\fleet_app` | yes | demo app; pinned by `validate-release.mjs` |
| studio | external repo (own project) | yes | hand-rolled snapshot history → `createSnapshotHistory` |
| tessera | external repo | yes | hand-rolled snapshot history |
| lighthouse | external repo | yes | hand-rolled snapshot history |
| we / harbor / prism / halls / vite-template | audited (`doc/FINDINGS_*.md`) | varies | confirm live dependency during scan |

### 10.2 Map structure (two layers)

**A. Mechanical codemod (most of Phase 2 — pure renames).** A single shared rename script run per
repo. Tokens scoped to their receiver to avoid collisions with common JS words:

| Find (scoped) | Replace | Collision risk → scope |
|---------------|---------|------------------------|
| `\.resource\(` | `.getResource(` | low (distinct from `setResource`/`markResourceChanged`) |
| `world.count(` | `world.countEntities(` | scope to `world.` |
| `.entitiesMatching(` | `.listEntities(` | none |
| `world.select(` / `.select(` on world | `.selectViews(` | scope to world receiver (avoid DOM `select`) |
| `.entitiesWith(` | `.iterEntitiesWith(` | none |
| `ChangedResource(` | `OnChangedResource(` | do **before** `Changed` |
| `\bChanged\b` | `OnChanged` | word-boundary skips `ChangedResource` |
| `\bAdded\b` / `\bRemoved\b` | `OnAdded` / `OnRemoved` | + import lists |
| `rand.next(` / `rng.next(` | `.uniform(` | scope to rng receiver (avoid iterator `.next`) |
| `.int(` / `.range(` / `.roll(` on rng | `.uniformInt(` / `.uniformRange(` / `.uniformRoll(` | scope to rng receiver |
| `world.start()` | `world.startLoop()` | scope to `world.` |
| `\.step\(\s*\)` | `.stepOnce()` | only the no-arg form; `step(dt)` unchanged |

The script also rewrites the matching `import { … } from '@domecs/core'` named-import lists. Ambiguous
tokens (`.select`, `.next`, `.count`, `.start`, `.int`, `.range`, `.roll`) get a generated
review-list rather than blind replace.

**B. Manual touch-points (structural/type changes).** Per-repo checklist:

- **`mountDOM` → `Result`** — every app calling `mountDOM` must unwrap (`const r = mountDOM(...); if
  (isErr(r)) …; const handle = r.value`). Touches all DOM apps.
- **`changedOn`** — apps using `changedOn: []` → `{mode:'legacy'}`; `changedOn: [T]` →
  `{mode:'explicit', types:[T]}`. Touches DOM apps with custom redraw gating.
- **`DomecsError` `match()` sites** — apps that `match` over engine errors gain a `retryable` field
  (compiler flags each site). Touches apps doing structured error handling.
- **`SystemDef`** — valid combos still type-check; only previously-invalid combos
  (e.g. `{schedule:'fixed', triggers:[…]}`) now fail. Compiler-driven; expected near-zero edits.
- **Removed `InternalComponentType` / `__` fields** — breaks only code reaching into internals;
  expected zero external usage. Replace with `describeComponent`.

### 10.3 Coverage matrix (produced during execution)

A `repo × change` matrix, populated by scanning each consumer for the renamed symbols + manual
touch-points (a grep/codemod-dry-run sweep, parallelizable per repo). Each cell: touched? + count +
mechanical-vs-manual. This is the smoothing artifact — it tells each repo exactly what it must change
and lets the lockstep migration proceed repo-by-repo with a known scope. Generated as part of Phase 2,
before any engine rename is published.

### 10.4 Per-repo upgrade runbook (the sufficient-info guarantee)

This is the ordered procedure each consumer repo follows once Phase 2 renames are published. The
codemod (10.2A) + manual checklist (10.2B) + coverage matrix (10.3) together are the *complete*
upgrade guide — no repo should need to re-derive anything from the engine diff.

**Preconditions (from the deployment topology — see memory `domecs-demo-apps-deployment`):**
- Every app resolves the engine via `file:../domecs/packages/*` exporting **source** (`exports →
  ./src/index.ts`, no pre-build). So the upgraded engine must be checked out **alongside** the app
  at the matching commit; there is no published npm version to bump — the break is felt at the app's
  next `tsc`/`vite build`.
- The load-bearing `"domecs-workspace": "file:../domecs"` dep stays (npm re-adds it; harmless). Do
  not strip it during the upgrade.
- `vite base: './'` stays (required for the `/<repo>/` GH Pages subpath).

**Per-repo steps:**
1. **Pin the engine.** Check out the upgraded `domecs` at the Phase-2 commit beside the app; `npm
   install` so the `file:` link resolves to the new source.
2. **Baseline scan.** Run the codemod **dry-run** (10.2A) + manual-touch grep (10.2B) → this repo's
   column of the coverage matrix. If every cell is empty, the repo is unaffected — record and skip.
3. **Apply the mechanical codemod.** Runs the scoped renames + rewrites `@domecs/*` named-import
   lists. Commit this as an isolated "mechanical rename" commit so the structural diff stays legible.
4. **Resolve the review-list.** The ambiguous tokens (`.select`/`.next`/`.count`/`.start`/`.int`/
   `.range`/`.roll`) the codemod refused to blind-replace — confirm each receiver by hand.
5. **Apply manual touch-points** in matrix order: `mountDOM`→`Result` unwrap, `changedOn`→union,
   `DomecsError.match` `retryable` arms, any `SystemDef` invalid-combo, drop `InternalComponentType`/
   `__`-field reach-ins (→ `describeComponent`).
6. **Verify (red/green gate — task is not done until these pass):**
   `tsc --noEmit` clean → `vite build` clean → app boots (first-paint smoke; for input-driven apps
   confirm `tickStart`/`changedOn:[]` first-paint per `domecs-browser-app-gotchas`).
7. **Deploy** per repo: `npm run deploy` (`vite build && gh-pages -d dist`).
8. **Engine-side gate.** After all consumers are green, run `domecs` `scripts/validate-release.mjs`
   (`release:validate`) — it discovers org sibling apps and pins local `../fleet_app`; a missing
   `example/` falls back to org siblings. This is the lockstep "all consumers migrated" check.

**Ordering across repos:** generate the coverage matrix (10.3) for *all* repos **before** publishing
any rename, then migrate in dependency-free order (apps are mutually independent). The external
snapshot-history repos (studio/tessera/lighthouse) are the only ones with a non-rename structural
edit (hand-rolled history → `createSnapshotHistory`); schedule them last and treat their migration as
its own touch-point row. Each repo's existing `doc/FINDINGS_*.md` (where present) is the prior-art
reference for what that app exercises.

---

## 11. Decisions (resolved 2026-05-30)

All three open questions are resolved; the spec body above reflects them.

1. **Persist facade — RESOLVED.** Bless the shipped Result-typed free functions as the canonical
   path and delete the `createPersistence`/`Persistence` facade from `api.md` (§7). No code change,
   no consumer migration.
2. **Guideline home — RESOLVED.** The contributor guideline lands at **`domecs/doc/LEGIBILITY.md`**
   (alongside this spec and `api.md`), not `domecs/LEGIBILITY.md` and not the brainstorming default
   `docs/superpowers/specs/` (§3).
3. **`world.describe()` shape — RESOLVED.** `WorldManifest` carries the debug-tooling necessaries:
   `entityCount`, `componentCounts`, and an `archetypes` summary, in addition to the base schema
   field set (§6).
