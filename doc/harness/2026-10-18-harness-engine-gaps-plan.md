# Engine gaps for the Studio harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans. Tasks use checkbox syntax. Each task is red → green → commit.

**Goal:** ship the engine half of the Studio AI harness as three additive 2.x minors: 2.1 (determinism
foundation + build identity), 2.2 (behaviour language I + act log/replay and branching), 2.3
(behaviour language II + ergonomics + scenes).

**Spec (authoritative):** [`doc/harness/2026-10-18-harness-engine-gaps.md`](2026-10-18-harness-engine-gaps.md)
(revision 3). Section references (§) are to it. Paths below are relative to the repository root.

**Revision 3 (2026-10-19, owner decisions):** snapshots are always v3 in 2.1 (E4 unblocked; spec
§4.4); G4 act log + replay (E19) and G3 `createBranch`/`runBranch` (E20) are scheduled in 2.2 before
its RC, G14 scenes (E21) in 2.3 before its RC; only EC4 (`redefineComponent`) stays conditional.
Spec and plan now live in `doc/harness/` (committed). Studio counterpart: `../studio/docs/superpowers/specs/2026-10-18-studio-harness-design.md` and
`../studio/docs/superpowers/plans/2026-10-18-studio-harness-plan.md` (milestones H0–H9).

**Branch:** `feat/harness-engine-gaps` (one PR per milestone task group, as §8 orders them).

## Ground rules

1. The spec governs until amended in the same PR. A conflict → stop and ask the owner.
2. **Red/green TDD.** The failing test is written and run first. Per package: `pnpm --filter <pkg> test`
   (`tsc --noEmit && vitest run`).
3. **Commit per task**, conventional style with the package scope and the task id as suffix:
   `feat(core): canonicalJson with lossless -0 (E1.2)`. Never commit failing tests.
4. **PR gates (§1):** `pnpm -r test`, `pnpm -r typecheck`, `pnpm -r build && pnpm api:surface` (commit the
   regenerated `doc/api-surface/*.d.ts`), `pnpm api:check`, `pnpm doctest:check`, `pnpm test:legibility`,
   and from E8 `pnpm test:golden`.
5. **Docs in the same PR** (§3.3): api-surface, `doc/api.md` with doctest fences, SPEC section, package
   README, AGENTS.md / `skills/domecs/SKILL.md` line when agent-facing, `CHANGELOG.md`.
6. **Ledger:** each item opens its `plan/FINDINGS.md` row when work starts (ids O-75..O-90, Appendix A)
   and closes it in the PR that ships it.
7. **One naming language** (AGENTS.md rule 8): new names exactly as the spec gives them.
8. **Publishing** (`pnpm publish:npm`) happens **only with explicit owner approval**. Studio consumes
   tarballs from `scripts/pack-for-studio.mjs` (E1.6) in the meantime.
9. No network or paid calls in tests.

## Milestone map

| Release | Milestone | Spec | Ledger | Studio consumer |
|---|---|---|---|---|
| **2.1** | **E1** canonical hash + build identity (ships first as an early tarball) | §4.1, §8 | O-11 (+ O-31 if G9) | H0 |
| 2.1 | E2 `dmath` `sin`/`cos`/`sqrt` + rules swap (G19) | §4.2 | O-75 | H5 (G-cross) |
| 2.1 | E3 rule ordering contract (G20) | §4.3 | O-76 | H2.8 |
| 2.1 | E4 per-system RNG streams + snapshot v3 (G6) | §4.4 | O-77 | H2.8 |
| 2.1 | E5 registry and name lookup (G10) | §4.5 | O-30, O-78 | H2.8 |
| 2.1 | E6 `RuleError.field` (G12) | §4.6 | O-79 | H7.1 |
| 2.1 | E7 pending events in snapshots (G21) | §4.7 | O-90 | H2.8 |
| 2.1 | E8 2.1 release candidate (goldens, fork-equivalence suite, notes, pack) | §3.4, §8, §9 | — | H2.8, H5 |
| **2.2** | E9 spatial grid and index (G2) | §5.1 | O-8 | H8 |
| 2.2 | E10 cross-entity rules + `dmath` `atan2`/`hypot`/`pow` (G1) | §5.2, §4.2 | O-82, O-75 | H8 |
| 2.2 | E11 world expressions (G13) | §5.3 | O-83 | H8.3 |
| 2.2 | E12 input in rules (G16) | §5.4 | O-86 | H8.5 |
| 2.2 | E19 act log recording and replay (G4) | §7.1 | O-80 | none (studio keeps its own act log) |
| 2.2 | E20 `createBranch` / `runBranch` (G3) | §7.2 | O-81 | none (studio forks doc-aware) |
| 2.2 | E13 2.2 release candidate | §8 | — | H8 |
| **2.3** | E14 rule effects + event rules (G8) | §6.1 | O-84 | H9 |
| 2.3 | E15 contacts (G7) | §6.2 | O-85 | H9.2 |
| 2.3 | E16 `runSystems` / `render` (G15) | §6.3 | O-88 | (renderers; not studio authoritative worlds) |
| 2.3 | E17 small items: transient resources, bridge reset | §6.4 | O-36, O-89 | — |
| 2.3 | E21 `instantiateScene` / `unloadScene` (G14) | §7.3 | O-13 | none (studio keeps its catalog) |
| 2.3 | E18 2.3 release candidate | §8 | — | H9 |
| **Conditional** | EC4 `redefineComponent` (G11) | §7.4 | O-87 | none planned |

Milestones run in table order; ids E19–E21 were appended in revision 3 so every existing E-reference
stays valid (E13 and E18 remain the RCs). Dependencies: E4 needs E1 (tests hash); E7 needs E4 (v3
envelope) and E5 (`lookupEvent`) — E7 shipped on the v2 envelope while E4 was on hold (spec Appendix C)
and joins v3 when E4 lands; E10 needs E9; E15 needs E14; E19 needs E1, E4, E5 and E7 (strict hash,
own streams, `lookupEvent`, `pendingEvents` in the base hash); E20 needs E19 (`ActLog`, frame code,
`ReplayError`); E21 needs E14 (its goto-level test is an event rule); E2, E3, E6 are independent.
Studio H0 starts as soon as E1's tarball is packed.

---

## Release 2.1

### E1 — Canonical hash and build identity (§4.1, §8; O-11)

#### E1.1 Bump to 2.1.0 on the branch

- **Files:** all seven `packages/*/package.json` (`version: 2.1.0`), `CHANGELOG.md` (Unreleased 2.1.0 heading).
- [ ] **Red:** `test/release-validation.test.mjs` gains a check that every package shares one version and that `^2.0.0` satisfies it; run `pnpm test:release` → fails at 2.0.0 expectation update.
- [ ] **Green:** bump; update the expectation.
- [ ] **Commit:** `chore(release): bump packages to 2.1.0 on the harness branch (E1.1)`

#### E1.2 `canonicalJson`

- **Files:** create `packages/domecs/src/canonical.ts`; test `packages/domecs/test/canonical-hash.test.ts`.
- [ ] **Red:** sorted keys by UTF-16 code unit; `undefined`/function/symbol omitted in objects, `null` in arrays; `canonicalJson({a: -0}) === '{"a":-0}'`; `canonicalJson(JSON.parse(canonicalJson(x))) === canonicalJson(x)` for nested values with `-0`; `NaN`/`Infinity` throw `TypeError` whose message names the path (`"a.b[2]"`); BigInt and cycles throw `TypeError`.
- [ ] **Green:** implement with `Number::toString` except the `-0` literal.
- [ ] **Commit:** `feat(core): canonicalJson with lossless -0 and path-naming errors (E1.2)`

#### E1.3 `hashSnapshot`, `canonicalSnapshot`, `hashEntities`, `hashValue`

- **Files:** `packages/domecs/src/canonical.ts`, `packages/domecs/src/index.ts`; same test file.
- [ ] **Red:** the spec's tests 1–6: different component-add orders → equal hash (and different `JSON.stringify`); lossless round trip and the `-0`-sensitive fork (`1 / Body.vx` after a bounce) equal to live only through `canonicalJson`; live vs restored twin, 600 fixed steps, equal **strict** hashes every 60 ticks; heartbeat after render changes `changes` but not the default hash; golden constant for a fixture snapshot (pins FNV-1a-64); `hashEntities` localizes a one-field change. Scope: `version`, `meta`, `changes` excluded by default; `includeChanges`/`includeMeta` options.
- [ ] **Green:** FNV-1a-64 with four 16-bit limbs and `Math.imul`; `HASH_ALGORITHM = 'fnv1a64'`.
- [ ] **Commit:** `feat(core): hashSnapshot and canonicalSnapshot with strict includeChanges mode (E1.3)`

#### E1.4 Hash bench

- **Files:** `bench/` workload `hash` (1000-entity snapshot), `bench/baselines` update.
- [ ] **Red → Green:** `pnpm bench` reports hash time; target ≤ 2 ms recorded (informational).
- [ ] **Commit:** `perf(bench): hashSnapshot workload (E1.4)`

#### E1.5 `BUILD_ID` export in every package

- **Files:** `packages/*/src/build-id.ts` (`export const BUILD_ID: string = 'dev'`), each `src/index.ts`; `test/api-surface.test.mjs` expectations.
- [ ] **Red:** a core test imports `BUILD_ID` and expects a string; `pnpm api:check` fails until surfaces are regenerated.
- [ ] **Green:** add exports; `pnpm -r build && pnpm api:surface`.
- [ ] **Commit:** `feat(all): BUILD_ID export in every package (E1.5)`

#### E1.6 `scripts/pack-for-studio.mjs`

- **Files:** create `scripts/pack-for-studio.mjs`; test `test/pack-for-studio.test.mjs` (node:test, packs into a temp dir).
- [ ] **Red:** after running with `--out <tmp>`: seven tarballs named `domecs-<pkg>-2.1.0+g<sha>[-dirty].tgz`; each packed `package.json` has `version` with build metadata and `workspace:^` rewritten; `dist/build-id.js` inside each tarball exports the same id; `manifest.json` lists `{version, gitSha, dirty, packages: {name: {file, integrity, buildId}}}` with correct sha512 integrity.
- [ ] **Green:** reuse `cold-install.mjs`'s build + `pnpm pack` step; stamp `dist/build-id.js` and the packed version, then restore the working tree.
- [ ] **Accept:** studio's `npm run engine:refresh` (studio H0.2) installs the tarballs.
- [ ] **Commit:** `build(release): pack-for-studio with build metadata, BUILD_ID stamping and manifest (E1.6)`

#### E1.7 Docs and the early tarball

- **Files:** `doc/SPEC.md` §7.1 (canonical form, `-0`), §8 (equality by strict hash); `doc/api.md` ("Determinism tools"); `AGENTS.md` checklist (`hashSnapshot` replaces `JSON.stringify`); `skills/domecs/SKILL.md`; `CHANGELOG.md` (behaviour change: canonical JSON keeps `-0`); `plan/FINDINGS.md` O-11 row.
- [ ] **Red:** `pnpm doctest:check` fails on the new fences until the code exists; `pnpm test:legibility` passes.
- [ ] **Accept:** **E1 exit:** all PR gates green; `node scripts/pack-for-studio.mjs --out ../studio/vendor/domecs` run and the owner told the early tarball exists.
- [ ] **Commit:** `docs(core): canonical hash in SPEC, api.md, AGENTS checklist (E1.7)`

#### E1.8 (optional, may slip to E13) Field-level diff (G9; O-31)

- **Files:** `packages/domecs-persist/src/history.ts`, test `packages/domecs-persist/test/diff-fields.test.ts`.
- [ ] **Red:** spec test 7–8: scalar, nested, array-length, component added/removed, resource changes; `epsilon`; `limit` + `truncated`; key-order-only differences not reported; `firstDivergence` lowest-id first change, `null` when equal.
- [ ] **Commit:** `feat(persist): field-level diffSnapshots and firstDivergence (E1.8)`

### E2 — `dmath` `sin`/`cos`/`sqrt` and the rules swap (§4.2; O-75)

#### E2.1 Port `__rem_pio2`, `__rem_pio2_large`, `__sin`, `__cos`

- **Files:** create `packages/domecs/src/dmath.ts`; `scripts/dmath-golden.mjs`; `test/golden/dmath-vectors.json`; test `packages/domecs/test/dmath.test.ts`.
- [x] **Red:** accuracy test: 100k seeded inputs per function within 1 ulp of `Math.*` (2+ ulp fails); special values (±0, ±∞, NaN, subnormals, multiples of π/2 up to 2^1023) per C99 Annex F.
- [x] **Green:** straight-line musl port, `DataView` little-endian bit access, no FMA, `sqrt = Math.sqrt`.
- [x] **Then:** generate ~3000 golden vectors from the port, review them against `Math.*`, commit; a second test asserts `Object.is` equality with the vectors.
- [x] **Commit:** `feat(core): dmath sin/cos/sqrt ported from musl with golden vectors (E2.1)`

#### E2.2 Rules use `dmath`

- **Files:** `packages/domecs-rules/src/evaluator.ts` (lines 179, 181, 268, 269), test `packages/domecs-rules/test/evaluator.test.ts`.
- [x] **Red:** `installRules` with `x = sin(Px.a)` gives exactly `dmath.sin(a)` for 1000 seeded `a` (fails with `Math.sin` on inputs where they differ; include a known differing input from the platform probe).
- [x] **Green:** swap; CHANGELOG **behaviour change** (≤ 1 ulp).
- [x] **Commit:** `feat(rules): evaluate sin/cos with dmath (E2.2)`

#### E2.3 Docs and bench

- **Files:** SPEC §1 (drop planned `@domecs/math`), §8 transcendental rule → `dmath`; `doc/api.md` "Deterministic math"; rules README; `bench/` `dmath.sin` vs `Math.sin` (≤ 3×, informational).
- [x] **Commit:** `docs(core): dmath in SPEC and api.md (E2.3)`

### E3 — Rule ordering contract (§4.3; O-76)

#### E3.1 `SystemDefBase.order` in the scheduler

- **Files:** `packages/domecs/src/scheduler.ts` (comparator `:176-178`), test `packages/domecs/test/scheduler-order.test.ts`.
- [x] **Red:** `order` breaks priority ties ahead of registration index; non-finite `order` throws at `world.system()`; removal during a phase keeps O-43 semantics; `describe().systems[i].order` present (manifest field lands fully in E5).
- [x] **Commit:** `feat(core): SystemDef.order secondary sort key (E3.1)`

#### E3.2 `installRules(…, {order: 'stable', orderBase})`

- **Files:** `packages/domecs-rules/src/rules.ts`, test `packages/domecs-rules/test/ordering.test.ts`.
- [x] **Red:** the critic probe: fresh vs `update(defs)` differ in `'registration'`, equal strict hashes in `'stable'`; reordering defs via `update` reorders runs; a rule added later sits at its defs index; fork contract test (stable, compose at 100, 3 updates over 30 ticks vs fresh build restored at 30: equal for 120 ticks with fixed, tick and `random()` rules).
- [x] **Commit:** `feat(rules): stable rule ordering option (E3.2)`

#### E3.3 Docs

- **Files:** SPEC §3 (ordering triple and the bands table including scene-goto 1000), §7.1 note; `doc/api.md`; rules README "Ordering".
- [x] **Commit:** `docs(rules): ordering contract and priority bands (E3.3)`

### E4 — Per-system RNG streams and snapshot v3 (§4.4; O-77)

#### E4.1 Root seed, `deriveStream`, stream map

- **Files:** `packages/domecs/src/rng.ts`, `packages/domecs/src/world.ts`, `packages/domecs/src/snapshot.ts` (`SNAPSHOT_VERSION = 3`, `rngRoot`, `rngStreams`), test `packages/domecs/test/rng-streams.test.ts`.
- [x] **Red:** golden: `deriveStream([1,2,3,4], 'rule:move')` first four draws; `rng: 'own'` systems keyed by cursor key (`s`, `s#1`); removal keeps the entry; `snapshot()` writes all entries; JSON round trip keeps them; invalid `rngRoot`/`rngStreams` throw before any state change; a v2 snapshot restores and streams re-derive; **always v3**: a world with no own-stream system writes `version: 3` with `rngRoot` and without `rngStreams`, and `snapshot({ pendingEvents: true })` is v3 too; `describe().systems[i].rng` reports `'shared'`/`'own'` (deferred from E5.2).
- [x] **Commit:** `feat(core): per-system RNG streams keyed by cursor key; snapshot v3 (E4.1)`

#### E4.2 Missing-key re-derive and reseeding

- **Files:** `packages/domecs/src/world.ts` (restore), same test file.
- [x] **Red:** spec tests 8–9: world B with an extra own-stream rule R3 restores A's snapshot → R3 draws `deriveStream(rngRoot, 'rule:R3')`, B's next snapshot lists it, and snapshot → restore of B continues identically for 100 ticks (strict hash); replacing `rngRoot` + `seed` and clearing `rngStreams` changes every own stream, twice → identical.
- [x] **Commit:** `feat(core): re-derive own streams missing from a restored snapshot (E4.2)`

#### E4.3 Rules `rng` option and persist migration

- **Files:** `packages/domecs-rules/src/rules.ts` (`RuleDef.rng`, `InstallRulesOptions.rng`), test `packages/domecs-rules/test/rng.test.ts`; `packages/domecs-persist/src/migrate.ts` (`[2, snap => ok({...snap, version: 3})]`), test `migrate.test.ts`.
- [x] **Red:** the probe as a test (B's draws unchanged with/without A under `'own'`, changed under `'shared'`); `update(defs)` every tick leaves own sequences unchanged; persist `load` migrates v2 → v3 and a v2 save still loads; `save` writes v3.
- [x] **Commit:** `feat(rules,persist): rng option for rules; built-in v2→v3 migration (E4.3)`

#### E4.4 Docs

- **Files:** SPEC §2.8, §2.5, §7.1, §7.3; `doc/api.md`; rules and persist READMEs; CHANGELOG (**behaviour change**: every 2.1 snapshot is v3, so 2.0 engines reject 2.1 saves; 2.0 saves still load); `plan/FINDINGS.md` O-77 row.
- [x] **Commit:** `docs(core): RNG streams and snapshot v3 (E4.4)`

### E5 — Registry and name lookup (§4.5; O-30, O-78)

#### E5.1 `register`, `lookupComponent`/`lookupEvent`/`lookupResource`, `eventTypes`

- **Files:** `packages/domecs/src/world.ts`, `packages/domecs/src/events.ts`, test `packages/domecs/test/registry.test.ts`.
- [x] **Red:** registered-but-unused component appears in `componentTypes()`; lookups hit/miss; two same-named events → `lookupEvent` `undefined` and the second `register` returns `name_conflict`; `eventTypes()` first-seen order.
- [x] **Commit:** `feat(core): eager register and by-name lookup (E5.1)`

#### E5.2 Manifest additions and descriptions

- **Files:** `packages/domecs/src/manifest.ts`, `packages/domecs/src/types.ts` (`FieldSchema.description`, `EventDefOptions.description`, `SystemDefBase.meta`), `packages/domecs-persist/src/schema.ts`, tests.
- [x] **Red:** `describe().systems` carries `priority`, `order`, `rng` (deferred from E5 and shipped in E4.1; asserted in `packages/domecs/test/rng-streams.test.ts`), sorted `components`, cloned `meta` (mutation does not leak); `FieldSchema.description` round-trips through `serializeComponentType`/`registerComponentTypes`.
- [x] **Commit:** `feat(core,persist): richer manifest and field descriptions (E5.2)`

#### E5.3 `bridge.act(name, …)`

- **Files:** `packages/domecs/src/agent.ts`, test `packages/domecs/test/agent-bridge.test.ts`.
- [x] **Red:** `act('Damage', {amount: 3})` equals `act(Damage, …)` including schema rejection; unknown or ambiguous name → `{accepted: false, consumedTurn: false}` with no emit and no tick.
- [x] **Commit:** `feat(core): name-based AgentBridge.act (E5.3)`

#### E5.4 Docs

- **Files:** SPEC §2.3, §2.6; `doc/api.md`; AGENTS.md observe/act table; SKILL.md; persist README.
- [x] **Commit:** `docs(core): registry, lookup and name-based act (E5.4)`

### E6 — `RuleError.field` (§4.6; O-79)

#### E6.1 Attribute every compile error

- **Files:** `packages/domecs-rules/src/rules.ts`, test `packages/domecs-rules/test/rules.test.ts` (table-driven).
- [x] **Red:** one def per error class → expected `field` and `position` per the spec table (schedule, priority, `{query: i}`, when, `{action: i, part}`, name).
- [x] **Green:** set `field` in `compileRule` and `update()`; README "Errors" recommends a default branch.
- [x] **Commit:** `feat(rules): RuleError.field attribution (E6.1)`

### E7 — Pending events in snapshots (§4.7; O-90)

#### E7.1 Snapshot and restore pending events

- **Files:** `packages/domecs/src/world.ts` (snapshot options, restore `:1999-2025`), `packages/domecs/src/world-state.ts` (`buildSnapshot`, `validateEnvelope`), `packages/domecs/src/snapshot.ts`, test `packages/domecs/test/pending-events.test.ts`.
- [x] **Red:** spec tests 1–6: an in-flight `Ping` survives a fork only with `pendingEvents: true` (strict hashes equal for 60 ticks); bus order across types; unknown and ambiguous names throw before any change; non-plain payload throws `TypeError` only with the option; `canonicalSnapshot` differs when only `pendingEvents` differs; `world.pendingEvents()` matches and does not consume.
- [x] **Green:** `SnapshotOptions.pendingEvents`, `WorldSnapshot.pendingEvents`, restore re-queues through `lookupEvent`, `World.pendingEvents()`; canonical inclusion.
- [x] **Commit:** `feat(core): pending events travel with opt-in snapshots (E7.1)`

#### E7.2 Docs

- **Files:** SPEC §7.1 "Pending events" amendment, §2.6 note; `doc/api.md`; AGENTS.md "Post-restore rebuild" note (register event types used in flight).
- [x] **Commit:** `docs(core): pending events in snapshots (E7.2)`

### E8 — 2.1 release candidate

#### E8.1 Dual-runtime golden

- **Files:** create `scripts/determinism-golden.mjs`, `test/golden.test.mjs`, `test/golden/determinism.json`; root script `test:golden`.
- [x] **Red:** the test spawns the script under `process.execPath` and compares its `fixtures` and `dmathFingerprint` (not `buildId`) with the committed JSON; with `DOMECS_ALT_RUNTIME` it also spawns under that binary and requires identical output; fixtures: `sin`/`cos`, `random()`, own streams, a `-0` bounce; strict hashes.
- [x] **Commit:** `test(release): dual-runtime determinism golden (E8.1)`

#### E8.2 Fork-equivalence suite

- **Files:** create `packages/domecs-rules/test/fork-equivalence.test.ts`.
- [x] **Red → Green:** live vs fresh build + restore (`pendingEvents: true`) with tick and fixed rules, compose at 100, own streams, spawns, `-0` values: equal strict hashes over ≥ 120 ticks after edits.
- [x] **Commit:** `test(rules): fork-equivalence suite for 2.1 (E8.2)`

#### E8.3 Release notes and gates

- **Files:** `doc/release-notes/v2.1.0.md`, `CHANGELOG.md`.
- [x] **Accept:** **E8 exit:** `pnpm bench` (no regression), `pnpm test:plantroom`, `pnpm test:legibility`, `pnpm cold-install`, `pnpm test:golden` (plus `DOMECS_ALT_RUNTIME` with the studio's pinned Electron) all green; `pack-for-studio` tarball delivered; **publish only on owner approval**.
- [x] **Commit:** `docs(release): 2.1.0 release notes (E8.3)`

---

## Release 2.2

### E9 — Spatial grid and index (§5.1; O-8)

#### E9.1 `createSpatialGrid` (core)

- **Files:** create `packages/domecs/src/spatial-grid.ts`; test `packages/domecs/test/spatial-grid.test.ts`.
- [ ] **Red:** `within`/`nearest`/`pairs` equal a brute-force oracle on 2000 seeded points (duplicates, borders, negatives) for each cell size in `[0.5, 1, 7, 32, 100, 1e6]`, and the outputs are identical across cell sizes; same output for any insertion order; ties → lowest id; NaN/∞ not indexed.
- [ ] **Green:** exact cell coordinates; `nearest` stops on the conservative integer ring bound `(k − 1) × cellSize`.
- [ ] **Commit:** `feat(core): createSpatialGrid with cell-size-independent results (E9.1)`

#### E9.2 `createSpatialHash` (scene)

- **Files:** create `packages/domecs-scene/src/spatial-hash.ts`; test `packages/domecs-scene/test/spatial-hash.test.ts`.
- [ ] **Red:** tag filters, `exclude`, refresh after moves and despawns, `pairs(r, a, b)` canonical order; building/querying leaves `hashSnapshot` unchanged.
- [ ] **Commit:** `feat(scene): world-bound spatial index (E9.2)`

#### E9.3 Docs and bench

- **Files:** SPEC §1, new §2.12; `doc/api.md`; scene README; `bench/` `spatial` workload (refresh ≤ 0.1 ms, nearest ≤ 2 µs at 1000 entities).
- [ ] **Commit:** `docs(scene): spatial queries (E9.3)`

### E10 — Cross-entity rules and `dmath` additions (§5.2, §4.2; O-82, O-75)

#### E10.1 `dmath` `atan2`, `hypot`, `pow`

- **Files:** `packages/domecs/src/dmath.ts` (musl `atan2` + `atan` kernel, `hypot`; fdlibm `e_pow.c`), vectors, tests.
- [ ] **Red:** accuracy ≤ 1 ulp vs `Math.*` over 100k inputs each; specials; golden vectors.
- [ ] **Commit:** `feat(core): dmath atan2/hypot/pow (E10.1)`

#### E10.2 Lexer, parser and AST

- **Files:** `packages/domecs-rules/src/{lexer.ts,parser.ts,ast.ts}`, test `parser.test.ts`.
- [ ] **Red:** every new form with positions; arity errors; reserved words (`self`, `tick`, `other`, `event`, `pointer`; `id` after an entity); `first.x` still `Component.field`; `??` precedence cases; O-66 limits hold; `walkComponentRefs` visits members, sets and `has` targets; `walkFieldRefs` unchanged.
- [ ] **Commit:** `feat(rules): grammar for selectors, aggregates, math and ?? (E10.2)`

#### E10.3 Evaluator environment and semantics

- **Files:** `packages/domecs-rules/src/{evaluator.ts,typecheck.ts,rules.ts}`, tests `evaluator.test.ts`, new `cross-entity.test.ts`.
- [ ] **Red:** chase oracle; `nearest` vs brute force over 500 entities with ties and `maxDistance`; aggregates (empty sets, skipped members, non-number fault, memoized == non-memoized); `??` catches no-value only; Gauss–Seidel read timing with live == fork; `without` and `{without: i}` errors; spatial forms without `spatial` → compile error with the right `field`; `atan2`/`pow`/`hypot` equal `dmath` bit for bit.
- [ ] **Commit:** `feat(rules): cross-entity reads, selectors, aggregates and spatial forms (E10.3)`

#### E10.4 Docs, golden and type-level note

- **Files:** rules README (grammar, cost model, default branch for `FunctionName`); SPEC rules appendix; `doc/api.md`; AGENTS.md "Behaviours as rules"; SKILL.md; CHANGELOG **type-level change** (`FunctionName` widens) and reserved-words behaviour change; `scripts/determinism-golden.mjs` adds chase, keep-distance, `atan2`/`hypot`/`pow`, `nearest`, `countWithin`; bench cost targets.
- [ ] **Commit:** `docs(rules): rules language I reference and golden scenarios (E10.4)`

### E11 — World expressions (§5.3; O-83)

#### E11.1 `compileWorldExpression`

- **Files:** create `packages/domecs-rules/src/world-expression.ts`; test `world-expression.test.ts`.
- [ ] **Red:** rejected forms (bare `C.f`, `self`, `has(C)`, centre-less `distanceTo`/`countWithin`, `dt`, `random()`) with positions; values match JS oracles; strict hash unchanged after 1000 evaluations; `??` fallback; no throws for bad input.
- [ ] **Commit:** `feat(rules): world expressions for metrics (E11.1)`

### E12 — Input in rules (§5.4; O-86)

#### E12.1 `key`/`pressed`/`released`/`mod`/`pointer`

- **Files:** `packages/domecs-rules/src/{parser.ts,evaluator.ts,typecheck.ts,rules.ts}`, test `input.test.ts`.
- [ ] **Red:** held and edge reads against `setInput`; `pressed`/`released` in a `fixed` rule → compile error; input forms in world expressions → compile error; the same `setInput` sequence applied to live and to a fork restored mid-sequence → equal strict hashes.
- [ ] **Commit:** `feat(rules): input reads in rules (E12.1)`

### E19 — Act log recording and replay (§7.1; O-80)

Scheduled in revision 3 (was EC1). Includes every review fix the spec carries: `via`, `startScale`,
plugin-hook emits (full ticks **and** heartbeats), scale read on `runTick` entry, strict-hash
checkpoints. Core tests use a core system with `rng: 'own'` where the spec says "own-stream rule".

#### E19.1 `encodeInput` / `decodeInput`

- **Files:** create `packages/domecs/src/replay.ts`; `packages/domecs/src/index.ts`; test `packages/domecs/test/replay.test.ts`.
- [ ] **Red:** spec test 2: round trip of an `InputSnapshot` with keys, pressed/released, mods, pointer (incl. `entered`), gamepads and focus; arrays sorted; empty `pressed`/`released` and absent optional parts omitted; `decodeInput(encodeInput(x))` deep-equals `x` (Sets rebuilt); the encoded value survives `JSON.parse(JSON.stringify(…))`.
- [ ] **Green:** `JsonInput`, `encodeInput`, `decodeInput`.
- [ ] **Commit:** `feat(core): JSON input encoding for act logs (E19.1)`

#### E19.2 World-internal tap and `createRecorder`

- **Files:** `packages/domecs/src/world.ts` (symbol-keyed tap, `internal()` pattern; emit sites, `runTick` entry, mutation sites, `restore`), `packages/domecs/src/replay.ts`; same test file.
- [ ] **Red:** external emits recorded with `via: 'emit' | 'action'` into the next frame (spec test 4: emits from systems and `on` handlers are not recorded); plugin `onTickStart` emits recorded during a full tick and during a heartbeat (half of test 9); frames carry `{tick, dt, scale?, input?}` with `dt: null` for `stepOnce`, `scale` read on `runTick` entry (a `tickStart` hook setting `scale = 0` at tick 50 records the pre-hook scale; half of test 10) and input delta-encoded after `onTickStart`; a heartbeat between acts does not split them into an extra frame and `setInput` + heartbeat records nothing (test 6); out-of-tick spawn/despawn/add/remove/`markChanged`/`setResource` records `out_of_tick_mutation`, a non-JSON payload `unserializable_payload`, `restore()` `restore` (half of test 3); `hashEvery: k` appends strict-hash checkpoints at tick ends where `tick % k === 0`; `startScale`, `fixedStep`, `baseHash` (strict, `pendingEvents: true`) set at creation; `peek()` returns a copy, `stop()` detaches (`active === false`).
- [ ] **Green:** the tap (not a public signal), `ActRecord`, `ActLogFrame`, `ActLog`, `Recorder`, `createRecorder`.
- [ ] **Note:** the spec's gap union lists `'heartbeat_input'`, but §7.1 says `setInput` + heartbeat records nothing, so no rule produces it. Drop it from the union unless implementation finds a case that needs it, and record the choice in spec Appendix C (E19 notes).
- [ ] **Commit:** `feat(core): act-log recorder on a world-internal tap (E19.2)`

#### E19.3 `replay`

- **Files:** `packages/domecs/src/replay.ts`; same test file.
- [ ] **Red:** spec test 1: 300 recorded frames (mixed acts, `step(1/60)`, `stepOnce`, a scale change, input changes) on a world with tick, fixed and event systems and an own-stream system replay on a fresh world restored from the base with equal strict hashes at every checkpoint and at the end; test 3: replay past an `out_of_tick_mutation` gap reports `diverged` at the next checkpoint; test 5: unknown or ambiguous name → `unknown_event` before any emit for that frame, schema-invalid `via: 'action'` payload → `rejected_payload`, the same payload `via: 'emit'` replays unvalidated; test 7: `toTick` stops at the right tick; test 8: the JSON-parsed log replays identically; tests 9–10 replay legs (world without the emitting plugin; paused ticks reproduced); `base_mismatch` when the world is not at `baseHash`; `invalid_log` for a wrong `format`/`version`. No throws for bad logs.
- [ ] **Green:** `ReplayError`, `ReplayOptions`, `replay` (restore base → `setScale(startScale)` → base-hash check → per frame: scale, input, acts via `lookupEvent`, `stepOnce`/`step(dt)` → checkpoints). Export the frame-application helper internally for E20.
- [ ] **Commit:** `feat(core): replay act logs with checkpoint verification (E19.3)`

#### E19.4 Docs

- **Files:** SPEC new §7.5 "Act logs and replay" (preconditions: same setup, no input plugin, no `tickStart` scale mutators, no re-run `once`); `doc/api.md` with a `ts doctest` record → replay fence; AGENTS.md "Durable log" and "History vs named saves" recipes plus a new "Record and replay" recipe; `skills/domecs/SKILL.md`; `pnpm -r build && pnpm api:surface` (`core.d.ts`); CHANGELOG; `plan/FINDINGS.md` O-80 row.
- [ ] **Red:** `pnpm doctest:check` fails on the new fence until E19.3 exists; `pnpm api:check` passes after regeneration.
- [ ] **Commit:** `docs(core): act logs and replay in SPEC, api.md and AGENTS recipes (E19.4)`

### E20 — `createBranch` / `runBranch` (§7.2; O-81)

Scheduled in revision 3 (was EC2). Includes the review fixes: `once_systems` error, explicit `scale`,
sampling counted from the call start plus the final tick, `WorldSetup<T>`.

#### E20.1 `createBranch`

- **Files:** create `packages/domecs/src/branch.ts`; `packages/domecs/src/index.ts`; test `packages/domecs/test/branch.test.ts`.
- [ ] **Red:** spec test 7: a setup registering an enabled `once` system with `from.tick > 0` → `once_systems` naming it; test 8: a source at `scale = 2` matches `createBranch(…, { scale: 2 })` and not the default; test 6 (restore half): a snapshot that fails validation → `restore_failed` with a serialized cause and no throw; a throwing `setup` propagates; `setup`'s return value comes back as `setup`; `fixedStep`/`seed` defaults.
- [ ] **Green:** `WorldSetup<T>`, `BranchOptions`, `BranchError`, `createBranch` (headless world → `setup` → `restore(from)` → `setScale`).
- [ ] **Commit:** `feat(core): createBranch builds a headless world restored from a snapshot (E20.1)`

#### E20.2 `runBranch`

- **Files:** `packages/domecs/src/branch.ts`; same test file.
- [ ] **Red:** spec test 1: live steps 120 ticks, a branch from its tick-30 snapshot (`pendingEvents: true`) steps 90 → equal `finalHash`; test 2: two branches from one snapshot are identical, and a setup that differs by one own-stream system leaves the other systems' sampled values unchanged; test 3: `runBranch(60)` + `runBranch(60)` equals `runBranch(120)`; test 4: `until` and `shouldStop` give the right `stoppedBy` and tick with the final tick sampled each time, `sampleEvery: 7` from a base at tick 30 samples 37, 44, …, and the last; test 5: a log with acts at ticks equals a live world receiving the same acts (E19 frame code); test 6: faults collected from `signals.faultRaised` for the call only; `keyframeEvery`/`hashEvery` outputs (strict hashes); dev-mode probe check flags a mutating probe at the first sample.
- [ ] **Green:** `RunBranchOptions`, `BranchRun`, `runBranch` (synchronous; log errors surface as `ReplayError`).
- [ ] **Commit:** `feat(core): runBranch with probes, keyframes, hashes and cancellation (E20.2)`

#### E20.3 Docs

- **Files:** SPEC §7.5 (with replay; restore-continuation preconditions); `doc/api.md` with a `ts doctest` branch-and-compare fence; AGENTS.md recipe "Branch and compare" (replaces the plantroom pattern for headless use); `skills/domecs/SKILL.md`; `pnpm -r build && pnpm api:surface` (`core.d.ts`); CHANGELOG; `plan/FINDINGS.md` O-81 row.
- [ ] **Red:** `pnpm doctest:check` fails on the new fence until E20.2 exists.
- [ ] **Commit:** `docs(core): branches in SPEC, api.md and AGENTS recipes (E20.3)`

### E13 — 2.2 release candidate

- [ ] **E13.1** `doc/release-notes/v2.2.0.md` (reserved words; `FunctionName` type-level change; new act log, replay and branch APIs), golden updated (owner-reviewed), fork-equivalence extended with chase rules and a rules-level leg for E19/E20 (a live world recorded with `createRecorder` vs a fresh build replaying the log from its base, and a `createBranch` + `runBranch` arm, with own-stream rules: equal strict hashes over ≥ 120 ticks after edits), all §8 gates, `pack-for-studio`. **Publish only on owner approval.** **Commit:** `docs(release): 2.2.0 release notes (E13.1)`
- **E13 exit gate:** E9–E12, E19 and E20 merged with their ledger rows (O-8, O-82, O-83, O-86, O-80, O-81) closed; `replay.test.ts` and `branch.test.ts` green; AGENTS.md "Record and replay" and "Branch and compare" recipes doctested; `pnpm bench`, `pnpm test:plantroom`, `pnpm test:legibility`, `pnpm cold-install`, `pnpm test:golden` green.
- [ ] **E13.2** (only if E1.8 slipped) field-level diff lands here.

---

## Release 2.3

### E14 — Rule effects and event-triggered rules (§6.1; O-84)

#### E14.1 Event rules

- **Files:** `packages/domecs-rules/src/rules.ts` (`schedule: 'event'`, `on`, `self`, `other`), parser (`event.f`, `other`), tests `rules.test.ts`.
- [ ] **Red:** `act('Move', {target, dx})` with `self: 'event.target'` moves only that entity; broadcast and world-scope rules; a `set` in a world-scope rule → compile error; `on`/`event.f`/`other` compile checks with `field` attribution.
- [ ] **Commit:** `feat(rules): event-triggered rules (E14.1)`

#### E14.2 Effects

- **Files:** `packages/domecs-rules/src/effects.ts`, test `effects.test.ts`.
- [ ] **Red:** `emit` arrives next tick and chains; schema-invalid emit faults; a fork snapshotted (`pendingEvents: true`) between emit and delivery delivers it (strict hashes equal); spawn ids deterministic, prefab bags not shared; deferred despawn; atomicity (failed action → no effects); live vs fork with spawns/despawns/emits in flight.
- [ ] **Commit:** `feat(rules): deferred emit/spawn/despawn/add/remove effects (E14.2)`

#### E14.3 Docs

- **Files:** rules README ("Event rules", "Effects"); `doc/api.md`; AGENTS.md "Commands as event rules"; SKILL.md.
- [ ] **Commit:** `docs(rules): event rules and effects (E14.3)`

### E15 — Contacts (§6.2; O-85)

#### E15.1 `installContacts`

- **Files:** create `packages/domecs-scene/src/contacts.ts`; test `packages/domecs-scene/test/contacts.test.ts`.
- [ ] **Red:** begin/stay/end vs oracle; same-tag pairs; despawn ends contact; snapshot mid-contact with begin/end in flight (`pendingEvents: true`) restores to identical events and strict hashes; rules integration (contact damage via an event rule); default priority 150; bench ≤ 0.5 ms at 1000 entities × 2 pairs.
- [ ] **Commit:** `feat(scene): contact events for rules (E15.1)`

### E16 — `runSystems` and `render` (§6.3; O-88)

#### E16.1 Run named systems / render without a tick

- **Files:** `packages/domecs/src/world.ts`, test `packages/domecs/test/run-systems.test.ts`.
- [ ] **Red:** after `restore`, `runSystems([compose name])` populates `WorldTransform` with `tick` unchanged; unknown/other-schedule names reported as skipped; `render()` calls `onRender` without `tickStart`/`tickEnd`; default hash unchanged by `render()`.
- [ ] **Commit:** `feat(core): runSystems and render without a tick (E16.1)`

### E17 — Small items (§6.4; O-36, O-89)

- [ ] **E17.1** `defineResource(name, {transient: true})` (**new option**): snapshot omits it; restore keeps the live value; hash stable when a camera resource changes. **Commit:** `feat(core): transient resources (E17.1)`
- [ ] **E17.2** `AgentBridge.reset({scale, input})`: episode-boundary hygiene test in `agent-bridge.test.ts`; `once` systems documented as not re-run. **Commit:** `feat(core): bridge reset options (E17.2)`

### E21 — `instantiateScene` / `unloadScene` (§7.3; O-13)

Scheduled in revision 3 (was EC3).

#### E21.1 `SceneMember` and `instantiateScene`

- **Files:** create `packages/domecs-scene/src/scenes.ts`; `packages/domecs-scene/src/index.ts`; test `packages/domecs-scene/test/scenes.test.ts`.
- [ ] **Red:** spec test 1: ids are deterministic (spawn in array order; same data → same ids in two worlds); test 2: `parent` keys become `setParent` links, a cycle and a missing key are reported as problems with paths, never thrown; test 3: `refFields` remap string keys to live ids, an unknown key is a problem and the field is left unchanged; test 4: an unknown component name is a problem, that component is skipped and the entity still spawns; a duplicate key is a problem and the second entity spawns as `key#2`; each spawn carries `SceneMember{scene, key}` with values built from the component's defaults plus the given fields.
- [ ] **Green:** `SceneMember` (schema'd, persistent), `SceneEntityData`, `SceneData`, `SceneProblem`, `InstantiateSceneOptions`, `instantiateScene` (spawn → parent by key → remap `refFields`).
- [ ] **Commit:** `feat(scene): instantiateScene with key remapping and reported problems (E21.1)`

#### E21.2 `unloadScene` and `sceneEntities`

- **Files:** `packages/domecs-scene/src/scenes.ts`; same test file.
- [ ] **Red:** spec test 5: two scenes plus unrelated entities, `unloadScene('a')` despawns exactly scene a's trees (member roots via `despawnTree`) and returns the count; `sceneEntities` lists members in ascending id; test 6: instantiate → snapshot → restore into a fresh world gives an equal strict hash, and `sceneEntities`/`unloadScene` work on the restored world.
- [ ] **Green:** `unloadScene`, `sceneEntities`.
- [ ] **Commit:** `feat(scene): unloadScene and sceneEntities (E21.2)`

#### E21.3 "Goto level" through an event rule

- **Files:** `packages/domecs-scene/package.json` (dev dependency `@domecs/rules: workspace:*`, unless E15 already added it); same test file.
- [ ] **Red:** spec test 7: an event rule (§6.1, E14) on a `GotoScene` command writes the requested scene name (`event.scene`) into a field of a level-state entity, and after the step the host reads it and calls `unloadScene` + `instantiateScene`; the live world and a fork restored mid-sequence (`pendingEvents: true`) reach equal strict hashes. No rule effect for scenes is added.
- [ ] **Commit:** `test(scene): goto-level event rule with host-driven scene swap (E21.3)`

#### E21.4 Docs

- **Files:** scene README "Scenes"; `doc/api.md` with a `ts doctest` fence; SPEC §7 note (O-13 partly closed: unknown-type surfacing); `pnpm -r build && pnpm api:surface` (`scene.d.ts`); CHANGELOG; `plan/FINDINGS.md` O-13 row (partial).
- [ ] **Red:** `pnpm doctest:check` fails on the new fence until E21.2 exists.
- [ ] **Commit:** `docs(scene): scenes in README, api.md and SPEC (E21.4)`

### E18 — 2.3 release candidate

- [ ] **E18.1** `doc/release-notes/v2.3.0.md` (including the new scene APIs); golden adds an event chain snapshotted with events in flight; fork-equivalence extended with effects, contacts and a scene swap (instantiate/unload between snapshots); all §8 gates; `pack-for-studio`. **Publish only on owner approval.** **Commit:** `docs(release): 2.3.0 release notes (E18.1)`
- **E18 exit gate:** E14–E17 and E21 merged with their ledger rows (O-84, O-85, O-88, O-36, O-89, O-13 partial) updated; `scenes.test.ts` green; `pnpm bench`, `pnpm test:plantroom`, `pnpm test:legibility`, `pnpm cold-install`, `pnpm test:golden` green.

---

## Conditional item (not scheduled; §7.4)

Revision 3 scheduled the former EC1–EC3 as E19 (act log + replay, 2.2), E20 (`createBranch` /
`runBranch`, 2.2) and E21 (scenes, 2.3). One item stays conditional. It is planned only when a named
consumer opens a ledger row asking for it; then it gets its own milestone in the next minor, with
tasks taken from its spec section's test list:

- **EC4** `redefineComponent` (§7.4, O-87) — gate: studio measures rebuild > 50 ms at 1000 entities.
