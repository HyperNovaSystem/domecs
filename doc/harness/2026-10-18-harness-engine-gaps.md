# Engine gaps for the Studio AI harness — design spec

_Drafted 2026-10-18 on branch `feat/harness-engine-gaps` (base `b425242`, engine 2.0.0)._
_Status: **in implementation** (revision 3). E1–E7 have landed on the branch (E4 after the
revision-3 snapshot decision; the E5 manifest `rng` field shipped with it). When this spec and the code disagree, this spec
governs until it is amended in the same PR (studio ground rule: "spec authoritative")._
_Revision 2 (2026-10-18): the determinism, product and feasibility reviews are applied. Items
moved (G16 into 2.2; G3, G4, G14 to the conditional group §7), new items were added (G19–G21
naming, §4.7 pending events, `BUILD_ID`), and rejected or modified review items are listed in
Appendix C. The implementation plan is
[`doc/harness/2026-10-18-harness-engine-gaps-plan.md`](2026-10-18-harness-engine-gaps-plan.md)._
_Revision 3 (2026-10-19): owner decisions applied. Snapshots are **always v3 in 2.1** (§4.4,
§3.2, ED-2), which unblocks E4. G4 act log + replay and G3 `createBranch`/`runBranch` are
**scheduled in 2.2**, and G14 `instantiateScene`/`unloadScene` in **2.3** (§7.1–§7.3 keep their
section numbers so cross-references stay valid; ED-13). Only G11 `redefineComponent` (§7.4)
stays conditional. The spec and plan moved from the gitignored `plan/` folder to `doc/harness/`
and are now committed. Dispositions: Appendix C, "Owner decisions — revision 3"._
_Paths in this document are relative to the repository root unless they are Markdown links._

**Governing documents.** `plan/PLAN.md` (direction; §5 says "the ledger is fuel" and records Studio
as an in-policy puller), `plan/FINDINGS.md` (the O-ledger), `doc/SPEC.md` (runtime semantics),
`doc/api.md` + `doc/api-surface/` (the type contract), `AGENTS.md` (naming and hard rules).

**Inputs** (read in full; the critic resolves contradictions and wins where it does), in the
2026-10-18 survey working folder `harness/` (session scratch, not committed; the findings this
spec relies on are restated in it with their evidence, Appendix B):
`survey-critic.md` (authoritative), `survey-engine.md` (gap ids G1–G18), `survey-studio.md`,
`survey-agent-sdks.md`, `survey-platform.md`. Probes cited: `critic/order2.mjs` (registration-order
drift), `probe/rng.mjs` (shared-RNG coupling), `probe/bench.mjs` (cost), platform `det/sim.mjs`
(Node vs Electron libm).

**Owner direction (intent).** The engine (data-manifold ⇄ ECS ⇄ DOM) is good. Studio becomes a
desktop AI harness for building DOMECS simulations, with an HTTP API (CRUD) and an MCP server
(tooling), Claude and Codex agent providers, and GUI concept E. The high-value piece is the
**predictive timeline**: outcomes of forks run ahead of the playhead. "Fix the gaps in the engine."
This document is the engine half of that work.

---

## 0. Summary

The kernel already supports the harness loop: deterministic stepping, snapshot/restore that
continues the live timeline (O-38, O-40, O-42, O-46), `action()` results, `describe()`. The gaps
fall into two groups:

1. **What "same outcome" means.** Forks must equal the live world bit for bit, in the runtime the
   app actually uses (Electron), and an A/B comparison must not be polluted by unrelated
   randomness. That needs five things:
   - a canonical, lossless hash (`-0` kept; `changes` included for restore equivalence);
   - deterministic transcendentals;
   - an ordering contract that survives `rules.update()`;
   - per-system RNG streams that re-derive for systems a fork adds;
   - in-flight events that travel with the snapshot.
2. **What a project can express without code.** Rules can only read and write the entity being
   evaluated, and can only `set` fields. Concept E's behaviours (chase, keep distance, on contact,
   on command) cannot be written as data. So branches cannot rebuild them, and agents cannot
   propose them.

| Release | Theme | Items (spec §) | Ledger | Size |
|---|---|---|---|---|
| **2.1** | Determinism foundation + build identity | §4.1 canonical hash (G5; field diff G9 optional, may slip to 2.2) · §4.2 `dmath` `sin`/`cos`/`sqrt` + rules swap (G19) · §4.3 rule ordering contract (G20) · §4.4 per-system RNG streams (G6) · §4.5 registry and name lookup (G10) · §4.6 `RuleError.field` (G12) · §4.7 pending events travel with the snapshot (G21) · §8 `BUILD_ID` + `pack-for-studio` | O-11, O-31, O-75, O-76, O-77, O-30, O-78, O-79, O-90 | ≈ 2 wk |
| **2.2** | Behaviour language I + record/replay and branching | §5.1 spatial grid and index (G2) · §5.2 cross-entity refs, aggregates, math (+ `dmath` `atan2`/`hypot`/`pow`), `??`, `without` (G1) · §5.3 world expressions (G13) · §5.4 input in rules (G16) · §7.1 act log + replay (G4) · §7.2 `createBranch`/`runBranch` (G3) | O-8, O-82, O-83, O-86, O-80, O-81 | ≈ 4.5 wk |
| **2.3** | Behaviour language II + authoring ergonomics + scenes | §6.1 rule effects + event-triggered rules (G8) · §6.2 contacts (G7) · §6.3 `runSystems`/`render` (G15) · §6.4 small items (O-36, bridge reset) · §7.3 `instantiateScene`/`unloadScene` (G14) | O-84, O-85, O-88, O-36, O-89, O-13 | ≈ 3.5 wk |
| **Conditional** | Built only when a named consumer asks (gate in §7.4) | §7.4 `redefineComponent` (G11) | O-87 | — |

The order follows the critic's phases: Phase 1 is the determinism foundation and becomes 2.1.
Phase 4 is the behaviour language (G2 → G1 → G13 → G16 → G8 → G7 → G15), split across 2.2 and
2.3. Three placements changed in revision 2:

- **G16 (input in rules) moved into 2.2**, so the first interactive demo (a keyboard-controlled
  player plus chase: G1 + G2 + G16) needs only 2.2 (product review 18).
- **G3, G4 and G14 became conditional** (§7). Studio already owns a doc-aware fork, an act log
  and a level catalog, so the engine versions would duplicate them with less information (they
  cannot see doc versions). Their specs keep every review fix, so they are ready if a consumer
  (an external engine user, AGENTS.md recipes) asks. Per critic C4, the predictive timeline
  needs **no** engine change to fork.
  **Revision 3 (owner, 2026-10-19): all three are scheduled.** G4 and G3 ship in 2.2 after §5.4
  (G3's `runBranch` takes G4's `ActLog` and returns its `ReplayError`), G14 ships in 2.3 after
  §6.4 (its "goto level" test uses §6.1 event rules). Studio still keeps its own doc-aware
  versions; the engine versions serve engine users and the AGENTS.md recipes. The predictive
  timeline still needs no engine change to fork.
- **G10 stays in 2.1** although studio only needs project-event lookup after G8: §4.7's restore
  resolves pending events by name through `lookupEvent`.

**Gap ids.** G1–G18 are the engine survey's ids. Revision 2 names the critic's additions so both
specs can cite them: **G19** deterministic math (`dmath`, studio calls it DMATH), **G20** the rule
ordering contract (ORDER), **G21** pending events in snapshots (PEND).

**Ledger ids.** `plan/FINDINGS.md` is the O-ledger; its highest id is O-74. This spec **reserves
O-75 to O-90** for the new items (see the Appendix A map). Each id gets a ledger row when its work
starts, and the row closes in the PR that ships it. Existing ids are reused where they fit: O-8
spatial, O-11 canonical hash, O-13 scene codec, O-29 save size, O-30 eager registration, O-31 deep
diff, O-36 transient resources.

---

## 1. Goals, non-goals, ground rules

**Goals**

1. **Live == fork.** A fork built from the same project and restored from a live snapshot produces
   byte-identical snapshots, and therefore equal `hashSnapshot`s, for the same acts and dt. This
   must hold after rule edits, and in Electron as well as Node.
2. **A/B isolation.** Two forks that differ in one rule show only that rule's effect. Other rules'
   randomness is unchanged.
3. **Doc-complete behaviours.** Concept E's example behaviours, and anything `act()` can target,
   can be written as rule data, so branches, replays and agent proposals can rebuild them.
4. **Machine-addressable world.** Types can be looked up by name, acts can be logged as JSON and
   replayed, and errors are precise enough for an agent to correct itself.

**Non-goals** (these are studio's job, or deferred, as listed in §10). Studio owns:

- the MCP and HTTP servers, the tool generator and JSON Schema export;
- the provider abstraction;
- the forecast scheduler, the worker pool, lanes and keyframes;
- the doc format;
- the sentence-card renderer.

Engine Worker hosting (O-10) stays on PLAN's stop-doing list.

**Ground rules** (studio PLAN ground rules, plus this repo's conventions)

- **Red/green TDD.** Each item lands as failing tests first, then the change. One commit per task
  (one task = one numbered sub-step in §§4–7). Each PR closes or updates its ledger row.
- **Never drop user data.** Every new optional field round-trips through snapshot, persist and
  schema I/O. Validators report problems; they do not silently strip.
- **Additive within 2.x.** No removed or renamed export. Behaviour changes only where SPEC already
  disclaims the guarantee (for example §4.2's ≤ 1 ulp `sin`/`cos` change), each marked
  **behaviour change** in `CHANGELOG.md` and the release notes.
- **Errors are data.** New fallible APIs return `Result`. Rules errors stay `RuleError` and
  `RuleFault` (outside `DomecsError`). New error unions are **local** to their feature, so the
  closed `DomecsError` union and its exhaustive `match` users are untouched (ED-6).
- **One naming language** (AGENTS.md rule 8). New names follow the existing verbs:
  - `describe*` for reflection, `*Types()` for listings;
  - `lookup*` for by-name registry resolution (`get*` would collide with `getComponent`'s
    per-entity meaning, ED-14);
  - `create*` for factories, `install*` for plugin-style installers.
- **Gates per PR:**
  - `pnpm -r test` and `pnpm -r typecheck`;
  - `pnpm -r build && pnpm api:surface`, with the regenerated `doc/api-surface/*.d.ts` committed;
  - `pnpm api:check`, `pnpm doctest:check`, `pnpm test:legibility`;
  - from 2.1, `pnpm test:golden` (§3.4).
- **Lean scope.** Every item ends with an explicit *Out of scope* line.

---

## 2. Owner decisions (defaulted)

Each item has a default so that work can start. **The owner can override any of them.** An override
changes only the sections listed next to it.

### 2.1 Harness-wide defaults (from the critic and task framing)

| # | Decision | Default adopted | Engine impact |
|---|---|---|---|
| OD-1 | Critic Q1: where the live world runs | Server Node context (Electron main, or `server-cli` under electron-as-node); renderer receives SSE frames; the forecast worker is a `worker_threads` worker in the same process (same V8) | Determinism goldens must also run under electron-as-node (§3.4) |
| OD-2 | Q2: forecast input assumption | Lanes are labelled by input policy (none / hold-input from 2.2 / scripted); studio applies acts and input frames itself | §5.4 input reads; studio needs no engine replay (§7.1 ships in 2.2 for engine users) |
| OD-3 | Q3: outcome metrics | Studio `MetricData`: structured `builtin` before G13, `expr` after. Every builtin translates 1:1 to an expression (`count` → `count(S)`, `avg` → `avg(S, C.f)`, `countWithin` → `countWithin(S, r, first(T))`), so core JS metrics retire when G13 is consumed | §5.3 |
| OD-4 | Q4: slider drag | Paused: authoring (doc patch) or nudge (act), chosen per field (studio §4.3); playing: a `studio.SetField` act in the lane's act log | Std command events are `register`ed by studio so acts resolve by name (§4.5) |
| OD-5 | Q5: on-disk format | A project folder plus `runs/`; doc v1→v2 migrated by studio | None |
| OD-6 | Q6: levels/screens/layouts | Level = scene; screen = data widgets (text/meter/button) over a level, rendered by studio; layout = studio pref | None (§7.3 scenes ships in 2.3; studio keeps its catalog) |
| OD-7 | Q7: appearance | Data-defined `Appearance` std component (studio) | None |
| OD-8 | Q8: export | Static web player bundle (`core+rules+scene+dom`) | The engine stays bundle-friendly; no new deps |
| OD-9 | Q9: engine fixes reaching studio | Additive 2.x minors. Studio consumes **`npm pack` tarballs** (`file:` deps) during development and pins published versions at milestones. **Publish only with owner approval** | §8 release mechanics |
| OD-10 | Q10: deterministic math | Pure-JS `dmath` in core; rules use it for `sin`/`cos` and every new transcendental; the one-time output change is release-noted | §4.2 |
| OD-11 | Q11: agent tests | `scripted` provider; **no paid API calls in automated tests** | Engine tests stay headless and offline (already true) |
| OD-12 | Q12–Q17 (one agent session; paged observation; sentences read-only v1; doc undo only; escaping/CSP/token; API-key auth for distribution) | As the critic recommends | None (studio) |
| OD-13 | Desktop shell | Electron via **electron-vite** (pinned exact; fallback `vite-plugin-electron`); **npm workspaces** in studio; **Hono** server | Dual-runtime golden (§3.4) |
| OD-14 | Providers | **Claude first**; Codex behind a capability flag (the host is not logged in to Codex) | None |

### 2.2 Engine-specific defaults (new in this spec)

| # | Decision | Default | Alternative | Sections |
|---|---|---|---|---|
| ED-1 | Where `dmath` lives | `@domecs/core` exports `dmath`. This replaces SPEC's planned `@domecs/math` package | A separate `@domecs/math` package (one more publish target; rules would peer-depend on it) | §4.2 |
| ED-2 | Snapshot format for RNG streams and pending events | **`SNAPSHOT_VERSION` 3** in 2.1, with a built-in persist `2 → 3` migration (version bump only). v3 adds the optional `rngRoot`, `rngStreams` and `pendingEvents`. 2.0 engines reject v3 snapshots loudly. **Owner decision (revision 3): always v3 in 2.1** — every snapshot a 2.1 world writes has `version: 3`, whether or not it uses own streams or pending events; v2 snapshots still restore and load | Optional fields with no bump (O-40/O-42 precedent). A 2.0 engine would then silently ignore streams. Also rejected: v3 only when a stream is in use (two formats from one engine) | §3.2, §4.4, §4.7 |
| ED-3 | Rule ordering fix | Core `SystemDef.order` (secondary sort key) plus `installRules(…, { order: 'stable' })`. **Default stays `'registration'` in 2.x**, since flipping it changes fresh-world order. Candidate to flip in 3.0 | Flip the default now (behaviour change) | §4.3 |
| ED-4 | Per-system RNG | Opt-in `rng: 'own'`; default `'shared'` | Default `'own'` (behaviour change) | §4.4 |
| ED-5 | Hash algorithm and scope | FNV-1a-64 over canonical JSON. `version`, `meta` and `changes` are excluded by default. **Restore-equivalence checks** (forks, checkpoints, keyframes, live == forecast) pass `includeChanges: true`, because `changes` drives change-gated systems' futures; the default hash is for cache keys and UI | xxHash64 (faster, more code); include `changes` by default | §4.1 |
| ED-6 | New error types | Local unions (`RegisterError`, `ReplayError`, `BranchError`, `RedefineError`) | New `DomecsError` kinds (breaks exhaustive matchers) | §§4.5, 7.1, 7.2, 7.4 |
| ED-7 | Spatial structure location | Pure `createSpatialGrid` in **core**. The world-bound `createSpatialHash` and `installContacts` go in **scene**. Rules depend only on core | Grid in scene, with rules peer-depending on scene (adds a DAG edge, SPEC §1) | §§5.1, 5.2, 6.2 |
| ED-8 | Structural rule actions | A **separate `effects` array**, deferred to the end of the run. `RuleActionDef` keeps its `{set, expr}` shape | Widen `RuleActionDef` to a union (a type-level break for readers of `.set`) | §6.1 |
| ED-9 | Reserved words in expressions | `self`, `other`, `event`, `pointer`, `tick` (and `id` after an entity) | Sigil syntax (`$self`) | §§5.2, 5.4, 6.1 |
| ED-10 | Self-exclusion | Neighbour functions (`first`, `nearest`, `countWithin`) exclude self. Set aggregates (`count`, `exists`, `sum`, `avg`, `minOf`, `maxOf`) include every member | Exclude self everywhere | §5.2 |
| ED-11 | Cross-entity read timing | Live reads in ascending-id order (Gauss–Seidel, like own-field reads today). Spatial *selection* uses positions as of the start of the rule's run | Jacobi (start-of-run copies; memory per run) | §5.2 |
| ED-12 | `redefineComponent` | **Conditional.** Build it only if studio's rebuild-and-restore policy (critic fact 2) proves insufficient | Build it in 2.3 regardless | §7.4 |
| ED-13 | Engine G4/G3/G14 timing | ~~Conditional~~ **Scheduled (owner decision, revision 3):** G4 act log + replay (§7.1) and G3 `createBranch`/`runBranch` (§7.2) in 2.2 before its release candidate; G14 scenes (§7.3) in 2.3 before its release candidate. Studio keeps its own doc-aware fork, act log and level catalog (critic C4) | Revision 2 default: conditional, built only when a named consumer asks | §7 |
| ED-14 | By-name lookup naming | `lookupComponent` / `lookupEvent` / `lookupResource` | `getComponentType` etc. | §4.5 |
| ED-15 | Pre-release tarball versions and build identity | The release branch bumps packages to the target minor (for example 2.1.0). `scripts/pack-for-studio.mjs` packs each package with `version: 2.1.0+g<sha>` (build metadata; ignored by range checks, so `^2.0.0` still resolves) and stamps a new `BUILD_ID` export (`'2.1.0+g<sha>'`, `-dirty` suffix for an unclean tree; `'2.1.0'` when published). Studio stamps `BUILD_ID`, so two packs of the same version are distinguishable | `2.1.0-pre.N` (does not satisfy `^2.0.0` peer ranges under npm) | §8 |
| ED-16 | Pending events in snapshots | Opt-in: `snapshot({ pendingEvents: true })` records them; the default stays off in 2.x so existing apps with non-JSON payloads never start throwing. Studio, and every fork or keyframe, opts in | Default on (a behaviour change for apps with non-plain payloads) | §4.7 |
| ED-17 | `-0` and non-finite numbers in canonical JSON | `-0` is written as the literal `-0` (valid JSON; `JSON.parse('-0')` is `-0`). A non-finite number throws `TypeError` naming its path, like BigInt and cycles (snapshots are plain data by contract) | Map `-0 → 0` and non-finite → `null` (hides real divergences) | §4.1 |
| ED-18 | `dmath` scope | 2.1: `sin`, `cos`, `sqrt` (the functions rules use). 2.2: `atan2`, `hypot`, `pow` (fdlibm `e_pow.c`, no tables) with §5.2. `tan`, `atan`, `exp`, `log` on demand | All ten functions in 2.1 (about 900 lines, table-driven exp/log/pow) | §4.2, §5.2 |

---

## 3. Cross-cutting contracts

### 3.1 Determinism contract additions (SPEC §8)

Each addition lands in SPEC §8 in the PR that ships it.

1. **Transcendentals.** Authoritative systems use `dmath`, not `Math.sin/cos/atan2/pow/hypot`
   (or any other platform transcendental). Rules do this automatically: `sin`/`cos` from 2.1,
   `atan2`/`hypot`/`pow` from 2.2. `Math.sqrt` and the basic arithmetic operators are exact under
   ECMA-262 / IEEE-754. `Math.floor`, `Math.round`, `Math.abs`, `Math.min` and `Math.max` are
   exact.
2. **Ordering.** Run order within a mode is `priority`, then `order`, then registration index
   (§4.3). Under `installRules({ order: 'stable' })` a rule's position depends only on the doc.
3. **Randomness.** A system with `rng: 'own'` draws from a stream keyed by its cursor key and
   derived from the world's root seed. Its state travels in the snapshot (§4.4).
4. **Equality.** "Same state" means equal `hashSnapshot` (§4.1). AGENTS.md's checklist switches
   from `JSON.stringify(snapshot())` to `hashSnapshot` when §4.1 ships, as the checklist itself
   anticipates.
5. **Runtime stamp.** Determinism holds per runtime build until every transcendental goes through
   `dmath`. Rules guarantee that; hand-written JS systems may not. `describe()` adds nothing here:
   studio stamps `{electron, v8, arch, platform}` plus each package's `BUILD_ID` itself (critic
   fact 1; §8).
6. **In-flight events** (§4.7). Events emitted during tick N are delivered at tick N+1. A
   snapshot taken with `pendingEvents: true` carries them, and `restore()` replaces the restoring
   world's queue with them, so a fork taken between N and N+1 sees the same deliveries as live.
7. **Restore-continuation preconditions** (SPEC §7.1, now listed in one place). A restored world
   continues the source exactly only if: it registered the same systems in the same order (§4.3);
   it has no enabled `once` system that the source had already run (`once` state is not
   snapshotted, so a fresh world fires it on its first tick); `time.scale` is set to the source's
   scale (scale is not snapshotted); the snapshot was taken without snapshot-rewriting plugins
   (`onSnapshot` prune plugins drop entities); and the snapshot carries pending events when any
   were in flight (item 6).

### 3.2 Snapshot compatibility policy

- 2.1 bumps `SNAPSHOT_VERSION` to **3** (ED-2) and, per the owner's revision-3 decision, writes
  **v3 always**: every 2.1 `snapshot()` has `version: 3`, including worlds with no own-stream
  system and snapshots taken without `pendingEvents`. `restore()` keeps accepting any version
  ≤ 3. v3 adds three optional fields: `rngRoot` and `rngStreams` (§4.4) and `pendingEvents`
  (§4.7). v2 snapshots lack them, and restore treats them as absent, so 2.0 saves still restore
  and load.
- `@domecs/persist` `BUILTIN_MIGRATIONS` gains `[2, snap => ok({ ...snap, version: 3 })]`
  (`migrate.ts:25-27` pattern).
- No other item in this spec changes the snapshot envelope. Contact state (§6.2) and scene
  membership (§7.3) are ordinary resources and components.
- `@domecs/persist` `save()` keeps serializing with `JSON.stringify`, which writes `-0` as `0`.
  A world restored from a persist save can therefore differ from live where a field held `-0`.
  Consumers that fork from disk (studio keyframes) serialize with `canonicalJson`, which keeps
  `-0` (§4.1). Switching persist to `canonicalJson` is a follow-up, out of scope here.
- Every new derived structure is **never snapshotted**: spatial grids, selector caches, the
  recorder's internal tap, and branch bookkeeping. Each is rebuilt from snapshotted state.

### 3.3 API-surface and docs discipline

For every item, the "Docs" line lists the following, in the same PR:

- **API surface:** the regenerated `doc/api-surface/<pkg>.d.ts`.
- **Reference:** the `doc/api.md` section, with runnable `ts doctest` fences.
- **Semantics:** the SPEC section.
- **Package README:** the matching section in `packages/<pkg>/README.md`.
- **Agent docs:** an AGENTS.md / `skills/domecs/SKILL.md` line where agent-facing.
- **Release notes:** a `CHANGELOG.md` entry, plus `doc/release-notes/v2.N.0.md` at release.

### 3.4 Dual-runtime golden (new in 2.1)

One mechanism, shared with studio (feasibility review 10): a **plain ESM script prints hashes**,
and a Node test spawns it under each runtime and compares.

- **Script.** `scripts/determinism-golden.mjs` (no test framework, imports only the built
  `dist/`) builds fixed headless worlds and prints one JSON line
  `{ buildId, fixtures: { <name>: <strict hash> }, dmathFingerprint }`:
  - fixtures using `sin`, `cos`, `random()`, own streams and a `-0`-producing bounce (2.2 adds
    `atan2`, `hypot`, `pow`, `nearest` and `countWithin`; 2.3 adds an event chain snapshotted
    with events in flight);
  - 1000 fixed steps each; hashes use `includeChanges: true`.
- **Gate.** `test/golden.test.mjs` (`pnpm test:golden`) spawns the script under
  `process.execPath` and compares with the committed `test/golden/determinism.json`.
- **Cross-runtime.** If `DOMECS_ALT_RUNTIME` is set, for example to
  `"env ELECTRON_RUN_AS_NODE=1 /path/electron"`, the test also spawns the script under that
  binary and requires identical output.
- **Studio** runs this same script under its pinned Electron, through the same spawn-and-compare
  test it uses for its own fixtures (studio spec §10.1). That is the check that "determinism holds
  in the app" (critic risk 2). `pack-for-studio` copies the script next to the tarballs
  (`vendor/domecs/determinism-golden.mjs`, manifest `golden: { file, integrity }`), and
  `--engine <dir>` makes it load `@domecs/core` from `<dir>/@domecs/core/dist` (studio passes its
  `node_modules`), so studio runs it against the packed build it installed.

---

## 4. Release 2.1: determinism foundation

### 4.1 Canonical snapshot hash and field-level diff (G5 + G9; O-11, O-31)

**Problem and evidence**

- Equality today is `JSON.stringify(snapshot())`, which relies on incidental key order (O-11,
  `plan/FINDINGS.md:106`; SPEC §8 `doc/SPEC.md:757`; the AGENTS.md checklist).
- Component key order inside an entity record follows the archetype's `types` Set insertion order
  (`packages/domecs/src/world-state.ts:102`). Two worlds in the same state whose entities gained
  components in a different order serialize differently.
- `diffSnapshots` compares `JSON.stringify(e.components)` and returns ids only
  (`packages/domecs-persist/src/history.ts:175-209`, O-31).
- The timeline needs cheap equality, divergence localization and cache keys (engine §G5).

**API** (`@domecs/core`, new module `src/canonical.ts`)

```ts
export interface CanonicalOptions {
  /** Include `changes` (unseen marks + system cursors, O-42). Default false. */
  readonly includeChanges?: boolean
  /** Include `meta`. Default false. */
  readonly includeMeta?: boolean
}
/** Canonical JSON of any plain-data value: sorted keys, JSON value semantics. */
export function canonicalJson(value: unknown): string
/** Canonical JSON of a snapshot's simulation state (see "Scope" below). */
export function canonicalSnapshot(snap: WorldSnapshot, options?: CanonicalOptions): string
/** 16 lowercase hex chars: FNV-1a-64 over the UTF-8 bytes of canonicalSnapshot. */
export function hashSnapshot(snap: WorldSnapshot, options?: CanonicalOptions): string
/** Per-entity hash of each record's canonical `components`, ascending id. */
export function hashEntities(snap: WorldSnapshot): Map<Entity, string>
/** FNV-1a-64 of canonicalJson(value). For metric results, act logs, doc versions. */
export function hashValue(value: unknown): string
export const HASH_ALGORITHM: 'fnv1a64'
```

**API** (`@domecs/persist`, additive overload of the existing name)

```ts
export interface SnapshotDiffOptions {
  /** Report component/field/resource changes, not just entity ids. Default false. */
  readonly fields?: boolean
  /** Restrict field reporting to these component names. */
  readonly components?: readonly string[]
  /** Numbers within epsilon compare equal (absolute). Default 0 (exact). */
  readonly epsilon?: number
  /** Stop after this many field changes and set `truncated`. Default 10_000. */
  readonly limit?: number
}
export interface FieldChange {
  readonly entity: Entity
  readonly component: string
  /** Dotted path inside the component value: "x", "inv.items[2].qty". */
  readonly path: string
  readonly before: JsonValue | undefined   // undefined = absent
  readonly after: JsonValue | undefined
}
export interface ResourceChange { readonly resource: string; readonly path: string; readonly before: JsonValue | undefined; readonly after: JsonValue | undefined }
export interface SnapshotDiff {
  readonly addedEntities: readonly Entity[]          // unchanged
  readonly removedEntities: readonly Entity[]        // unchanged
  readonly changedEntities: readonly Entity[]        // now canonical comparison
  readonly componentsAdded?: ReadonlyArray<{ entity: Entity; component: string }>    // fields: true
  readonly componentsRemoved?: ReadonlyArray<{ entity: Entity; component: string }>  // fields: true
  readonly fieldChanges?: readonly FieldChange[]                                      // fields: true
  readonly resourceChanges?: readonly ResourceChange[]                                // fields: true
  readonly truncated?: boolean
}
export function diffSnapshots(prev: WorldSnapshot, next: WorldSnapshot, options?: SnapshotDiffOptions): SnapshotDiff
/** First difference in canonical order: top-level state, then lowest entity id, then resources. */
export function firstDivergence(a: WorldSnapshot, b: WorldSnapshot): Divergence | null
export type Divergence =
  | { readonly where: 'state'; readonly key: 'seed' | 'tick' | 'scaledTime' | 'nextId' | 'rngRoot' | 'rngStreams' | 'fixedBacklog' }
  | { readonly where: 'entity'; readonly entity: Entity; readonly change: 'added' | 'removed' | FieldChange }
  | { readonly where: 'resource'; readonly change: ResourceChange }
```

**Semantics**

- **Canonical JSON** equals `JSON.stringify` *value* semantics, with object keys sorted ascending
  by UTF-16 code unit:
  - `undefined`, function and symbol values are omitted in objects and become `null` in arrays;
  - number text follows ECMAScript `Number::toString`, which is spec-defined and identical across
    engines, **except** that `-0` is written as the literal `-0` (ED-17). That is valid JSON, and
    `JSON.parse('-0')` returns `-0`. `-0` is common (`v = -v` at 0; the rules commit compares with
    `Object.is`), and it changes futures through `atan2`, division, `sign` and change marks;
  - a non-finite number (`NaN`, `±Infinity`) **throws** `TypeError` with its path
    (`"entities[3].components.Body.vx"`), as BigInt and cycles do. Mapping it to `null` would
    change its type on restore and hide the divergence;
  - strings use well-formed JSON escaping;
  - BigInt and cycles throw `TypeError`, as `JSON.stringify` does. Snapshots are plain data by
    contract (SPEC §7, O-25).

  The property is **lossless round trip**: `canonicalJson(JSON.parse(canonicalJson(x))) ===
  canonicalJson(x)`, and a snapshot restored from `JSON.parse(canonicalJson(snap))` continues
  exactly like one restored from `snap`. (`JSON.stringify` is *not* lossless: it drops `-0`.)
- **Scope of `canonicalSnapshot`:**
  - Included: `seed`, `tick`, `scaledTime`, `fixedBacklog`, `fixedStep`, `nextId`, `entities`
    (already ascending id), `resources`, and from 2.1 `rngRoot`, `rngStreams` and
    `pendingEvents` (when present, §4.7).
  - Excluded by default: `version`, which is format rather than state, so a v2 snapshot migrated
    to v3 hashes the same; `meta`; and `changes`. Change cursors can legitimately differ between
    worlds in the same simulation state, for example after a heartbeat render.
  - `includeChanges` makes the hash the strict restore-equivalence key. **Use it for every
    restore-equivalence check**: fork vs live, checkpoints, keyframe verification, and studio's
    production live == forecast check. `changes` holds unseen marks and cursors that decide what
    change-gated systems do next (for example the `OnRemoved(Local)` cleanup in
    `composeTransforms`, `compose-transforms.ts:53-56`), so two worlds with equal default hashes
    can still have different futures. Use the default hash only for cache keys and UI.
- **Hash.** FNV-1a-64 is implemented with four 16-bit limbs and `Math.imul` (no BigInt), so it is
  synchronous, dependency-free, and identical across engines. It is not cryptographic; collisions
  are acceptable for divergence detection and cache keys. Cost target: ≤ 2 ms for a 131 KB
  snapshot (1000 entities) on the reference host, recorded in `bench/`.
- **Diff.**
  - `changedEntities` switches to canonical comparison. This is a fix: entities that differ only
    in key order are no longer reported. It is listed as a **behaviour change** (narrowing).
  - With `fields: true`, value changes are walked recursively.
  - Arrays compare element-wise by index; a length change reports the tail elements as
    added/removed paths.
  - Paths use `.name` and `[i]`. A key that is not an identifier is written `["key"]` (JSON
    string).
- **Determinism.** Pure functions of their input. Iteration is ascending entity id, then sorted
  component name, then sorted key. Outputs are stable across runs and runtimes.

**Snapshot and compat.** No format change. `diffSnapshots(prev, next)` without options keeps its
result shape.

**Tests (red → green).** New files `packages/domecs/test/canonical-hash.test.ts` and
`packages/domecs-persist/test/diff-fields.test.ts`.

1. Two worlds that reach the same state through different component-add orders: `JSON.stringify`
   differs (red, documenting O-11), `hashSnapshot` is equal (green).
2. Lossless round trip: `canonicalJson(JSON.parse(canonicalJson(s))) === canonicalJson(s)` for
   `-0`, `undefined` fields and nested arrays. `canonicalJson({a: -0})` is `'{"a":-0}'`.
   `hashSnapshot` of a snapshot holding `NaN` or `Infinity` throws `TypeError` naming the path.
   `hashSnapshot(s) !== hashSnapshot(JSON.parse(JSON.stringify(s)))` when `s` holds `-0`
   (documents why keyframes must not use `JSON.stringify`).
3. Live vs restored twin, 600 fixed steps: equal `includeChanges` hashes at every 60th tick.
   Fork from `JSON.parse(canonicalJson(snap))` of a world whose rule computes `1 / Body.vx` after
   a bounce leaves `vx === -0`: equal to live (red with a `JSON.stringify` round trip).
4. A heartbeat `step(0)` after a render changes `changes` but not the default hash.
5. Golden: a fixed snapshot fixture hashes to a committed constant (pins the algorithm).
6. `hashEntities` localizes a one-field difference to one entity.
7. `diffSnapshots(..., {fields:true})`:
   - scalar, nested, array-length, component-added/removed and resource changes;
   - `epsilon`;
   - `limit` with `truncated`;
   - the key-order-only case is not reported.
8. `firstDivergence` returns the lowest-id entity's first field change; it returns `null` for
   equal snapshots.

**Docs:**

- SPEC §7.1 ("Canonical form") and §8 (equality by hash);
- `doc/api.md` (core "Determinism tools", persist diff);
- the AGENTS.md verification checklist and `skills/domecs/SKILL.md`: swap `JSON.stringify` for
  `hashSnapshot`;
- the persist README;
- api-surface `core.d.ts`, `persist.d.ts`.

**Size:** S (hash) + S (diff, optional in 2.1; may slip to 2.2 without blocking studio).
**Studio:** imports `canonicalJson`, `hashSnapshot` and `hashValue` from the first 2.1 tarball
(no interim studio hash, feasibility review 18); keyframes are `canonicalJson` of the full
snapshot; equality checks use `includeChanges: true`; divergence UI; the v1.1 `diff` tool.
**Out of scope:** a streaming or incremental hash, crypto hashes, diff compaction for history
storage (the rest of O-31).

---

### 4.2 Deterministic math: `dmath`, and rules `sin`/`cos` (G19; O-75)

**Problem and evidence**

- Node 24 (V8 13.6) and Electron 44 (V8 15.2) disagree on `Math.sin/cos/exp/log/atan/tan` in
  thousands of inputs per 200k, by up to 1 ulp. A 200-entity sim then hashes differently
  (`01b92b8a…` vs `8f40ff1c…`; platform survey §6).
- `sqrt`, `hypot`, `pow` and the RNG matched on those builds. ECMA-262 nevertheless leaves
  `hypot` and `pow` implementation-approximated.
- The rules evaluator calls `Math.sin` and `Math.cos`
  (`packages/domecs-rules/src/evaluator.ts:179,181,268,269`). That contradicts SPEC §8
  (`doc/SPEC.md:754`), which says deterministic systems must avoid platform transcendentals and
  plans a `@domecs/math`.

**API** (`@domecs/core`, new module `src/dmath.ts`, ED-1)

```ts
/** Bit-reproducible math: identical results on every ECMA-262 engine. */
export const dmath: Readonly<{
  sin(x: number): number
  cos(x: number): number
  /** = Math.sqrt (correctly rounded by IEEE-754; re-exported so authors need one namespace). */
  sqrt(x: number): number
  // 2.2 (with §5.2), additive:
  atan2(y: number, x: number): number
  hypot(x: number, y: number): number
  pow(x: number, y: number): number
}>
```

**Semantics**

- **Scope (ED-18).** 2.1 ships the functions rules use today: `sin`, `cos` and the `sqrt`
  alias. 2.2 adds `atan2`, `hypot` and `pow` together with the §5.2 functions that need them.
  `tan`, `atan`, `exp` and `log` are out of scope: no rule uses them and studio forbids JS
  systems. They can be added on demand with the same method.
- **Source.** A port of **musl libm** (MIT), using the generic-C, non-FMA paths:
  - 2.1: `__sin`, `__cos`, `__rem_pio2`, `__rem_pio2_large` for `sin` and `cos`;
  - 2.2: `atan2` (with its `atan` kernel), `hypot`, and `pow` from **fdlibm `e_pow.c`** (no
    tables, no FMA paths), so no 64-bit table constants need porting.
- **Why the port is bit-exact.** ECMA-262 numbers are binary64 with round-to-nearest-even. There
  is no FMA contraction and no extended precision, so a straight-line port reproduces bit for bit
  everywhere. Bit access goes through a module-level `DataView` with explicit little-endian
  offsets, so results do not depend on platform endianness. `fp_barrier` and `eval_as_double`
  become no-ops.
- **Accuracy.** Matches the sources: sin/cos < 1 ulp; atan2/hypot < 1 ulp; pow < 1 ulp
  (fdlibm). Special values (±0, ±∞, NaN, subnormals, huge arguments through Payne–Hanek) follow
  C99 Annex F.
- **Rules.** `sin()` and `cos()` evaluate with `dmath` from 2.1. The §5.2 functions that are not
  exact (`atan2`, `pow`, `hypot`) use `dmath` from the release that adds them. `sqrt` uses
  `Math.sqrt`, which is exact.
- **Behaviour change.** A rule using `sin`/`cos` may produce results that differ by ≤ 1 ulp from
  2.0 in a given runtime. Existing sims' hashes change once. SPEC already disclaims transcendental
  bit-identity, so this is allowed in a minor and is release-noted (OD-10).

**Snapshot and compat:** none.

**Tests (red → green).** New file `packages/domecs/test/dmath.test.ts`, plus fixtures
`test/golden/dmath-vectors.json` and `scripts/dmath-golden.mjs`.

1. Golden vectors, about 3000 inputs as hex bit patterns:
   - specials;
   - multiples and near-multiples of π/2 up to 2^1023;
   - subnormals;
   - a seeded random spread.

   The test asserts `Object.is` equality of the output bit patterns. The vectors are generated
   once from the port and reviewed against `Math.*` (next test). The golden then pins the port.
2. Accuracy: 100k seeded inputs per function within 1 ulp of `Math.*` under Node. Any 1-ulp
   difference is acceptable; 2 or more fails. (2.2 repeats tests 1–2 for `atan2`, `hypot`,
   `pow`.)
3. Rules: `installRules` with `x = sin(Px.a)` gives exactly `dmath.sin(a)` for 1000 seeded `a`.
   This test goes in `packages/domecs-rules/test/evaluator.test.ts`.
4. Dual runtime: `dmathFingerprint` in the §3.4 golden is equal under Node and
   `DOMECS_ALT_RUNTIME`.
5. Performance: `dmath.sin` stays within 3× of `Math.sin` in `bench/` (informational, not gating).

**Docs:**

- SPEC §1: drop `@domecs/math` from "Planned" and note `dmath` in core;
- SPEC §8: the transcendental rule now points at `dmath`;
- `doc/api.md` ("Deterministic math");
- the rules README: functions are bit-reproducible;
- the CHANGELOG behaviour-change entry;
- api-surface `core.d.ts`.

**Size:** S–M in 2.1 (`sin`/`cos` with argument reduction, about 400 lines, plus vectors); S in
2.2 (`atan2`, `hypot`, fdlibm `pow`). **Studio:** a project's outcomes are identical under Node
(tests) and Electron (the app), so the cross-runtime golden (studio G-cross) can assert equality.
**Out of scope:** `tan`, `atan`, `exp`, `log`, `asin/acos/sinh/cosh/expm1/log1p/cbrt` (add on
demand, same method), float32 variants, fixed-point.

---

### 4.3 Rule ordering contract: live == fork after `update()` (G20; O-76)

**Problem and evidence**

- `RulesHandle.update()` removes and re-registers **every** rule on each call
  (`packages/domecs-rules/src/rules.ts:424-437`).
- The scheduler sorts by `priority`, then a monotonic `registrationIndex`
  (`packages/domecs/src/scheduler.ts:176-178`, `:267-282`, O-43). After any `update()`, every rule
  therefore sorts after each equal-priority system registered later, such as `composeTransforms`.
  A fresh world built from the same doc runs the rules first.
- Probe `critic/order2.mjs`, with one tick rule `P.x += 1` and one priority-0 copy system
  `W.x = P.x`:
  - a fresh build gives `P=5 W=5`;
  - after a no-op `update(defs)` it gives `P=5 W=4`, and the snapshots differ.
- SPEC §3 (`doc/SPEC.md:374`): equal priority runs in registration order. The restore contract
  requires the same registration order (`doc/SPEC.md:667`).

**API**

```ts
// @domecs/core — scheduler.ts SystemDefBase (additive)
interface SystemDefBase {
  /**
   * Secondary sort key within a priority (default 0; finite). Run order in a mode is
   * priority, then order, then registration index. Lets a library place its systems
   * deterministically regardless of when they were (re)registered.
   */
  order?: number
}

// @domecs/rules — new optional 4th parameter (additive)
export interface InstallRulesOptions {
  /**
   * 'registration' (default, 2.0 behaviour): rules tie-break by registration index.
   * 'stable': rule i (its index in the de-duplicated defs) registers with
   * `order: orderBase + i`, so its run position is a pure function of
   * (priority, defs order), never of when update() ran.
   */
  readonly order?: 'registration' | 'stable'
  /** First order key used in 'stable' mode. Default 1. */
  readonly orderBase?: number
  // fields added by later items: rng (§4.4), spatial (§5.2), resolveEvent/prefabs (§6.1)
}
export function installRules(world: World, defs: RuleDef[], resolve: (name: string) => ComponentType<any> | undefined, options?: InstallRulesOptions): RulesHandle
```

**Semantics**

- The comparator becomes `a.priority - b.priority || a.order - b.order || a.registrationIndex - b.registrationIndex`.
  A non-finite `order` throws at `world.system()`, as invalid `rateHz` does today (SPEC §3).
- In stable mode, at equal priority, every system with `order` 0 (all existing systems, since 0 is
  the default) runs before any rule, and rules run in defs order. Re-registration in `update()`
  cannot move them.
- **Recommended bands** (documentation convention, no new API; studio's `buildGuestWorld` uses
  exactly these, studio spec D4):

  | Band | Priority | Examples |
  |---|---|---|
  | commands, input | −100 | studio std command systems (`studio.*`) |
  | rules | strictly between −100 and 100 (default 0) | `installRules` |
  | derived transforms | 100 | `composeTransforms({ priority: 100 })` (option exists today, `compose-transforms.ts:4-13`) |
  | contacts | 150 | `installContacts` (§6.2) |
  | derived, render-only | 200 | caches, view state |
  | level switching | 1000 | studio's std scene-goto system |
- **One stable `RulesHandle` per world**, or give each handle its own `orderBase`. Two handles with
  equal keys tie-break by registration index again. This is documented, and not detectable from
  one handle.
- **Cursor keys** (`name#k`) still follow registration order among systems that share a name. Rule
  systems are uniquely named (`rule:<name>`), so they are unaffected.
- `describe().systems[i]` reports `priority` and `order` (§4.5).

**Snapshot and compat.** No format change. Default behaviour is identical to 2.0.

**Tests (red → green).** In `packages/domecs-rules/test/ordering.test.ts` and
`packages/domecs/test/scheduler-order.test.ts`.

1. The critic probe as a test: tick rule plus priority-0 compose system. Fresh build vs build +
   `update(defs)`, 5 ticks. In `'registration'` mode the snapshots differ (documents the hazard).
   In `'stable'` mode the hashes are equal.
2. Stable mode, reorder defs via `update`: run order follows the new defs order. A rule added
   later sits by defs index, not at the end.
3. Core: `order` breaks priority ties ahead of registration index; non-finite `order` throws;
   removal during a phase keeps O-43 semantics.
4. Fork contract: live world (installRules stable, compose at 100, 3 updates over 30 ticks) vs a
   fresh world built once and restored at tick 30. Equal hashes for the next 120 ticks, including
   a fixed rule, a tick rule and `random()`.

**Docs:** SPEC §3 (ordering triple, bands), §7.1 restore contract note; `doc/api.md` (SystemDef
`order`, InstallRulesOptions); rules README "Ordering"; api-surface `core.d.ts`, `rules.d.ts`.
**Size:** S. **Studio:** `buildGuestWorld` puts compose at priority 100 and std commands at
−100 from its first commit (no engine change needed), validates rule priorities into the open
band (−100, 100), and installs rules with `{ order: 'stable' }` once 2.1 is consumed. Because
studio never calls `update()` on a live world (it rebuilds and restores on every doc change,
critic fact 2) and no other system shares the rule band, `'registration'` and `'stable'` give the
same run order in studio worlds; a studio test asserts equal hashes for both, so consuming 2.1
does not change any project's outcomes.
**Out of scope:** flipping the default (3.0 candidate, ED-3); named phases or stages.

---

### 4.4 Per-system RNG streams (G6; O-77)

**Problem and evidence**

- Every system receives the one world generator (`packages/domecs/src/world.ts:481`
  `let rand = createRng(seed)`; `ctx.rand` at `:1063`). Rules route `random()` to `ctx.rand`
  (`rules.ts:291`).
- Probe `probe/rng.mjs`: rule B's value after 3 ticks is `0.6393…` with rule A present and
  `0.9298…` without it.
- A/B forks that differ in one random-drawing rule therefore reshuffle every other rule (critic
  fact 4).
- `Rng.fork(label)` exists (`src/rng.ts:91-104`), but it derives from the *current* state, so a
  stream forked at a different time is a different stream.

**API**

```ts
// @domecs/core — SystemDefBase (additive)
interface SystemDefBase {
  /**
   * 'shared' (default): ctx.rand is world.rand.
   * 'own': ctx.rand is this system's stream, keyed by its cursor key
   * (name, or name#k on a clash) and derived from the world's root seed —
   * independent of registration time and of every other system's draws.
   */
  rng?: 'shared' | 'own'
}

// WorldSnapshot (v3) — both optional
export interface WorldSnapshot {
  /** The world's root seed state (the createWorld seed); never advances. */
  readonly rngRoot?: RngState
  /** Current state of every own stream this world has created, by stream key. */
  readonly rngStreams?: Readonly<Record<string, RngState>>
}

// @domecs/rules
interface RuleDef { rng?: 'shared' | 'own' }               // per rule; overrides the install default
interface InstallRulesOptions { readonly rng?: 'shared' | 'own' }   // default for every rule; default 'shared'
```

**Semantics**

- **Root.** `rngRoot = seedToState(options.seed ?? 0)` is fixed at `createWorld`. `restore()` sets
  the world's root to the snapshot's `rngRoot` when present (a v2 snapshot uses the world's own
  `createWorld` root, not one adopted from an earlier restore). Systems registered after a restore then derive the same streams the source world would.
- **Derivation.** `deriveStream(root, key)`:
  - FNV-1a-32 over the UTF-16 code units of `"domecs:stream:" + key`;
  - each root word XOR-mixed with the key hash and passed through `splitmix32` (word *i*: the
    first output of `splitmix32` seeded with `root[i] XOR rotl(h, 8·i)`; E4 notes);
  - an all-zero result fixed up as `seedToState` does;
  - 8 outputs discarded as warm-up.

  The exact function is pinned by a golden test and is part of the snapshot contract. Changing it
  requires a `SNAPSHOT_VERSION` bump.
- **Lifetime is by key, not by registration.** The world keeps `streams: Map<key, state>`.
  - A system with `rng: 'own'` registering under key *k* resumes `streams[k]` if present, or
    creates it from `deriveStream(root, k)`.
  - Removing the system **keeps** its entry. This matters because `RulesHandle.update()` removes
    and re-registers every rule, and the stream must survive that, or live (re-registered) and
    fork (fresh build plus restore) would diverge.
  - `snapshot()` writes every entry. `restore()` replaces the map with `rngStreams`, or empties it
    for a v2 snapshot. Live own-stream generators are rewound in place (the O-46 pattern), so
    captured `ctx.rand` handles follow.
  - **Missing keys are re-derived.** After the map is replaced, every *registered* own-stream
    system whose key is absent from it is rewound to `deriveStream(restoredRoot, key)` and that
    state is inserted into the map. Without this, a rule that exists only in the restoring world
    (an A/B arm B that adds a rule) would keep the state derived from the fresh world's own
    `createWorld` root, and its next snapshot would omit it.
  - **Reseeding a snapshot** is therefore data-only: `{ ...snap, seed: s, rngRoot: s,
    rngStreams: undefined }` restores into a world whose shared stream and every own stream
    derive from `s`. Studio uses this for multi-seed evaluation (studio spec D8).
- **Entry growth.** The map grows by the number of distinct own-stream keys ever used (renaming a
  rule leaves an orphan entry). That is bounded by authoring and acceptable. Orphans round-trip,
  per "never drop user data".
- **What the guarantee covers.** Adding, removing or editing rule A does not change rule B's draws.
  A rule's own draws still depend on how many entities it visits, because it uses one stream per
  system. Per-entity counter-based randomness is out of scope.
- `world.rand` stays the shared stream. A system with `rng: 'own'` that calls `world.rand`
  directly still draws from the shared stream (documented: use `ctx.rand`).

**Snapshot and compat.**

- `SNAPSHOT_VERSION` 3, with the persist built-in `2 → 3` migration (ED-2).
- **Always v3 in 2.1** (owner decision, revision 3). Per-system streams ship in 2.1, and every
  snapshot a 2.1 world writes has `version: 3`, not only snapshots of worlds that use own
  streams. Consequences:
  - `rngRoot` is written by **every** 2.1 snapshot (it is four numbers). A fork that adds the
    first own-stream rule, such as an A/B arm B, then derives it from the source's root and not
    from its own `createWorld` root.
  - `rngStreams` is omitted while the world has never created an own stream, the same
    convention as `resources`, `changes` and `pendingEvents`. Restoring an absent field and an
    empty record behave identically.
  - `pendingEvents` (§4.7, shipped in E7 as an optional field on the v2 envelope) becomes one of
    v3's optional fields with no further change.
  - A v2 snapshot still restores (any version ≤ 3), uses the world's own `createWorld` root and
    re-derives every own stream (test 4). Persist `load` migrates it to v3 in memory; `save` writes v3.
  - `canonicalSnapshot` excludes `version`, so the bump alone does not change any hash; adding
    `rngRoot` does change the hash of world-built snapshots (no golden pins one before E8).
- Validation before effects (O-41 pattern): `rngRoot` must be 4 finite numbers, and `rngStreams`
  must be a record of 4-number arrays. An invalid value throws with the world untouched.
- 2.0 engines reject v3 snapshots ("newer than supported").

**Tests (red → green).** In `packages/domecs/test/rng-streams.test.ts` and
`packages/domecs-rules/test/rng.test.ts`.

1. The probe as a test: rules A and B, both `rng:'own'`. B's values over 10 ticks are identical
   with and without A. With `'shared'` they differ (red baseline).
2. Re-registration: `update(defs)` every tick does not change any own-stream sequence. Compare
   against a world that never updates.
3. Fork: the live world registers rule C at tick 20; snapshot at 40; a fresh world with A, B and C
   is restored. Next 100 ticks have equal hashes.
4. Snapshot round-trip through JSON keeps `rngRoot` and `rngStreams`. A v2 snapshot restores and
   streams re-derive. Persist `load` migrates v2 → v3. A world with no own-stream system writes
   `version: 3` with `rngRoot` and without `rngStreams` (always v3).
5. Invalid `rngStreams` throws before any state change.
6. Golden: `deriveStream([1,2,3,4], 'rule:move')` gives four committed first draws.
7. Name clash: two own-stream systems named `s` get keys `s` and `s#1` with different streams.
8. Missing key: world A has rules R1, R2 (`own`); snapshot; world B registers R1, R2 and R3
   (`own`) and restores it. R3 draws `deriveStream(rngRoot, 'rule:R3')`'s sequence, B's next
   snapshot lists R3's stream, and snapshot → restore of B into a third world continues
   identically (strict hash, 100 ticks).
9. Reseed: replacing `rngRoot` and `seed` and clearing `rngStreams` changes every own-stream
   rule's draws; doing the same replacement twice gives identical draws.

**Docs:**

- SPEC §2.8 (streams), §2.5 (`rng` field), §7.1 (fields, v3), §7.3 (built-in migration);
- `doc/api.md`;
- the rules README;
- the persist README (migrations);
- CHANGELOG (v3 note);
- api-surface `core.d.ts`, `rules.d.ts`, `persist.d.ts`.

**Size:** M. **Studio:** installs rules with the doc's `settings.engine.rng` (default `'own'`
for new projects once 2.1 is consumed, `'shared'` for migrated ones), so the choice is part of
the doc and switching it is an A/B-evaluable change. PROPOSED-card deltas become attributable.
Multi-seed reporting stays available for intrinsic noise, using the reseed recipe above.
**Out of scope:** per-entity streams (a `random(self)` variant, possible follow-up), and own
streams for `once`/`reactive` systems beyond what the generic field gives.

---

### 4.5 Registry, name lookup, richer manifest (G10; O-30, O-78)

**Problem and evidence**

- Components register on first store access (O-30, `plan/FINDINGS.md:119`;
  `world.ts:892-906`).
- Events are known only once emitted, subscribed or named as triggers (O-51; `events.ts:141`).
- There is no lookup by name. `bridge.act` needs an `EventType` object (`agent.ts:60,117`), so a
  JSON act log or an MCP call cannot be turned back into an act (engine G4/G10).
- `describe().systems` lists only `{name, schedule, enabled}` (`manifest.ts:32-36`).

**API** (`@domecs/core`)

```ts
interface World {
  /** Eagerly register types so reflection lists them before first use (O-30). */
  register(...types: ReadonlyArray<ComponentType<unknown> | EventType<unknown> | ResourceType<unknown>>): Result<void, RegisterError>
  lookupComponent(name: string): ComponentType<unknown> | undefined
  /** undefined when unknown, or when two distinct known event types share the name. */
  lookupEvent(name: string): EventType<unknown> | undefined
  lookupResource(name: string): ResourceType<unknown> | undefined
  /** Every known event type, first-seen order (parity with componentTypes/resourceTypes). */
  eventTypes(): EventType<unknown>[]
}
export interface RegisterError {
  readonly kind: 'name_conflict'
  readonly registry: 'component' | 'event' | 'resource'
  readonly name: string
}

// SystemDefBase (additive)
interface SystemDefBase {
  /** JSON-safe annotation surfaced (cloned) in describe(); rules set { rule: name }. */
  meta?: JsonValue
}

// WorldManifest.systems entries (additive fields)
{ name; schedule; enabled; priority: number; order: number; rng: 'shared' | 'own';
  components: string[] /* names referenced by query/reactsTo, sorted */; meta?: JsonValue }

// Reflection (additive)
interface FieldSchema { readonly description?: string }
interface EventDefOptions { readonly description?: string }
interface EventDescriptor { readonly description?: string }
// persist ComponentFieldData gains description?: string (round-trips; never dropped)

// AgentBridge (additive overload)
act(name: string, payload: unknown, opts?: ActionOptions): ActionResult
```

**Semantics**

- **Discriminating type kinds.** `register` tells types apart by their internal brands: the
  component `__tag`, resource `__tag` and event `eventTag`.
  - A component under an already-registered name with a different object returns
    `name_conflict`. Today the same situation throws later, at first use.
  - An event under a name already held by a *different* event object returns `name_conflict`.
- **Implicit discovery is unchanged.** Emit, `on`, triggers and first use still work as before.
  F-8 identity semantics stay: two `defineEvent('X')` objects can coexist on the bus. The name
  index then marks the name ambiguous, and `lookupEvent` returns `undefined`.
- **Uniqueness rule.** Documented: an agent-facing command name must be unique, and `register` is
  how to assert that.
- **Name-based act.** `bridge.act(name, …)` resolves through `lookupEvent`. An unknown or
  ambiguous name returns `{ accepted: false, consumedTurn: false, reason, events: [] }`, with no
  emit and no tick (the O-39 pattern).
- **Manifest cost.** `describe()` stays O(systems + types). `components` comes from
  `collectHasComponents` on the normalized query, computed once at registration. `meta` is cloned
  per call (`cloneSerializable`).

**Snapshot and compat:** none (registries are not snapshotted).

**Tests (red → green).** New files `packages/domecs/test/registry.test.ts` and
`packages/domecs/test/agent-bridge.test.ts` (extended).

1. A registered-but-unused component appears in `componentTypes()`. Unregistered, it does not
   (red today for O-30).
2. `lookupComponent`, `lookupEvent` and `lookupResource` hit and miss. Two same-named events: the
   name is ambiguous, `lookupEvent` returns `undefined`, and `register` of the second returns
   `name_conflict`.
3. `bridge.act('Damage', {amount: 3})` behaves like `act(Damage, …)`, including schema rejection
   (O-39). An unknown name is rejected without a tick.
4. `describe().systems` carries `priority`, `order`, `rng`, `components` and cloned `meta`, and
   mutating the returned `meta` does not affect the next call.
5. `FieldSchema.description` round-trips through `serializeComponentType` and
   `registerComponentTypes`.

**Docs:**

- SPEC §2.3 (registry), §2.6 (event names), §6-style manifest section;
- `doc/api.md` (World, AgentBridge);
- AGENTS.md "observe/act" table, with name-based act;
- `skills/domecs/SKILL.md`;
- the persist README;
- api-surface `core.d.ts`, `persist.d.ts`.

**Size:** S–M. **Studio:** `buildGuestWorld` `register`s the std command events (and, after
G8, project events) so §4.7 restore and act-by-name resolve them. Studio's MCP surface has a
single `act` tool whose `event` argument is validated against `eventTypes()` + `describeEvent`
(no per-event tools); the HTTP API validates with the same descriptors; act logs store names.
**Out of scope** (studio-side): JSON Schema export from descriptors, paged `observe` filters,
default per-event resolvers. Also out of scope: `required`/`array`/`entity` field kinds, which
wait for a real collision.

---

### 4.6 `RuleError.field`: per-part attribution (G12; O-79)

**Problem and evidence.**

- `RuleError` is `{rule, position, message}` (`rules.ts:33-40`), with `position` relative to an
  unnamed expression.
- Studio re-parses each field to place errors (`doc/FINDINGS_studio.md`, third entry). An agent's
  `propose_change` needs precise errors to correct itself.

**API** (`@domecs/rules`, additive)

```ts
/** Which part of a RuleDef an error is about. Later minors add members (noted). */
export type RuleDefPath =
  | 'name' | 'schedule' | 'priority' | 'when'
  | { readonly query: number }
  | { readonly action: number; readonly part: 'set' | 'expr' }
  // 2.2: 'rng' | { readonly without: number }
  // 2.3: 'on' | 'self' | 'other' | { readonly effect: number; readonly part: string }
export interface RuleError {
  rule: string
  position: number
  message: string
  /** Set by compileRule/installRules from 2.1 on every error. */
  field?: RuleDefPath
}
```

**Semantics.** Every error that `compileRule` (`rules.ts:102-216`) and `update()` (duplicate name,
`:412-416`) produce gets a `field`. Each error maps to exactly one part:

| Error | `field` |
|---|---|
| Bad schedule | `'schedule'` |
| Non-finite priority | `'priority'` |
| Unknown query component | `{query: i}` |
| `when` parse, resolve or type error | `'when'` |
| Malformed `set`, unknown target component, forbidden field | `{action: i, part: 'set'}` |
| Expression errors | `{action: i, part: 'expr'}` |
| Duplicate name | `'name'` |

`position` keeps its meaning (an offset within that part's string, or −1). The union widens in
later minors. Consumers should keep a default branch, as the rules README notes.

**Tests:** `packages/domecs-rules/test/rules.test.ts` gains a table-driven test, one def per error
class, asserting `field` and `position`.
**Docs:** the rules README "Errors", `doc/api.md`, api-surface `rules.d.ts`.
**Size:** S. **Studio:** inline per-blank errors on sentence cards; precise `propose_change` errors.
**Out of scope:** multi-error recovery inside one expression (the parser stops at the first error).

---

### 4.7 Pending events travel with the snapshot (G21; O-90)

**Problem and evidence**

- Events emitted during tick N are delivered at step 1 of tick N+1 (SPEC §2.6). The snapshot
  does not carry them, and `restore()` throws them away (`world.ts:2005`
  `const abandoned = bus.takePending()`; SPEC §7.1: restore is exact "when … no undelivered
  events").
- `emit` effects (§6.1) and Contact begin/end events (§6.2) are in flight at almost every tick
  boundary. A fork taken there silently drops them, so the §6.1 and §6.2 live == fork tests
  could not pass, and studio's rebuild-and-restore on every doc edit would drop them from the
  live world too (determinism review 1).

**API** (`@domecs/core`, additive)

```ts
// WorldSnapshot (v3) — optional
export interface WorldSnapshot {
  /** Undelivered events, in bus order. Present only when snapshotted with `pendingEvents: true`. */
  readonly pendingEvents?: ReadonlyArray<{ readonly event: string; readonly payload: JsonValue }>
}
// SnapshotOptions (additive)
export interface SnapshotOptions {
  /** Record undelivered events (ED-16). Default false in 2.x. */
  readonly pendingEvents?: boolean
}
interface World {
  /** The undelivered events, in bus order (mirrors EventBus.pendingEvents). Read-only. */
  pendingEvents(): EmittedEvent[]
}
```

**Semantics**

- **Order.** Bus order: by first emit of each type, then payload order within a type (the order
  `EventBus.pendingEvents()` already defines and `world.action` already reports).
- **Snapshot.** With `pendingEvents: true`, each pending payload is converted with `toJsonValue`.
  A payload that is not plain data throws `TypeError` naming the event (by contract, like a
  non-plain component value). Without the option the field is absent and behaviour is 2.0's.
- **Restore.** When the field is present, `restore()` resolves each name through `lookupEvent`
  (§4.5) **before any effect** (O-41 pattern): an unknown or ambiguous name throws with the world
  untouched. It then replaces the restoring world's queue with the snapshot's events in order.
  When the field is absent, restore keeps today's behaviour (the queue is abandoned). A world that
  restores snapshots with events in flight must therefore know those types: `register` them in
  setup (studio does) or subscribe to them.
- **SPEC §7.1 amendment** ("Pending events"): the abandoned timeline's queue is replaced by the
  snapshot's queue when the snapshot carries one.
- **Canonical form.** `canonicalSnapshot` includes `pendingEvents` when present (§4.1), so two
  worlds that differ only in what is about to be delivered hash differently.
- **`world.pendingEvents()`** lets a host report what an act produced without `world.action()`
  (which runs `stepOnce()`, inserting a tick with dt 0). Studio uses it for act outcomes.

**Snapshot and compat.** v3 optional field (ED-2; E7 shipped it on the v2 envelope while E4 was on
hold, and it joins v3 unchanged when E4 lands). Default snapshots are unchanged (ED-16).

**Tests (red → green).** New file `packages/domecs/test/pending-events.test.ts`.

1. A system emits `Ping` at tick 5; snapshot with `pendingEvents: true` after tick 5; restore into
   a fresh world with the same setup; tick 6 delivers `Ping` in both worlds; strict hashes equal
   for 60 ticks. Without the option the fork misses it (red baseline).
2. Bus order is preserved across two event types and several payloads.
3. Unknown name and ambiguous name each throw before any state change (`hashSnapshot` of the
   restoring world unchanged).
4. A non-plain payload throws `TypeError` only when the option is set.
5. `canonicalSnapshot` differs when only `pendingEvents` differs.
6. `world.pendingEvents()` matches the snapshot field and does not consume the queue.

**Docs:** SPEC §7.1 (pending events), §2.6 note; `doc/api.md` (snapshot options); AGENTS.md
"Post-restore rebuild" note; api-surface `core.d.ts`.
**Size:** S. **Studio:** live snapshots, keyframes and every fork base use `pendingEvents: true`
once 2.1 is consumed. Until then studio guest worlds have no in-tick emitters (std command
systems do not emit; rules cannot emit before G8), so nothing is in flight at a boundary.
**Out of scope:** pending reactive marks (already carried by `changes`), event delay/scheduling.

---

## 5. Release 2.2: behaviour language I

### 5.1 Spatial grid and index (G2; O-8, part of O-7)

**Problem and evidence**

- No spatial structure exists. `@domecs/scene` is hierarchy only
  (`packages/domecs-scene/src/index.ts`). O-8 is open (`plan/FINDINGS.md:103`).
- G1 neighbour selectors and G7 contacts would be O(n²): 2 rules × 1000 entities already cost
  about 1.5 ms per fixed step (engine §5).

**API**

```ts
// @domecs/core — pure, world-free (ED-7)
export interface SpatialGrid {
  readonly cellSize: number
  readonly size: number
  clear(): void
  /** Insert or move. Non-finite coordinates are not indexed (the id is removed). */
  set(id: Entity, x: number, y: number): void
  delete(id: Entity): void
  position(id: Entity): { readonly x: number; readonly y: number } | undefined
  /** Ids with distance² <= r², ascending id. */
  within(x: number, y: number, r: number, accept?: (id: Entity) => boolean): Entity[]
  /** Minimum distance²; ties → lowest id. */
  nearest(x: number, y: number, options?: { maxDistance?: number; accept?: (id: Entity) => boolean }): Entity | undefined
  /** Unordered pairs with distance <= r (a < b), sorted by (a, b). */
  pairs(r: number, accept?: (a: Entity, b: Entity) => boolean): Array<[Entity, Entity]>
}
export function createSpatialGrid(cellSize: number): SpatialGrid

// @domecs/scene — world-bound
export interface SpatialHashOptions {
  readonly component: ComponentType<any>
  readonly x?: string          // default 'x'
  readonly y?: string          // default 'y'
  readonly cellSize: number
}
export interface SpatialIndex {
  /** Rebuild from the component's current values (O(n)). */
  refresh(): void
  within(x: number, y: number, r: number, filter?: readonly ComponentType<any>[]): Entity[]
  nearest(x: number, y: number, options?: { maxDistance?: number; filter?: readonly ComponentType<any>[]; exclude?: Entity }): Entity | undefined
  pairs(r: number, a: ComponentType<any>, b: ComponentType<any>): Array<[Entity, Entity]>
  dispose(): void
}
export function createSpatialHash(world: World, options: SpatialHashOptions): SpatialIndex
```

**Semantics**

- **Cells.** Cell coordinates are `Math.floor(v / cellSize)`, which is exact. Cell keys are
  integers packed by an exact rule.
- **Ordering.** Results are sorted by id explicitly, so they never depend on insertion or cell
  iteration order. Ties go to the lowest id.
- **`nearest` termination.** Rings expand around the query cell. The search stops only when a
  **conservative integer lower bound** on the distance of every unvisited cell exceeds the best
  distance found: for ring `k` the bound is `(k − 1) × cellSize`, compared as squared distance,
  so floating-point rounding can only make the search visit more cells, never fewer.
- **Normative:** results of `within`, `nearest` and `pairs` **never depend on `cellSize`**. Cell
  size is a pure performance setting (studio exposes it as `settings.spatial.cellSize`).
- **`refresh`** rebuilds fully in 2.2. Iteration is ascending id via `iterEntitiesWith`. An
  incremental refresh from O-42/O-54 change windows is a follow-up, not needed below about 5k
  entities.
- **`pairs(r, a, b)`** across tag types canonicalizes as follows: for `a ≠ b` the first element
  carries `a`; for `a == b`, first < second. Output is sorted.
- **Not snapshotted.** The grid and index are derived state (§3.2).
- **Cost targets** (bench): refresh ≤ 0.1 ms at 1000 entities; `nearest` ≤ 2 µs average at uniform
  density.

**Tests (red → green).** New files `packages/domecs/test/spatial-grid.test.ts` and
`packages/domecs-scene/test/spatial-hash.test.ts`.

1. `within`, `nearest` and `pairs` match a brute-force oracle on 2000 seeded points, including
   duplicates, cell borders and negative coordinates, for each cell size in
   `[0.5, 1, 7, 32, 100, 1e6]`; the outputs for all cell sizes are identical.
2. Same output for any insertion order.
3. Tie → lowest id.
4. NaN/∞ positions are not indexed.
5. Scene index: tag filters, `exclude`, refresh after moves and despawns.
6. `hashSnapshot` is unchanged by building or querying an index (the index stays out of the
   snapshot).

**Docs:** SPEC §1 (scene description), new SPEC §2.12 "Spatial queries"; `doc/api.md`; scene
README; api-surface `core.d.ts`, `scene.d.ts`; O-8 row notes that the occupancy layers remain open.
**Size:** M. **Studio:** settings pick the position component; forecasts stay O(n log n).
**Out of scope:** O-8 occupancy layers (`firstAt/allAt/isBlocked`), 3D, AABB/broadphase trees,
incremental refresh.

---

### 5.2 Rules: cross-entity refs, aggregates, math, `??`, `without` (G1; O-82)

**Problem and evidence**

- The grammar's only reference is `Component.field` on the evaluated entity
  (`packages/domecs-rules/src/parser.ts:5-27,212-236`; AST `ast.ts:46`). `resolveField` reads only
  the current entity (`rules.ts:292-312`).
- The functions are only `min max clamp abs sin cos floor random` (`ast.ts:11-33`).
- `query` is a list of names with no exclusion (`rules.ts:28,141-144`).
- "Chase the player", "keep distance" and "count enemies near the player" are inexpressible
  (critic fact 3; studio §2.6).

**Grammar additions** (EBNF; additions marked `(+)`, everything else unchanged from
`parser.ts:5-27`)

```
expr           := ternary
ternary        := nullish ( '?' ternary ':' ternary )?
nullish        := logicOr ( '??' logicOr )*                                  (+)
logicOr        := logicAnd ( '||' logicAnd )*
logicAnd       := equality ( '&&' equality )*
equality       := relational ( ('==' | '!=') relational )*
relational     := additive ( ('<' | '<=' | '>' | '>=') additive )*
additive       := multiplicative ( ('+' | '-') multiplicative )*
multiplicative := unary ( ('*' | '/' | '%') unary )*
unary          := ('!' | '-') unary | primary
primary        := number | string | 'true' | 'false' | 'dt' | 'time'
                | 'tick'                                                     (+) // world.time.tick
                | IDENT '.' IDENT                                            // self Component.field
                | entity '.' IDENT '.' IDENT                                 (+) // another entity's field
                | entity '.' 'id'                                            (+) // entity id (number)
                | call
                | '(' expr ')'
entity         := 'self'                                                     (+)
                | 'first'   '(' SET ')'                                      (+)
                | 'nearest' '(' SET ( ',' expr )? ')'                        (+) // optional max distance
                | 'entity'  '(' expr ')'                                     (+) // by numeric id
call           := FUNC '(' ( expr ( ',' expr )* )? ')'
                | 'has'         '(' ( entity ',' )? SET ')'                  (+)
                | 'count'       '(' SET ')'                                  (+)
                | 'exists'      '(' SET ')'                                  (+)
                | 'countWithin' '(' SET ',' expr ( ',' entity )? ')'         (+) // radius, optional centre
                | AGG           '(' SET ',' IDENT '.' IDENT ')'              (+) // field read on each member
                | 'distanceTo'  '(' entity ')'                               (+)
SET            := IDENT                                                      (+) // a component name: its holders
AGG            := 'sum' | 'avg' | 'minOf' | 'maxOf'                          (+)
FUNC           := 'min' | 'max' | 'clamp' | 'abs' | 'sin' | 'cos' | 'floor' | 'random'
                | 'sqrt' | 'pow' | 'atan2' | 'hypot' | 'sign' | 'round'      (+)
                | 'ceil' | 'lerp' | 'distance'                               (+)
```

- **Lexer.** It adds the `??` token to `MULTI_CHAR_PUNCT` (`lexer.ts:26`). The lexer does not add
  `self` or `tick` as tokens.
- **Reserved words.** The parser reserves `self` and `tick`, along with the later `other`, `event`
  and `pointer` (ED-9). A component with a reserved name cannot be referenced in an expression; the
  error is "reserved word", reported at the name's position. This is a release-noted behaviour
  change.
- **`id`.** After an entity, `id` is reserved. Component names that are not reserved are
  unaffected: `first.x` is still `Component.field`, and only `first(` starts a selector.
- **Fixed arities:**
  - one argument: `sqrt`, `sign`, `round`, `ceil`;
  - two: `pow`, `atan2`, `hypot`;
  - three: `lerp(a, b, t)`;
  - four: `distance(x1, y1, x2, y2)`.

**AST additions** (`ast.ts`; the `AstNode` union grows, additive for producers)

```ts
export type EntityNode =
  | { kind: 'self'; pos: number }
  | { kind: 'select'; op: 'first' | 'nearest'; set: string; maxDistance?: AstNode; pos: number }
  | { kind: 'entityById'; id: AstNode; pos: number }
  // 2.3: | { kind: 'other'; pos: number }
export type AstNode =
  | /* …existing… */
  | { kind: 'identifier'; name: 'dt' | 'time' | 'tick'; pos: number }        // widened
  | { kind: 'member'; target: EntityNode; component: string; field: string; pos: number }
  | { kind: 'entityId'; target: EntityNode; pos: number }
  | { kind: 'has'; target: EntityNode; component: string; pos: number }
  | { kind: 'aggregate'; op: 'count' | 'exists' | 'sum' | 'avg' | 'minOf' | 'maxOf'; set: string;
      component?: string; field?: string; pos: number }
  | { kind: 'countWithin'; set: string; radius: AstNode; centre?: EntityNode; pos: number }
  | { kind: 'distanceTo'; target: EntityNode; pos: number }
  | { kind: 'nullish'; left: AstNode; right: AstNode; pos: number }
export const SPECIAL_FORMS: Readonly<Record<string, { args: ReadonlyArray<'set' | 'entity' | 'expr' | 'memberField'>; optional: number }>>
export function walkComponentRefs(node: AstNode, visit: (component: string, field: string | null, pos: number, role: 'self' | 'member' | 'set') => void): void
```

`walkFieldRefs` keeps its current behaviour: it visits self fields only. `walkComponentRefs`
visits every component name, so that `compileRule` resolves sets, member reads and `has` targets,
and applies the `FORBIDDEN_FIELDS` check (`rules.ts:11`) to member fields as well.

**Evaluator environment** (`EvalEnv`, `evaluator.ts:8-23`). All additions are optional, so the
evaluator stays world-agnostic:

```ts
interface EvalEnv {
  self?: number
  readField?(entity: number, component: string, field: string): Value | undefined
  members?(set: string): readonly number[]                // ascending id, stable within a run
  isAlive?(entity: number): boolean
  has?(entity: number, component: string): boolean
  position?(entity: number): { x: number; y: number } | undefined
  nearest?(set: string, x: number, y: number, maxDistance: number, exclude: number | undefined): number | undefined
  within?(set: string, x: number, y: number, r: number, exclude: number | undefined): readonly number[]
  tick?: number
}
```

A special form whose hook is missing raises a `RuleEvalError` ("not available in this
environment").

**Rule definition additions**

```ts
interface RuleDef {
  /** Components that exclude an entity from the rule (Not(Has(...))). */
  without?: string[]
}
interface InstallRulesOptions {
  /** Position source for nearest/countWithin/distanceTo; required if any rule uses them. */
  readonly spatial?: { readonly component: string; readonly x?: string; readonly y?: string; readonly cellSize?: number }
}
```

**Semantics**

- **Membership.** `SET` is "entities that have component *C*". Member lists come from
  `world.listEntities(Has(C))`, which is ascending id (SPEC §8). Each list is computed **once per
  rule run** and cached by set name. Membership is stable within a run because rule actions never
  change structure (and in 2.3, effects are deferred to the end of the run).
- **Selectors.**
  - `first(S)` is the lowest-id member other than self.
  - `nearest(S[, d])` minimizes distance² from self's position, breaking ties by lowest id,
    excluding self, within `d` if given.
  - `entity(n)` is the alive entity with id `n`; `n` must be an integer.
  - An empty result is **no value**.
- **Reads.** `e.C.f` reads `C.f` on `e` as an own property only (O-67). A missing component or
  field is **no value**. `e.id` is the id as a number. `self.C.f` is the same as `C.f`.
- **`has([e,] C)`** is a boolean, and `e` defaults to self.
- **Aggregates.**
  - `count(S)` is the number of members; `exists(S)` is `count > 0`.
  - `sum/avg/minOf/maxOf(S, C.f)` evaluate `C.f` on each member, skipping members without it, and
    skipping a non-number value with a fault (`expectNumber`).
  - The sum of an empty set is 0. `avg`, `minOf` and `maxOf` over an empty set give **no value**.
  - Set aggregates **include** self (ED-10). `countWithin(S, r[, e])` counts members within `r` of
    `e` (default self), excluding `e`.
- **Distance.** `distanceTo(e)` is `sqrt(dx² + dy²)` between self's and `e`'s positions. `distance`
  is the same formula over four numbers.
- **Math.** `atan2`, `pow` and `hypot` use `dmath`, whose 2.2 additions land in this item
  (§4.2, ED-18). `sqrt` uses `Math.sqrt`. `sign`, `round`,
  `ceil` and `lerp` (`a + (b - a) * t`) are exact JS arithmetic. A non-finite intermediate result is
  allowed; the existing write check rejects non-finite writes.
- **No value and `??`.** "No value" is a new `RuleEvalError` subclass, `RuleNoValueError` (internal;
  `instanceof RuleEvalError` still holds). It covers a missing self field, a missing member field,
  an empty selector result, a dead `entity(n)`, and an empty `avg`/`minOf`/`maxOf`.
  - `a ?? b` evaluates `a`. On a no-value error **only**, it evaluates `b`. Type errors propagate.
  - An uncaught no-value error is the existing per-entity `rule_eval_failed` fault (O-68), so
    behaviour without `??` is unchanged.
- **Read timing** (ED-11). Field reads are live. The rule visits entities in ascending id and
  commits each entity atomically, so entity *k* sees the committed writes of entities with lower
  ids from the same run, exactly as own-field reads behave today. That is deterministic.
- **Spatial selection.** `nearest`, `countWithin` and `distanceTo`'s target selection use a grid
  built from `spatial.component` positions **at the start of the rule's run** (one grid per set
  per run, from core `createSpatialGrid`). `distanceTo` itself reads live positions.
- **Memoization.** A set aggregate that does not depend on self (`count`, `exists`, `sum`, `avg`,
  `minOf`, `maxOf`) is memoized for the run when its field's component is not among the rule's
  write targets. That is decided at compile time. Otherwise it is recomputed per entity. Results
  are exact either way.
- **Typechecking** (`typecheck.ts`). `StaticKind` gains `'entity'`.
  - An entity used as a value, rather than as a member base, selector argument or `has` target, is
    a compile error ("use .id").
  - `has` and `exists` are boolean; `count` and `countWithin` are number; member reads are
    `unknown`.
  - Spatial forms without `spatial` configured are a compile error, with `field: 'when'` or
    `{action, part: 'expr'}`.
- **`without`.** It compiles to `And(...query.map(Has), ...without.map(c => Not(Has(c))))`. An
  unknown name is a `RuleError` with `field: { without: i }`.
- **RNG.** `random()` draws from the rule's system stream (§4.4). Selectors draw nothing.
- **Determinism.** All iteration is ascending id. Distance comparisons are exact double
  arithmetic. Ties are broken by id. Caches never outlive a run, and nothing derived is
  snapshotted.

**Cost targets** (`bench/` rules workload, 1000 entities):

- a rule using `nearest(Player)` costs ≤ 3× a self-only rule;
- `sum(Enemy, Health.hp)`, memoized, costs ≤ 1.2×.

**Snapshot and compat.** No format change. Existing rule JSON parses identically, except for
reserved-word component names (release-noted).

**Type-level change.** `FUNCTION_NAMES` is a const tuple and `FUNCTION_ARITY` is
`Record<FunctionName, number>` (`rules.d.ts:11-14`), so adding names widens `FunctionName`.
Consumers with exhaustive switches over it (studio's `sentences.ts`) stop compiling until they add
a case or a default branch. This is listed under **type-level changes** in the CHANGELOG and the
2.2 release notes; the rules README recommends a default branch.

**Tests (red → green).** In `parser.test.ts`, `evaluator.test.ts`, `rules.test.ts` and a new
`cross-entity.test.ts`.

1. Parser:
   - every new form, with positions;
   - arity errors;
   - reserved words;
   - `first.x` still parses as `Component.field`;
   - `??` precedence (`a ?? b || c` parses as `a ?? (b || c)`; `a ? b : c ?? d`);
   - depth and length limits (O-66) hold for the new nodes.
2. Chase: enemies set `Velocity.x = (first(Player).Pos.x - Pos.x) * k`. After N ticks, the
   positions equal a hand-computed oracle.
3. `nearest` against a brute-force oracle over 500 seeded entities, including ties and
   `maxDistance`.
4. Aggregates:
   - empty sets;
   - members missing the field are skipped;
   - a non-number member value faults;
   - memoized and non-memoized paths give identical results (force both via a write target).
5. `??` catches no-value but not type errors. Without `??`, the fault is `rule_eval_failed` on the
   entity.
6. Gauss–Seidel: a rule whose read depends on a lower-id entity's write in the same run gives the
   documented result. Live vs fork give equal hashes.
7. `without` excludes holders, and an unknown name reports `{without: i}`.
8. Spatial forms without `spatial` are a compile error with the right `field`.
9. `atan2`, `pow` and `hypot` equal `dmath` bit for bit.
10. Golden (§3.4) adds chase and keep-distance scenarios.

**Docs:**

- the rules README (grammar, semantics, cost model);
- `doc/api.md` (rules);
- a new SPEC rules appendix, or SPEC §2.13 "Rules language" if the owner prefers it in SPEC;
- the AGENTS.md recipe "Behaviours as rules";
- `skills/domecs/SKILL.md`;
- api-surface `rules.d.ts`.

**Size:** L. **Studio:** sentence templates ("move toward the nearest ___"); metrics; agent
proposals stay JSON. Component renames use `walkComponentRefs` (so `first(P).C.f`, sets, `has`
targets) plus `without[]`, not the self-only `walkFieldRefs`, once 2.2 is consumed.
**Out of scope:** multi-component sets (use a tag component), predicates inside aggregates
(`count(Enemy where …)`), writes to other entities (use §6.1 effects or events), resource reads in
rules, a JS escape hatch.

---

### 5.3 World expressions for metrics (G13; O-83)

**Problem and evidence.** Expressions can only run inside a rule, against one entity. Timeline
probes, playtest findings and PROPOSED-card outcomes are expressions with no self, for example
`countWithin(Enemy, 40, first(Player))` (engine G13; critic Q3).

**API** (`@domecs/rules`)

```ts
export interface WorldExpression {
  readonly source: string
  readonly ast: AstNode
  /** Read-only: never mutates the world, never draws randomness, never moves change windows. */
  evaluate(world: World): Result<number | string | boolean, RuleFault>
}
export function compileWorldExpression(
  source: string,
  resolve: (name: string) => ComponentType<any> | undefined,
  options?: { readonly spatial?: InstallRulesOptions['spatial'] },
): { expression: WorldExpression; errors: [] } | { expression: null; errors: RuleError[] }
```

**Semantics**

- **Same grammar, with these rejected at compile time:**
  - bare `Component.field`, `self`, `has(C)` without an entity, `distanceTo` and `countWithin`
    without a centre ("no entity in a world expression; use first(S)…");
  - `dt`;
  - `random()`. If allowed, it would advance an RNG, so measuring a world would change its future.
    This rejection is the key determinism rule here.
- **Allowed values.** `time` is `world.time.elapsed`, and `tick` is `world.time.tick`.
- **Evaluation** uses `listEntities` (one-shot selectors, no change windows) and `getComponent`.
  Membership, grids and memoization are per call. A no-value error with no `??` returns
  `err({ kind: 'rule_eval_failed', rule: '<expr>', message })`.
- **Determinism.** Evaluation leaves `hashSnapshot(world.snapshot({}), { includeChanges: true })`
  unchanged. A test asserts this.

**Tests (red → green).** New file `world-expression.test.ts`.

1. Each rejected form gives a compile error with its position.
2. Metric values match JS oracles.
3. The strict hash is unchanged by evaluating a metric 1000 times.
4. `??` fallback works.
5. Errors are data: there are no throws for bad input.

**Docs:** the rules README "World expressions"; `doc/api.md`; api-surface `rules.d.ts`.
**Size:** S. **Studio:** `MetricData.expr` compiled once per doc version and evaluated per
forecast sample. Studio's structured builtins translate 1:1 (OD-3); equivalence tests run when
2.2 is consumed.
**Out of scope:** resource reads (`Resource.field`, a follow-up once resources need it), time-series
functions (`delta`, `rate`), which studio computes over samples.

---

### 5.4 Input in rules (G16; O-86)

**Problem and evidence.** Rules cannot read `world.input`; it is only reachable from JS systems
(engine G16). Data-defined player control keeps the live lane reproducible: studio records input
frames in its own act log and applies them with `setInput` before each step.

**Grammar additions (2.2)**

```
primary += 'pointer' '.' ( 'x' | 'y' | 'buttons' | 'wheel' )
call    += ( 'key' | 'pressed' | 'released' | 'mod' ) '(' expr ')'   // arg: a string
```

**API.** `EvalEnv.input?: { key(name: string): boolean; pressed(name: string): boolean; released(name: string): boolean; mod(name: 'ctrl' | 'alt' | 'shift' | 'meta'): boolean; pointer: { x: number; y: number; buttons: number; wheel: number } }`.
Rules wire it from `ctx.input`.

**Semantics**

- **Values.**
  - `key(n)` is `input.keys.has(n)`, the held state.
  - `pressed(n)` and `released(n)` read `keyDelta`, which is edge-triggered.
  - Key names are the names `InputSnapshot.keys` carries; see the `@domecs/input` README.
- **Edge reads in `fixed` rules are compile errors.** `pressed` and `released` in a `fixed` rule
  are a `RuleError` (AGENTS.md rule 4: `keyDelta` is one render tick).
- **Not allowed in world expressions.** A metric must not depend on input. It is a compile error.
- **Determinism.** Input is whatever `setInput` installed before the step; hosts that record it
  (studio's act log) reproduce it. Branches under the "no input" policy have an empty
  `world.input`.

**Tests:**

1. Held and edge reads against `setInput`.
2. A fixed-rule edge read is a compile error.
3. Apply the same `setInput` sequence to a live world and to a fork restored mid-sequence:
   equal strict hashes (no recorder needed).

**Docs:** rules README; `@domecs/input` README cross-link; api-surface `rules.d.ts`.
**Size:** S. **Studio:** player-controlled entities in the You/live lane, without code; the
`hold-input` forecast policy and input-frame scripts in `run_playtest` from 2.2.
**Out of scope:** gamepads (add `pad(i).axis(j)` on demand), pointer-to-world transforms (studio
camera).

---

## 6. Release 2.3: behaviour language II and authoring ergonomics

### 6.1 Rule effects and event-triggered rules (G8; O-84)

**Problem and evidence**

- `RuleActionDef` is only `{set, expr}` (`rules.ts:13-17`). Writes must target an existing field
  of the same kind (`checkWrite`, `:225-239`).
- Rules are always per-entity polling on `tick` or `fixed` (`:21`). They cannot react to an event,
  emit one, spawn, despawn, or toggle tags.
- In a rules-only project, `act()` has nothing to hit (engine G8; critic fact 3).

**API** (`@domecs/rules`, additive; ED-8)

```ts
interface RuleDef {
  schedule: 'tick' | 'fixed' | 'event'            // 'event' added
  /** Event name that triggers the rule (required iff schedule === 'event'). */
  on?: string
  /** Event rules: expression giving self's entity id from the payload, e.g. "event.target". */
  self?: string
  /** Event rules: expression giving `other`'s entity id, e.g. "event.b". */
  other?: string
  /** Deferred structural/command effects, applied at the end of the rule's run. */
  effects?: RuleEffectDef[]
}
export type RuleEffectDef =
  | { readonly emit: string; readonly payload?: Readonly<Record<string, string>> }                 // field -> expr
  | { readonly spawn: string; readonly at?: { readonly x: string; readonly y: string };
      readonly set?: Readonly<Record<string, string>> }                                            // "Component.field" -> expr
  | { readonly despawn: 'self' | 'other' }
  | { readonly add: string; readonly to?: 'self' | 'other'; readonly set?: Readonly<Record<string, string>> }
  | { readonly remove: string; readonly from?: 'self' | 'other' }
interface InstallRulesOptions {
  /** Event types by name; default world.lookupEvent. */
  readonly resolveEvent?: (name: string) => EventType<unknown> | undefined
  /** Prefab bags by name for `spawn`; called per spawn; return a fresh bag. */
  readonly prefabs?: (name: string) => ComponentBag | undefined
}
export function compileRule(def: RuleDef, resolve: (name: string) => ComponentType<any> | undefined, options?: Pick<InstallRulesOptions, 'resolveEvent' | 'prefabs' | 'spatial'>): …
```

**Grammar additions (2.3)**

```
primary += 'event' '.' IDENT                // payload field; event rules only
entity  += 'other'                          // event rules with an `other` binding only
```

**Semantics**

- **Event rules.** `schedule: 'event'` registers a core event system with `triggers: [type]`. The
  event is then listed in `describe()` (O-51). For each payload of `on` delivered this tick, in
  emission order:
  - **With `self`:** evaluate it to an id. If the entity is not alive or does not match
    `query`/`without`, skip silently. That is a deterministic no-op. Otherwise run `when`,
    `actions` and `effects` with that self.
  - **Without `self`, non-empty `query`:** broadcast. The rule runs for each matching entity in
    ascending id, per payload.
  - **Without `self`, empty `query`:** world scope, once per payload. `set` actions are a compile
    error here, because they need a self.
- **Event payload reads.** `event.f` reads the payload field. A missing field is no value. `other`
  resolves from the `other` binding; a dead entity is no value.
- **Compile-time checks.**
  - `on` must resolve, otherwise `field: 'on'`.
  - `event.f` and `other` outside event rules are errors.
  - When the event declares a schema, `event.f` must be a declared field.
- **Effects** are queued only if the entity's actions all succeeded (O-68 atomicity) and its
  `when` held. They are applied **at the end of the rule's run**, in queue order (entity ascending,
  then effect index), so iteration and membership stay stable within the run.
  - **`emit`:** the payload is built from expressions evaluated at queue time, and validated with
    `validateEventPayload` at apply time. An invalid payload is a `rule_eval_failed` fault on the
    queuing entity. The event is delivered **next tick**, per bus semantics; the tick delay is
    documented.
  - **`spawn`:** `prefabs(name)` is called. The resolver is checked at compile time: an unknown
    prefab is a `RuleError` `{effect: i, part: 'spawn'}`. Each entry value is plain-data cloned,
    because spawn shallow-copies (O-34). `set` overrides are evaluated at queue time with the
    spawner as self. `at` writes the `spatial` position fields and requires `spatial`. Ids are
    assigned in apply order, so they are deterministic.
  - **`despawn`:** idempotent. Later effects targeting a despawned entity are skipped.
  - **`add` / `remove`:** `add` uses component defaults plus `set` overrides. Adding an existing
    component applies only `set` (and marks it changed). Removing an absent component is a no-op.
- **Writes to other entities** stay out of `actions` (self only). They go through `emit` plus an
  event rule, or through `add`/`remove`/`despawn` on `other`.
- **RNG.** Event rules may use `rng: 'own'`. Draws happen at evaluation, never at apply.

**Snapshot and compat.**

- No format change.
- Existing defs are unchanged: no `effects`, no `on`.
- The `RuleDefPath` union adds `'on' | 'self' | 'other' | { effect: number; part: string }`.

**Tests (red → green).** New file `effects.test.ts`, plus additions to `rules.test.ts`.

1. Command: `act('Move', {target, dx})` and the event rule `self: 'event.target'` move only that
   entity, without code systems.
2. Broadcast and world-scope event rules. A `set` in a world-scope rule is a compile error.
3. `emit` arrives next tick and triggers a chained event rule then. A schema-invalid emit faults.
   A fork snapshotted (`pendingEvents: true`) **between** the emit and its delivery delivers it
   too, with equal strict hashes (§4.7).
4. Spawn: deterministic ids, `at` and `set` applied, prefab bag not shared between spawns (mutate
   one, the other is unchanged).
5. Despawn self while later entities in the run read it: their reads see it alive, because the
   despawn is deferred.
6. Atomicity: a failing action means no effects are queued for that entity.
7. Live vs fork equal strict hashes with spawns, despawns and emits in flight across the
   snapshot point (the id cursor continues, O-38; pending events, §4.7).
8. `field` attribution for every new error.

**Docs:** the rules README ("Event rules", "Effects"); `doc/api.md`; AGENTS.md recipe "Commands as
event rules"; `skills/domecs/SKILL.md`; api-surface `rules.d.ts`.
**Size:** M–L. **Studio:** "when hit, lose 1 hp and flash" sentence cards; data-defined commands
for agents; prefabs from entity types.
**Out of scope:** emit with a delay or schedule, spawning hierarchies (`Parent` lives in scene; a
follow-up could add a `parent: 'self'` effect via an injected hook), effects inside world
expressions.

---

### 6.2 Contacts: overlap events for rules (G7; O-85)

**Problem and evidence.** There is no overlap or contact detection (engine G7). Pickups, damage on
contact, goals and playtest findings ("player hit at tick 340") need it.

**API** (`@domecs/scene`; depends on §5.1)

```ts
export const Contact: EventType<{ a: Entity; b: Entity; phase: 'begin' | 'stay' | 'end' }>  // declared schema
export const ContactState: ResourceType<{ pairs: Array<[Entity, Entity]> }>                // sorted; snapshotted
export interface ContactsOptions {
  readonly position: { readonly component: ComponentType<any>; readonly x?: string; readonly y?: string }
  /** Radius per entity: a fixed number or a component field. */
  readonly radius: number | { readonly component: ComponentType<any>; readonly field: string }
  /** Tag pairs to test, e.g. [[Player, Enemy], [Player, Pickup]]. */
  readonly pairs: ReadonlyArray<readonly [ComponentType<any>, ComponentType<any>]>
  readonly stay?: boolean               // emit 'stay' each step while overlapping; default false
  readonly schedule?: 'fixed' | 'tick'  // default 'fixed'
  readonly priority?: number            // default 150: the contacts band (§4.3), after compose at 100
  readonly cellSize?: number            // default 2 × max fixed radius, else 64
  readonly name?: string
}
export function installContacts(options: ContactsOptions): Plugin
```

**Semantics**

- **Detection.** Each run rebuilds a `createSpatialGrid` from positions. Two entities overlap when
  `dist² <= (ra + rb)²`.
- **Pair canonicalization.** The first element carries the first tag; for same-tag pairs, a < b.
  The current set is sorted, then diffed against `ContactState`, giving `begin` (new), `end` (gone)
  and optionally `stay`.
- **Emission order.** Phase order `end`, then `begin`, then `stay`, each sorted by (a, b), emitted
  via `ctx.events.emit`. Rules see them **next tick**, through `on: 'Contact'`, `self: 'event.a'`,
  `other: 'event.b'`.
- **State.** `ContactState` is an ordinary resource, so restore continues begin/end correctly
  (live == fork). A despawned entity's pairs produce `end` once.
- **Determinism.** Everything is sorted, and the grid is rebuilt per run. Radii read live.

**Tests (red → green).** New file `packages/domecs-scene/test/contacts.test.ts`.

1. Begin, stay and end sequences match an oracle.
2. Same-tag pairs.
3. A despawned entity ends its contact.
4. A snapshot mid-contact, taken at a boundary where `begin`/`end` events are in flight
   (`pendingEvents: true`), restores to identical future events and equal strict hashes.
5. A rules integration test: contact damage via an event rule.
6. 1000 entities × 2 pairs: ≤ 0.5 ms per run (bench).

**Docs:** scene README "Contacts"; `doc/api.md`; SPEC §2.12; api-surface `scene.d.ts`.
**Size:** M. **Studio:** collider authoring; findings keyed on Contact events.
**Out of scope:** AABB and polygon shapes, physics response, continuous collision.

---

### 6.3 `runSystems` and `render` without a tick (G15; O-88)

**Problem and evidence**

- There is no way to prime derived state (`composeTransforms` → `WorldTransform`) without
  `time.tick += 1` (`doc/FINDINGS_studio.md`, second entry).
- A heartbeat `step(0)` re-fires `tickStart`/`tickEnd` (`world.ts:1168-1184`; FINDINGS_studio,
  fourth entry).
- After a restore, scrub or branch selection, the stage must redraw without moving tick identity.

**API** (`@domecs/core`)

```ts
interface World {
  /**
   * Run the named enabled `tick`/`fixed` systems once now, in run order (priority, order,
   * registration), without advancing time, flushing events, or firing tickStart/tickEnd.
   * Returns the names it ran. Unknown names, or names of other schedules, are skipped and reported.
   */
  runSystems(names: readonly string[]): { readonly ran: string[]; readonly skipped: string[] }
  /** Run plugin onRender only (heartbeat TickInfo); no signals, no systems. */
  render(): void
}
```

**Semantics**

- **Context.** `ctx.time` is the current `time` (its `scaledDelta` is whatever the last tick left)
  and `ctx.events` is the current view. A run is a normal run for change windows (O-42): the
  system's `seenThrough` advances.
- **Recording.** Mutations made here are out of tick. If a recorder (§7.1) is attached, it notes a gap.
  Documented: use this only for **derived and transient** state that the next tick recomputes
  anyway.
- **`render()`** advances query windows as the heartbeat render does (`world.ts:1180-1183`), so a
  renderer does not repaint the same marks again.

**Tests:**

1. After `restore`, `runSystems(['domecs-scene:compose-transforms:…'])` populates `WorldTransform`
   with `tick` unchanged.
2. `render()` calls `onRender` without `tickStart`/`tickEnd` subscribers firing.
3. The default `hashSnapshot` is unchanged by `render()`.
4. A recorder gap is noted for `runSystems`.

**Docs:** SPEC §4.0 (beside the heartbeat); `doc/api.md`; `doc/FINDINGS_studio.md` entries 2 and 4
closed; api-surface `core.d.ts`.
**Size:** S. **Studio:** not used on authoritative worlds. Studio makes `WorldTransform`
non-transient (snapshotted, hashed) and computes frame positions with the pure compose function,
so it needs no priming; calling `runSystems` on only some worlds would add change marks to them.
Renderer-side stage worlds and other engine users still need it (FINDINGS_studio 2, 4).
**Out of scope:** running `event`, `reactive` or `once` systems on demand.

---

### 6.4 Small items (O-36, O-89)

| Item | API | Semantics | Tests | Size |
|---|---|---|---|---|
| **O-36 transient resources** | `defineResource(name, { transient: true })` — **new option**: `ResourceOptions` has no `transient` today | Skipped by `snapshot()`. `restore()` keeps the live value. `hashSnapshot` therefore ignores render caches. Validation is unchanged. | Snapshot omits it; restore keeps the live value; hash is stable when a camera resource changes | S |
| **O-89 bridge reset options** | `AgentBridge.reset(options?: { scale?: number; input?: 'keep' \| 'empty' })` | Restores the baseline, then optionally `setScale(scale)` and `setInput(empty)`. This covers the gap engine G18 notes (`agent.ts` reset doc). `once` systems still do not re-run (documented, SPEC §7.1) | Episode boundary hygiene test in `agent-bridge.test.ts` | S |

**Docs:** SPEC §2.11 (transient resources), persist README, AGENTS.md "Minimal agent episode",
api-surface.

---

## 7. Formerly conditional items (§7.1–§7.3 scheduled; §7.4 conditional)

Revision 2 made all four items conditional (ED-13, ED-12). **Revision 3 (owner decision,
2026-10-19) schedules §7.1–§7.3**; only §7.4 keeps its gate. The sections keep their numbers so
that cross-references from the studio spec and plan stay valid. The full specs, including every
review fix, are unchanged except where marked.

| Item | Release | Plan milestone | Order | Studio's own implementation (kept) |
|---|---|---|---|---|
| §7.1 act log + replay (G4) | **2.2** | E19 | after §5.4, before the 2.2 RC | `RunAct` log + doc segments at the `LiveSession` boundary |
| §7.2 `createBranch` / `runBranch` (G3) | **2.2** | E20 | after §7.1 (uses `ActLog`, `ReplayError` and the frame code), before the 2.2 RC | `buildGuestWorld` + `applyDocChange` (arm B needs doc-aware transforms) |
| §7.3 scenes (G14) | **2.3** | E21 | after §6.4 (test 7 uses §6.1 event rules), before the 2.3 RC | catalog with `Origin {type, scene, sid}` + `studio.GotoScene` |
| §7.4 `redefineComponent` (G11) | conditional | (EC4) | built when studio measures rebuild-and-restore > 50 ms at 1000 entities, or finds a case rebuild cannot fix | rebuild + `transformSnapshot` on every shape edit |

Studio's plan does not consume §7.1–§7.3 (it keeps its own doc-aware versions); the engine
versions serve engine users and the AGENTS.md recipes they add. If §7.4 is gated in, it ships as
the next 2.x minor with its own plan milestone, and its ledger id (Appendix A) moves from
"conditional" to that release.

**Scheduling notes (revision 3).**

- Core tests cannot depend on `@domecs/rules` (E1 implementation note). Where §7.1 and §7.2
  tests say "own-stream rule", the core tests use a core system with `rng: 'own'` (§4.4); a
  rules-level leg goes in the fork-equivalence suite at the 2.2 RC.
- §7.1 depends on §4.1 (strict hash), §4.4 (own streams), §4.5 (`lookupEvent`) and §4.7
  (`pendingEvents` in the base hash); all ship in 2.1. Its `JsonInput` covers the input that
  §5.4 rules read.
- §7.3 test 7 is a `@domecs/scene` test that uses `@domecs/rules` event rules, like §6.2's
  rules integration test.
---

### 7.1 Act log recording and replay (G4; O-80) — scheduled in 2.2 (E19)

**Schedule.** 2.2, after §5.4 and before the 2.2 release candidate (owner decision, revision 3;
ED-13). Revision 2 gated it on a named consumer. Studio still records acts at its own
`LiveSession` boundary with doc-version segments, which this engine log cannot represent.

**Problem and evidence**

- There is no recorder and no replay.
- `bridge.act` takes `EventType` objects (`agent.ts:60,117`).
- `InputSnapshot` holds `Set`s (`packages/domecs/src/input.ts:40-55`), so it is not JSON.
- Live `step(dt)` uses wall-clock dt. Tick systems are reproducible only if each frame's dt is
  recorded (engine G4).
- Lanes need replayable artifacts: "You/live", playtests with numbered findings, scrubbing from
  keyframes.

**API** (`@domecs/core`, new module `src/replay.ts`)

```ts
export interface JsonInput {
  readonly keys: readonly string[]                    // sorted
  readonly pressed?: readonly string[]                // sorted; omitted when empty
  readonly released?: readonly string[]
  readonly mods?: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }
  readonly pointer?: { x: number; y: number; buttons: number; delta: { x: number; y: number }; wheel: number; entered: readonly Entity[] }
  readonly gamepads?: readonly GamepadSnapshot[]
  readonly focus?: { activeTag: string; consumesKeys: boolean }
}
export function encodeInput(input: InputSnapshot): JsonInput
export function decodeInput(json: JsonInput): InputSnapshot

export interface ActRecord {
  readonly event: string
  readonly payload: JsonValue
  /** How the act entered the world. Only 'action' acts are schema-validated on replay. */
  readonly via: 'emit' | 'action'
}
export interface ActLogFrame {
  /** world.time.tick before this step. */
  readonly tick: number
  /** The dt passed to step(dt); null = stepOnce(). */
  readonly dt: number | null
  /** time.scale for this step when it differs from the previous frame (initially 1). */
  readonly scale?: number
  /** Events emitted outside a tick since the previous step, in emit order. */
  readonly acts?: readonly ActRecord[]
  /** world.input as systems saw it this tick, when it differs from the previous frame. */
  readonly input?: JsonInput
}
export interface ActLog {
  readonly format: 'domecs-actlog'
  readonly version: 1
  readonly startTick: number
  readonly fixedStep: number
  /** time.scale when recording started. */
  readonly startScale: number
  /** hashSnapshot(…, { includeChanges: true }) of the world when recording started. */
  readonly baseHash: string
  readonly frames: readonly ActLogFrame[]
  readonly checkpoints?: ReadonlyArray<{ readonly tick: number; readonly hash: string }>
  /** Points where the log stops describing the world (replay past them is unverified). */
  readonly gaps?: ReadonlyArray<{ readonly tick: number; readonly reason: 'out_of_tick_mutation' | 'unserializable_payload' | 'restore' | 'heartbeat_input' }>
}
export interface Recorder {
  readonly active: boolean
  /** The log so far (a copy). */
  peek(): ActLog
  /** Stop recording and return the log. */
  stop(): ActLog
}
export function createRecorder(world: World, options?: { readonly hashEvery?: number }): Recorder

export type ReplayError =
  | { readonly kind: 'invalid_log'; readonly reason: string }
  | { readonly kind: 'base_mismatch'; readonly expected: string; readonly actual: string }
  | { readonly kind: 'unknown_event'; readonly event: string; readonly tick: number }
  | { readonly kind: 'rejected_payload'; readonly event: string; readonly tick: number; readonly reason: string }
  | { readonly kind: 'diverged'; readonly tick: number; readonly expected: string; readonly actual: string }
export interface ReplayOptions {
  /** Restore this first (else the world must already be at the log's base). */
  readonly base?: WorldSnapshot
  /** Stop after the frame that ends at this tick. */
  readonly toTick?: number
  /** Compare checkpoints (default true). */
  readonly verify?: boolean
  readonly onFrame?: (tick: number, world: World) => void
}
export function replay(world: World, log: ActLog, options?: ReplayOptions): Result<{ readonly ticks: number; readonly hash: string }, ReplayError>
```

**Semantics**

- **Capture.** The recorder attaches to a **world-internal tap**: a symbol-keyed hook, like the
  component `internal()` pattern, not a new public signal. The tap reports four things:
  1. **External emits.** Every emit **not made by a system or an `on` handler** is recorded,
     with `via`, into the *next* frame's `acts`. That covers `world.emit`, `turn` and `action`
     outside a tick, and emits from plugin hooks (`onTickStart` runs before `bus.flush()`, so
     its emits are delivered in the same tick) during full ticks **and heartbeats** (a
     heartbeat sets `inTick`, so an "outside a tick" test would miss them). A replay world
     without that plugin then still reproduces them. Emits from systems and `on` handlers are
     reproduced by replay, so they are not recorded. A payload that is not JSON-safe (checked
     with `toJsonValue`) records a gap of `unserializable_payload`.
  2. **Frame start.** At a non-heartbeat `runTick`, the recorder reads `time.scale` **on entry to
     `runTick`**, before plugin hooks run, because `scaledDt` is computed from it there; a
     `tickStart` pause control (AGENTS.md rule 5) would otherwise replay with the wrong dt. After
     plugin `onTickStart` (so an input plugin's snapshot is in place) it writes
     `{tick, dt, scale?, input?}`. `dt` is the caller's dt, and `null` for `stepOnce`. `input` is
     `encodeInput(world.input)`, delta-encoded against the previous frame.
  3. **Out-of-tick mutations.** Spawn, despawn, add/remove component, `markChanged` and
     `setResource` while not ticking record a gap of `out_of_tick_mutation`. A replay cannot
     reproduce a direct write (engine G4's studio rule: route every runtime perturbation through a
     typed command).
  4. **`restore()`** records a gap of `restore`.
- **Heartbeats** (`step(0)`) are not frames. They do not change simulation state, and pending acts
  carry over to the next frame. `setInput` followed only by a heartbeat records nothing, because
  the next frame captures the input.
- **Checkpoints.** With `hashEvery: k`, the recorder appends `{tick, hash}` (strict hash,
  `includeChanges: true`) at each tick end where `tick % k === 0`.
- **Replay steps.**
  1. Optionally `restore(base)`, then `setScale(log.startScale)`.
  2. Check `baseHash` against `hashSnapshot(world.snapshot({ pendingEvents: true }), { includeChanges: true })`.
  3. For each frame: set the scale if `scale` is present; `setInput(decodeInput(input))` if
     present, or carry the previous input; emit each act via `lookupEvent(name)`, validating
     against its schema (O-39) **only when `via === 'action'`** (raw `world.emit` is never
     validated live, so validating it on replay would reject faithful logs); then
     `dt === null ? stepOnce() : step(dt)`.
  4. Compare checkpoints.

  An unknown or ambiguous event name returns `unknown_event` before any emit for that frame.
- **Preconditions** (documented; §3.1 item 7). The replay world has the same setup (systems,
  plugins, order) as the recorder's world, **no input plugin** (it would overwrite `world.input`
  at `onTickStart`), **no scale mutators in `tickStart`** (recorded scale already reflects them),
  and no enabled `once` system that the source had already run. Branch worlds are headless and
  satisfy the first two.
- **Determinism.** The same base, setup and log give the same hashes, including tick systems
  (`scaledDelta` derives from the recorded dt and scale) and own streams. (`once` systems are
  *not* covered: their run state is not snapshotted.)

**Snapshot and compat.** The act log is a new artifact with its own `format` and `version`. The
snapshot is unchanged.

**Tests (red → green).** New file `packages/domecs/test/replay.test.ts`.

1. Record 300 frames of mixed acts, `step(1/60)`, `stepOnce`, a scale change and input changes, on
   a world with tick, fixed and event systems and an own-stream rule. Replay on a fresh world
   restored from the base: equal hash at the end and at every checkpoint.
2. `encodeInput` / `decodeInput` round-trip, with sorted arrays and empty-field omission.
3. An out-of-tick `getComponent` write plus `markChanged` records a gap, and replay past it reports
   `diverged` at the next checkpoint.
4. Emits from systems are not recorded, so there is no double-emit on replay.
5. Unknown event → `unknown_event`; a schema-invalid `via: 'action'` payload →
   `rejected_payload`; the same payload recorded `via: 'emit'` replays without validation.
9. A plugin `onTickStart` that emits, and one that emits during a heartbeat: both recorded;
   replay on a world without the plugin gives equal hashes.
10. A `tickStart` hook that sets `scale = 0` at tick 50: replay reproduces the paused ticks.
6. A heartbeat between acts does not split them into an extra frame.
7. `toTick` stops at the correct tick.
8. The log is JSON-round-trippable, and replaying the parsed log gives an identical result.

**Docs:** SPEC new §7.5 "Act logs and replay"; `doc/api.md`; AGENTS.md "Durable log" and
"History vs named saves" recipes plus a new "Record and replay" recipe; `skills/domecs/SKILL.md`;
api-surface `core.d.ts`.
**Size:** M. **Studio:** none planned; studio records `RunAct`s and doc segments at its own
`LiveSession` boundary (critic C4).
**Out of scope:** recording `runSystems` calls (§6.3 calls are a gap), compression, logs
spanning a component redefinition.

---

### 7.2 `createBranch` / `runBranch` (G3; O-81) — scheduled in 2.2 (E20)

**Schedule.** 2.2, after §7.1 (it uses `ActLog`, `ReplayError` and §7.1's frame code) and before
the 2.2 release candidate (owner decision, revision 3; ED-13). Studio still forks with its
doc-aware `buildGuestWorld` + `applyDocChange` (studio spec §4.3).

**Problem and evidence**

- Systems are closures, so a world cannot be cloned.
- The only in-repo pattern restores and steps the **live** world
  (`example/plantroom/src/checkpoints.mjs:121-140`). That blocks the live session and re-fires its
  views.
- Studio's verified recipe works (build from the doc + `restore`; studio §5.3). Each consumer
  re-implements the stepping loop, sampling, cancellation and fault capture.

**API** (`@domecs/core`, new module `src/branch.ts`)

```ts
/** Registers types, systems and plugins in a fixed order; spawns nothing. May return setup output. */
export type WorldSetup<T = void> = (world: World) => T
export interface BranchOptions {
  readonly fixedStep?: number      // default from.fixedStep ?? 1/60
  readonly seed?: number | RngState  // only matters for a v2 `from` (no rngRoot)
  /** time.scale of the source; default 1. Scale is not snapshotted. */
  readonly scale?: number
}
export type BranchError =
  | { readonly kind: 'restore_failed'; readonly cause: SerializedError }
  | { readonly kind: 'once_systems'; readonly names: readonly string[] }
export function createBranch<T = void>(setup: WorldSetup<T>, from: WorldSnapshot, options?: BranchOptions): Result<{ readonly world: World; readonly setup: T }, BranchError>

export interface RunBranchOptions {
  readonly steps: number
  /** Per-step dt; null = stepOnce. Default world.time.fixedStep. Frames from `log` override. */
  readonly dt?: number | null
  /** Acts/input/dt to apply at matching ticks (frames keyed by tick). */
  readonly log?: ActLog
  readonly probes?: Readonly<Record<string, (world: World) => JsonValue>>
  readonly sampleEvery?: number          // default 1 when probes are given
  readonly keyframeEvery?: number        // snapshots for scrubbing; default none
  readonly hashEvery?: number            // default none
  readonly until?: (world: World) => boolean
  /** Polled between steps for cooperative cancellation. */
  readonly shouldStop?: () => boolean
}
export interface BranchRun {
  readonly ticks: number
  readonly stoppedBy: 'steps' | 'until' | 'cancelled'
  readonly samples: ReadonlyArray<{ readonly tick: number; readonly values: Readonly<Record<string, JsonValue>> }>
  readonly keyframes: ReadonlyArray<{ readonly tick: number; readonly snapshot: WorldSnapshot }>
  readonly hashes: ReadonlyArray<{ readonly tick: number; readonly hash: string }>
  readonly faults: readonly SystemicFault[]
  readonly finalHash: string
}
export function runBranch(world: World, options: RunBranchOptions): Result<BranchRun, ReplayError>
```

**Semantics**

- **`createBranch`** builds `createWorld({ headless: true, fixedStep, seed })`, calls
  `setup(world)`, then calls `world.restore(from)` and `setScale(options.scale ?? 1)`. A throw
  from `setup` is a bug and propagates. A throw from `restore` returns `restore_failed`. If
  setup registered an enabled `once` system and `from.tick > 0`, it returns `once_systems`
  (the branch would re-run it while the source did not; §3.1 item 7). `from` must be taken with
  `pendingEvents: true` and without snapshot-rewriting plugins (documented).
- **Contract** (SPEC §7.1, `doc/SPEC.md:667`). `setup` registers the same systems in the same
  order as the source world, and with §4.3 stable rules the order is a function of the doc.
  Neither function can verify this. It is documented, and studio tests it (§4.3 test 4).
- **`runBranch`** steps the world it is given. It can be called again to **extend** a branch
  incrementally from where it stopped (critic fact 10). Log frames are applied with §7.1's frame
  code. Probes are called after every `sampleEvery`-th step **counted from the call's start**
  (not absolute ticks) and **always after the final step**, whatever `stoppedBy` is, so the
  horizon value is always sampled.
  - Faults are collected from `signals.faultRaised` for the duration of the call.
  - The call is synchronous. A host runs it in a worker and cancels through
    `shouldStop`.
- **Probes must be read-only.** §5.3 world expressions are. A probe that mutates the world breaks
  determinism. This is documented, and a dev-mode check compares strict hashes before and after
  a probe at the first sample.
- **Determinism.** These are equal for the same `(setup, from, options)`: `finalHash`, `hashes`
  and samples. All hashes are strict (`includeChanges: true`).

**Tests (red → green).** New file `packages/domecs/test/branch.test.ts`.

1. Branch vs live: the live world steps 120 ticks; a branch from its tick-30 snapshot steps 90.
   Equal final hash.
2. Two branches from one snapshot are identical. A branch whose setup differs by one own-stream
   rule leaves the other rules' sampled values unchanged.
3. Extension: `runBranch(60)` + `runBranch(60)` equals `runBranch(120)`.
4. `until` and `shouldStop` give the right `stoppedBy` and tick, and the final tick is sampled
   in each case; `sampleEvery: 7` from a base at tick 30 samples ticks 37, 44, …, and the last.
7. A setup with an enabled `once` system and `from.tick > 0` returns `once_systems`.
8. A source at `scale = 2`: `createBranch(…, { scale: 2 })` matches it; the default does not.
5. A log with acts applied at ticks equals a live world receiving the same acts.
6. Faults are captured. A restore failure is `restore_failed`, with no throw.

**Docs:** SPEC §7.5 (with replay); `doc/api.md`; AGENTS.md recipe "Branch and compare" (replaces
the plantroom pattern for headless use); api-surface `core.d.ts`.
**Size:** S. **Studio:** none planned (studio forks are doc-aware: arm B needs
`transformSnapshot` and entity reconcile, which a generic setup cannot express).
**Out of scope:** worker hosting (O-10), parallel scheduling, snapshot diff compaction.

---

### 7.3 `instantiateScene` / `unloadScene` (G14; O-13) — scheduled in 2.3 (E21)

**Schedule.** 2.3, after §6.4 and before the 2.3 release candidate (owner decision, revision 3;
ED-13). Studio's catalog still instantiates levels with its own `Origin {type, scene, sid}` keys
and a `studio.GotoScene` command.

**Problem and evidence**

- The engine has no notion of a scene. Studio's `scenes[]` is studio-only (studio
  `src/project.ts:30-50`) and only `scenes[0]` ever loads.
- No helper remaps authored ids, including `Parent.entity` and other entity-ref fields, to live
  ids.
- O-13 is open (`plan/FINDINGS.md:108`).
- Levels and screens (critic Q6) need "goto level" as a typed command.

**API** (`@domecs/scene`)

```ts
export const SceneMember: ComponentType<{ scene: string; key: string }>   // schema'd, persistent
export interface SceneEntityData {
  readonly key: string
  readonly components: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly parent?: string | null          // a key within the same scene
}
export interface SceneData { readonly name: string; readonly entities: readonly SceneEntityData[] }
export interface SceneProblem { readonly path: string; readonly message: string }
export interface InstantiateSceneOptions {
  readonly resolve: (name: string) => ComponentType<any> | undefined
  /** Fields holding scene keys that must become live entity ids, e.g. [['Target','entity']]. */
  readonly refFields?: ReadonlyArray<readonly [component: string, field: string]>
}
export function instantiateScene(world: World, data: SceneData, options: InstantiateSceneOptions): { readonly ids: ReadonlyMap<string, Entity>; readonly problems: readonly SceneProblem[] }
export function unloadScene(world: World, name: string): number          // despawnTree over member roots
export function sceneEntities(world: World, name: string): Entity[]      // ascending id
```

**Semantics**

- **Instantiation order:**
  1. Spawn in array order, so ids are deterministic. Each spawn gets components (defaults plus
     the given fields, built with the component's `create`) and `SceneMember{scene, key}`.
  2. Run `setParent` by key. Cycles and missing keys are problems, not throws (the studio
     `catalog.reload` precedent).
  3. Remap `refFields`: a string key becomes the live id; an unknown key is a problem and the field
     is left unchanged.
- **Problems are reported, never dropped.** An unknown component name is a problem; the component
  is skipped and the entity still spawns. A duplicate key is a problem, and the second entity
  still spawns with its key suffixed `#2`.
- **`unloadScene`** despawns the subtrees of member roots. `SceneMember` and `Parent` are ordinary
  components, so scenes survive snapshots and replay.
- **Determinism.** Fully ordered by the data array.

**Tests:**

1. Ids are deterministic.
2. Parent remap; cycle reported.
3. `refFields` remap.
4. Unknown component reported and the entity still spawns.
5. Unload removes exactly the scene's trees.
6. Instantiate, then snapshot, then restore into a fresh world: equal hash.
7. A "goto level" event rule (§6.1) plus a host call (no rule effect is needed in 2.3).

**Docs:** scene README "Scenes"; `doc/api.md`; SPEC §7 note (O-13 partly closed: the unknown-type
surfacing part); api-surface `scene.d.ts`.
**Size:** M. **Studio:** none planned (catalog + `Origin`).
**Out of scope:** a scene codec registry for unknown types (the rest of O-13), streaming or
partial loads, a `loadScene` rule effect.

---

### 7.4 `redefineComponent` (G11; O-87) — conditional (unchanged)

**Gate (ED-12).** Build this only if studio reports that rebuild-and-restore on a shape edit is too
slow at target scale (> 50 ms at 1000 entities; measured at about 12 ms today, engine §5), or
breaks something rebuild cannot fix. Until then the ledger row stays open as fuel.

**Problem and evidence.**

- A second `ComponentType` under an existing name throws
  (`world.ts:900-903`, "two distinct ComponentType objects share the name").
- `registerComponentTypes` always defines fresh objects
  (`packages/domecs-persist/src/schema.ts:100-140`).
- Studio keeps stale schemas (`doc/FINDINGS_studio.md`, first entry).

**API** (`@domecs/core`)

```ts
export interface RedefineError { readonly kind: 'unknown_component'; readonly name: string }
interface World {
  redefineComponent(next: ComponentType<unknown>, options?: {
    /** Map an old value to the new shape. Default: new defaults + old values of fields the new type declares. */
    readonly migrate?: (old: Readonly<Record<string, unknown>>) => unknown
  }): Result<{ readonly entities: number; readonly droppedFields: readonly string[] }, RedefineError>
}
```

**Semantics**

- **Registry swap.** The registry entry for `next.name` is replaced. The old object becomes an
  **alias**: `storeFor(old)` resolves to the same store instead of throwing, so stale handles keep
  working against the new schema.
- **Value migration.** Stored values are migrated in ascending id. Each entity is marked changed,
  and `OnChanged` fires. The default migration fills missing fields from the new defaults and drops
  fields the new type does not declare (the declared set is its schema fields ∪ default keys). It
  reports `droppedFields`: the shape edit is the user's own change, and it is reported, not silent.
- **What does not change.** Archetypes and queries are name-keyed, so they are unaffected.
  Snapshots are name-keyed, so the format is unchanged.

**Tests:**

1. Add a field: entities gain the default.
2. Remove a field: it is dropped and reported.
3. An old handle still reads and writes.
4. A custom migrate.
5. A rules recompile picks up the new shape.
6. Hash equals a fresh world built with the new type and the migrated snapshot.

**Size:** M. **Studio:** live shape edits without a rebuild, if the gate is met.
**Out of scope:** renaming a component (that is a doc migration).

---

## 8. Release plan and mechanics

**Order within each release.** One PR per item, in the order listed:

- **2.1:** §4.1 + build identity → §4.2 → §4.3 → §4.4 → §4.5 → §4.6 → §4.7. §4.1 ships first
  together with `BUILD_ID` and `pack-for-studio` because studio's first headless slice (studio
  plan H0) consumes the hash from an early tarball. §4.4 depends on §4.1 for its tests; §4.7
  depends on §4.5 (`lookupEvent`) and §4.4 (v3 envelope). §4.3 is independent; §4.2 can run in
  parallel.
- **2.2:** §5.1 → §5.2 (with the `dmath` 2.2 functions) → §5.3 → §5.4 → §7.1 → §7.2. §5.2 needs
  §5.1's grid; §7.2 needs §7.1's `ActLog`, frame code and `ReplayError` (revision 3).
- **2.3:** §6.1 → §6.2 → §6.3 → §6.4 → §7.3. §6.2 needs §6.1's event rules for its integration
  test, and so does §7.3's "goto level" test (revision 3).
- **Conditional (§7.4):** only when gated in.

**Per-release gates.**

- Each PR passes the full suite and every §1 gate.
- The release candidate also passes:
  - `pnpm bench` (no regression beyond noise on soak, telemetry or windowed);
  - `pnpm test:plantroom` and `pnpm test:legibility`;
  - `pnpm cold-install` (packed tarballs);
  - the §3.4 golden under Node, plus under electron-as-node (opt-in here, mandatory in studio).

**Build identity (ED-15).** Every package gains a `BUILD_ID: string` export from
`src/build-id.ts` (source value `'dev'`). `scripts/pack-for-studio.mjs` rewrites the built
`dist/build-id.js` before packing. A published build carries the plain version. `BUILD_ID` is a
new export in every package's api-surface file.

**Getting builds to studio (OD-9, ED-15).** One script, owned by the engine, used by studio's
`npm run engine:refresh` (feasibility review 15):

1. The release branch bumps all seven packages to the target minor (lockstep; they share a major
   per AGENTS.md).
2. `node scripts/pack-for-studio.mjs --out ../studio/vendor/domecs` runs `pnpm -r build`, stamps
   `BUILD_ID = '<version>+g<sha>[-dirty]'`, sets each packed `package.json` `version` to the same
   string (build metadata, so `^2.0.0` peer ranges still resolve), and runs `pnpm pack` per
   package (which rewrites `workspace:^`). Tarball names include the sha
   (`domecs-core-2.1.0+g1a2b3c4.tgz`), so a changed engine is a changed dependency spec.
3. It writes `vendor/domecs/manifest.json`:
   `{ version, gitSha, dirty, packedAt, packages: { "@domecs/core": { file, integrity, buildId }, … } }`,
   plus `golden: { file, integrity }` for the copied §3.4 script (2.1 RC).
4. Studio's `engine:refresh` rewrites its `@domecs/*` specs to
   `file:../../vendor/domecs/<file>` (paths relative to each workspace package) and runs
   `npm install`, so the lockfile always matches the tarballs and `npm ci` never fails with
   `EINTEGRITY`. `vendor/` is gitignored in studio; the manifest's `gitSha` is what studio stamps.
5. **Publish** (`pnpm publish:npm`) **only after explicit owner approval**, with the plain version
   numbers (no build metadata). If any byte changed after the last tarball, re-pack and re-verify
   studio first. Studio then switches back to `^2.N.0` registry ranges at its milestone.

**Release notes.** Each `doc/release-notes/v2.N.0.md` (next to `v2.0.0.md`) lists:

- highlights;
- **behaviour changes**:
  - 2.1: the ≤ 1 ulp `sin`/`cos` change, `SNAPSHOT_VERSION` 3 written by every snapshot (2.0
    engines reject 2.1 saves; 2.1 still loads 2.0 saves), the `diffSnapshots` key-order fix
    (if G9 ships), canonical JSON keeping `-0`;
  - 2.2: reserved words;
- **type-level changes**:
  - 2.2: `FunctionName` widens (exhaustive switches need a default branch);
- upgrade steps, following the v2.0.0 notes' structure.
---

## 9. Test strategy summary

| Layer | What | Where |
|---|---|---|
| Unit | Each item's red/green list above | `packages/*/test/*.test.ts` (vitest; `tsc --noEmit` first, per package `test` script) |
| Fork equivalence | Live world vs fresh build + restore (`pendingEvents: true`), with tick and fixed rules, compose at 100, own streams, spawns, `-0` values and (2.3) events in flight: equal **strict** hashes (`includeChanges: true`) over ≥ 120 ticks after edits | `packages/domecs-rules/test/fork-equivalence.test.ts` (new in 2.1; extended every release) |
| Golden | Algorithm pins: hash fixture, `deriveStream`, dmath vectors, determinism scenario | `test/golden/*.json`, `pnpm test:golden` |
| Dual runtime | The §3.4 script spawned under `DOMECS_ALT_RUNTIME` (electron-as-node) | Engine (opt-in env) + studio (mandatory, same spawn-and-compare test) |
| Bench | Cost targets for hash, spatial, cross-entity rules, contacts (informational) | `bench/` workloads `rules`, `spatial` |
| Doc | `ts doctest` fences for every new API in `doc/api.md` | `pnpm doctest:check` |
| Surface | Regenerated `.d.ts` snapshot | `pnpm api:check` |

No test makes network or paid API calls (OD-11). Everything is headless.

---

## 10. Out of scope (this spec)

- **Studio-side work:** MCP and HTTP servers, the tool generator, JSON Schema export, paged
  observation, providers, the forecast scheduler, lane storage, the sentence renderer, doc v2.
- **Worker hosting** (O-10, PLAN stop-doing).
- **Excluded engine features:**
  - async or chunked snapshots (O-9);
  - history diff compaction (rest of O-31);
  - secondary and range indexes (O-7 beyond spatial);
  - multi-world `EntityRef` (O-12: studio labels worlds).
- **Excluded rules features:**
  - multi-component sets;
  - predicates in aggregates;
  - writes to other entities;
  - resource reads;
  - per-entity RNG;
  - gamepad input;
  - a JS escape hatch in rules.
- **Excluded spatial features:** occupancy layers (rest of O-8), physics response, non-circle
  colliders.
- **Default flips** (`order: 'stable'`, `rng: 'own'`, `snapshot({ pendingEvents: true })`).
  These are 3.0 candidates, decided after studio dogfooding.
- **`dmath` beyond the six functions listed** (`sin`, `cos`, `sqrt`; `atan2`, `hypot`, `pow`).
- **Persist `save()` switching to `canonicalJson`** (keeps `-0`; §3.2 note). Follow-up.
- **O-29 save size** (dropped in revision 2: a type break inside a minor; studio measures bytes
  itself).
- **The remaining conditional item** (§7.4 `redefineComponent`) until gated in.

---

## 11. Risks and open questions

1. **`dmath` port fidelity.** A transcription slip would be silently consistent across runtimes,
   because the golden pins whatever the port computes. Mitigation: the ≤ 1 ulp accuracy test
   against `Math.*` over 100k inputs per function, plus special-value tables from C99 Annex F.
2. **SNAPSHOT_VERSION 3 in a minor** strands 2.0 readers of new saves. This is accepted (ED-2),
   because the only consumers are in-house. **Decided (revision 3):** the owner chose "always v3
   in 2.1"; the no-bump alternative is closed.
3. **Rule cost growth.** Cross-entity rules can be O(n²) if they are written without spatial forms
   or memoization (for example, `sum` over a set whose field the rule also writes). Mitigation:
   the cost model in the rules README, plus a dev-mode warning. Studio surfaces the per-rule run
   time from bench-style timing.
4. **Reserved words** break any component literally named `self`, `other`, `event`, `pointer` or
   `tick` in expressions. A grep of known projects (studio's std components) finds none. This is
   release-noted.
5. **Direct writes break reproducibility.** Studio routes every runtime perturbation through
   std command acts (critic C6, Q4). From 2.2, §7.1's recorder makes violations visible as
   gaps for engine users who record.
6. **Pending-event restore needs known types.** A world restoring a snapshot with events in
   flight throws if a pending event's type is neither registered nor subscribed. Mitigation:
   `register` in setup (documented in §4.7 and AGENTS.md); studio registers std and project
   events in `buildGuestWorld`.
7. **`-0` through persist.** Forks from persist saves can differ from live where `-0` occurred
   (§3.2). Mitigation: studio keyframes use `canonicalJson`; the persist switch is a follow-up.
8. **Open question for the owner:** should the rules language spec move into SPEC (§2.13), or stay
   in the rules README as today? The default is a SPEC appendix, so that it is normative.

---

## Appendix A — gap → ledger → release map

| Survey gap | Item | Ledger | Release | Status before this spec |
|---|---|---|---|---|
| G5 canonical hash | §4.1 | O-11 | 2.1 (first) | open (`FINDINGS.md:106`) |
| G9 field diff | §4.1 | O-31 (diff half) | 2.1, optional (may slip to 2.2) | open (`:120`) |
| G19 deterministic math (critic §0.2, studio "DMATH") | §4.2, §5.2 | **O-75** (new) | 2.1 (`sin`/`cos`/`sqrt`), 2.2 (`atan2`/`hypot`/`pow`) | SPEC §8 caveat only |
| G20 rule ordering (critic §0.1, studio "ORDER") | §4.3 | **O-76** (new) | 2.1 | O-69 documented defs order only |
| G6 RNG streams | §4.4 | **O-77** (new) | 2.1 | — |
| G10 registry/lookup | §4.5 | O-30 + **O-78** (new) | 2.1 | O-30 open (`:119`) |
| G12 RuleError.field | §4.6 | **O-79** (new) | 2.1 | FINDINGS_studio entry 3 |
| G21 pending events in snapshots (determinism review, studio "PEND") | §4.7 | **O-90** (new) | 2.1 | SPEC §7.1 caveat only |
| G2 spatial | §5.1 | O-8 (+ O-7 partial) | 2.2 | open (`:103`) |
| G1 cross-entity rules | §5.2 | **O-82** (new) | 2.2 | — |
| G13 world expressions | §5.3 | **O-83** (new) | 2.2 | — |
| G16 input in rules | §5.4 | **O-86** (new) | 2.2 (moved from 2.3) | — |
| G8 effects/event rules | §6.1 | **O-84** (new) | 2.3 | — |
| G7 contacts | §6.2 | **O-85** (new) | 2.3 | — |
| G15 runSystems/render | §6.3 | **O-88** (new) | 2.3 | FINDINGS_studio entries 2, 4 |
| G18 transient resources | §6.4 | O-36 | 2.3 | open (`:125`) |
| G18 bridge reset | §6.4 | **O-89** (new) | 2.3 | — |
| G4 act log/replay | §7.1 | **O-80** (new) | 2.2 (scheduled in revision 3; was conditional) | — |
| G3 branch | §7.2 | **O-81** (new) | 2.2 (scheduled in revision 3; was conditional) | — |
| G14 scenes | §7.3 | O-13 (partial) | 2.3 (scheduled in revision 3; was conditional) | open (`:108`) |
| G11 redefine component | §7.4 | **O-87** (new) | conditional | FINDINGS_studio entry 1 |
| G17 save size | — | O-29 | dropped (Appendix C) | open (`:118`) |
| G17 timeline storage | — | O-31, O-9 | studio (keyframes + act log) | — |
| G18 multi-world refs | — | O-12 | studio labels | — |
## Appendix B — evidence index (file:line, at `b425242`)

- **Rules:**
  - `packages/domecs-rules/src/rules.ts`: 13-17 `RuleActionDef`; 19-31 `RuleDef`; 33-40
    `RuleError`; 102-216 `compileRule`; 225-239 `checkWrite`; 242-374 `registerRuleSystem`
    (291 `random` → `ctx.rand`; 292-312 `resolveField`); 406-449 `update` (424-437 remove +
    re-register).
  - `packages/domecs-rules/src/ast.ts`: 11-33 function whitelist; 35-47 `AstNode`; 55-88
    `walkFieldRefs`.
  - `packages/domecs-rules/src/parser.ts`: 5-27 grammar; 212-236 `Component.field`; 246-272 calls.
  - `packages/domecs-rules/src/lexer.ts`: 26-27 punctuation.
  - `packages/domecs-rules/src/evaluator.ts`: 8-23 `EvalEnv`; 179, 181, 268, 269 `Math.sin/cos`.
  - `packages/domecs-rules/src/typecheck.ts`: 4 `StaticKind`.
- **Core:**
  - `packages/domecs/src/scheduler.ts`: 15-27 `SystemDefBase`; 176-178 comparator; 267-282
    registration id.
  - `packages/domecs/src/world.ts`: 481 single `rand`; 541 `typeRegistry`; 892-906 `storeFor`
    (900-903 name clash); 1054-1063 system ctx (`rand`); 1163-1185 heartbeat; 1730-1777
    `describe`; 1870-1878 `system`; 1919-1975 `action`; 1999-2025 `restore`.
  - `packages/domecs/src/world-state.ts`: 96-133 `buildSnapshot` (102 archetype key order; 125
    seed); 172 rewind; 299-345 `validateEnvelope`.
  - `packages/domecs/src/snapshot.ts`: 7 `SNAPSHOT_VERSION = 2`; 21-75 `WorldSnapshot`.
  - `packages/domecs/src/rng.ts`: 34 `seedToState`; 64-108 `createRng`; 91-104 `fork`; 118
    `rewindRng`.
  - `packages/domecs/src/events.ts`: 31-37 `defineEvent`; 57-92 payload validation; 141
    `knownTypes`.
  - `packages/domecs/src/manifest.ts`: 32-36 systems entry.
  - `packages/domecs/src/input.ts`: 40-55 `InputSnapshot` (Sets).
  - `packages/domecs/src/agent.ts`: 60, 117 `act(EventType)`.
- **Persist and scene:**
  - `packages/domecs-persist/src/history.ts`: 175-209 `diffSnapshots`.
  - `packages/domecs-persist/src/migrate.ts`: 25-27 built-ins.
  - `packages/domecs-persist/src/schema.ts`: 26-36 `ComponentFieldData`; 100-140
    `registerComponentTypes`.
  - `packages/domecs-scene/src/compose-transforms.ts`: 4-13 `priority` option.
- **Docs:**
  - `doc/SPEC.md`: 374 equal-priority order; 667 restore registration contract; 747-757
    determinism and transcendentals; 287 PRNG.
  - `plan/FINDINGS.md`: 102-125 open O-items; 158 O-69.
  - `doc/FINDINGS_studio.md`: entries 1–4.
- **Probes** (scratchpad `harness/`): `critic/order2.mjs`; `probe/rng.mjs`; `probe/bench.mjs`;
  platform `det/sim.mjs` (survey-platform §6).

---

## Appendix C — review dispositions

Revision 2 applied every blocker and major item of the three 2026-10-18 reviews (determinism,
product, feasibility) and most minors. Items listed here were **rejected or modified**; anything
not listed was applied as the review proposed. (Product-review items are studio-only; see the
studio spec's dispositions.)

| Review item | Disposition | Reason |
|---|---|---|
| Determinism 1: add `pendingEvents` to the v3 envelope | **Modified:** opt-in `snapshot({ pendingEvents: true })` (ED-16), plus `World.pendingEvents()` | Always recording would make `snapshot()` start throwing for existing apps whose in-flight payloads are not plain data, a break inside 2.x. Studio and every fork opt in, so the guarantee holds where it matters |
| Determinism 6: `canonicalSnapshot` "returns an error" for non-finite numbers | **Modified:** throws `TypeError` with the path | Consistent with BigInt and cycles (plain data by contract; AGENTS rule 7 allows throws by contract); a `Result` on every hash call would burden the hot path. Studio rejects non-finite writes, so it never reaches the throw |
| Determinism 8: alternative "v3 `onceRan`" | **Not taken;** `createBranch` returns `once_systems` instead | The alternative needs a snapshot field and an AGENTS "boot once" recipe rewrite |
| Determinism 12: `settings.engine.ruleOrder` and `bands` | **Partly rejected** (studio keeps only `settings.engine.rng`) | Studio uses the §4.3 bands from its first commit and never calls `update()`, so `'registration'` and `'stable'` give identical order there (asserted by a studio test). Only RNG mode changes outcomes |
| Feasibility 13: move §4.5 (G10) to 2.3 | **Rejected** | §4.7 restore resolves pending events through `lookupEvent`, and studio `register`s its std events from 2.1 |
| Feasibility 13: make the act log, branch and scenes items conditional; drop O-29 | **Applied** (now §7.1–§7.3; O-29 dropped) | O-29 was a type break inside a minor and studio measures bytes itself |
| Feasibility 13: field-diff half of §4.1 optional | **Applied** (may slip to 2.2) | Studio's v1 uses doc-op diffs on cards; the snapshot `diff` MCP tool is v1.1 |
| Feasibility 5(c) / product 6: rebuild throttle 20 Hz vs 10 Hz | **10 Hz** (studio) | The stricter number protects main's shared core on 2 CPUs |
| Determinism 9, 18, 20; feasibility 12 | **Applied** to the now-conditional §7.1/§7.2 and to §4.2 | Kept so the conditional specs are correct when gated in |

### Owner decisions — revision 3 (2026-10-19)

| Decision | Applied in | Notes |
|---|---|---|
| **Snapshot format: always v3 in 2.1.** Per-system RNG streams ship in 2.1 and `SNAPSHOT_VERSION` is 3 for every snapshot, not only when streams are used; persist migrates 2 → 3; v2 snapshots still load | ED-2, §3.2, §4.4 ("Always v3 in 2.1", test 4), §8 release notes, §11 risk 2; plan E4 | Unblocks E4, which E5 and E7 recorded as on hold. E7's `pendingEvents` (shipped on the v2 envelope) becomes a v3 optional field unchanged. The manifest `rng` field that E5 deferred lands with E4 (plan E4.1) |
| **Schedule G3, G4 and G14.** No longer conditional | §0, ED-13, §7 (table, schedule lines), §8 order, §10, Appendix A; plan E19–E21 and the E13/E18 gates | G4 → E19 and G3 → E20 in 2.2 before the RC (E13); G14 → E21 in 2.3 before the RC (E18). G11 (`redefineComponent`, EC4) stays conditional |
| Studio defaults new projects to `settings.engine.rng = 'own'`, migrated v1 projects to `'shared'` | §4.4 "Studio" line (already stated) | Engine default stays `'shared'` (ED-4) |
| Spec and plan are committed under `doc/harness/` | Header, plan header, `doc/harness/README.md` | `plan/*` is gitignored, so the files were moved rather than `git mv`ed; `doc/README.md`, `plan/FINDINGS.md` and the three studio docs point at the new paths (AGENTS.md and `plan/PLAN.md` had no references) |

Choices made in the revision-3 docs pass where the decisions were silent (owner may override):

| Item | Choice | Reason |
|---|---|---|
| `rngRoot` under "always v3" | Written by every 2.1 snapshot; `rngStreams` omitted while no own stream was ever created | A uniform v3 envelope; a fork that adds the first own-stream rule (A/B arm B) must derive it from the source's root, which it can only do if the source snapshot carries it. Omitting an empty `rngStreams` follows the `resources`/`changes`/`pendingEvents` convention and restores identically |
| Section numbers of §7.1–§7.3 | Kept (headings say "scheduled in 2.x (E19/E20/E21)") rather than moving the text into §5/§6 | The studio spec and plan cite §7.1–§7.3; renumbering would silently break those references |
| Milestone ids | E19 (G4), E20 (G3) in 2.2; E21 (G14) in 2.3; E13 and E18 keep their ids as the RCs | Appending ids keeps every existing E-reference (commits, ledger rows, studio plan) valid; plan order, not id order, gives the sequence |
| "own-stream rule" in §7.1 test 1 and §7.2 test 2 | A core system with `rng: 'own'` in the core test files; a rules leg in the 2.2 fork-equivalence suite | Core tests cannot depend on `@domecs/rules` (E1 implementation note) |

### Implementation notes — E1 (2026-10-18)

Minimal sound choices made while implementing E1 where the spec was silent or unattainable:

| Item | Choice | Reason |
|---|---|---|
| §4.1 hash cost target (≤ 2 ms, 1000 entities) | **Missed on this host, recorded informational**: ~4.5 ms p50 for a 168 KB snapshot (strict hash) on the 2-vCPU x86-64 VM; `JSON.stringify` of the same snapshot is ~1.0 ms here. Split ≈ 3 ms canonical walk (a third of it `Number::toString`) + ≈ 1 ms FNV loop. Numbers in `bench/README.md` | The target asks for canonical walk + hash within 2× native serialization; the plan marks it informational. Re-measure on the reference host |
| §4.1 `canonicalJson` edge cases | A top-level `undefined`/function/symbol throws `TypeError` (no JSON text; the signature returns `string`). `toJSON` is honoured on class instances only; plain objects and arrays are walked as data (hot-path speed; plain data never carries a function-valued `toJSON`) | Spec says "JSON.stringify value semantics" but `JSON.stringify(undefined)` returns `undefined`, not a string |
| §4.1 test 3 "a rule computes `1 / Body.vx`" | Written as a core `fixed` system in `canonical-hash.test.ts` | Core tests cannot depend on `@domecs/rules`; the rules variant belongs in the E8.2 fork-equivalence suite |
| §4.1 `canonicalSnapshot` scope | Deny-list: every top-level field except `version`, `meta`, `changes` | Forward-compatible with v3's `rngRoot`/`rngStreams`/`pendingEvents` without touching the hash again |
| §8 manifest shape | `version` is the plain release version (`2.1.0`); a top-level `buildId` (`2.1.0+g<sha7>[-dirty]`) was added; `gitSha` is the full 40-char sha | The spec lists `{ version, gitSha, dirty, packedAt, packages }` without saying which version string `version` is |
| §8 `workspace:^` rewrite | The script rewrites `workspace:^` → `^<plain version>` itself before `pnpm pack` | Left to pnpm, the rewrite would use the stamped version (`^2.1.0+g…`); the plain range is what `pnpm publish` ships |
| §8 dirty flag | Untracked (non-ignored) files count as dirty | An uncommitted new source file changes the build |
| §8 sha length | `<sha7>` = first 7 hex chars of `HEAD` | Stable length; `git rev-parse --short` may lengthen it |
| E1.8 (G9 field diff, optional) | **Shipped in E1.** `components` restricts `fieldChanges` and `componentsAdded`/`componentsRemoved` (entity-level lists stay complete); `limit` counts field and resource changes together; `firstDivergence` checks state keys in the order the `Divergence` union lists them, with `fixedStep` compared alongside `fixedBacklog`; a component or resource on one side only is a change at path `""`; `epsilon`/`limit` outside their domain throw `RangeError` | Spec left these unspecified |

### Verification notes — E1 (2026-10-18, adversarial pass)

| Item | Finding | Disposition |
|---|---|---|
| `canonicalJson` `toJSON` | A `toJSON` returning `this` (or another `toJSON`-bearing instance) recursed to a stack overflow; `JSON.stringify` applies `toJSON` once per value | **Fixed** (`fix(E1): canonicalJson applies toJSON once per value`) |
| `diffSnapshots` `limit` | `limit: Infinity` threw `RangeError` | **Fixed**: `Infinity` = no limit (`fix(E1): diffSnapshots accepts limit: Infinity`) |
| api.md doctests | Mutated components without `markChanged` (AGENTS rule 1) | **Fixed** |
| `firstDivergence` vs `hashSnapshot` | `firstDivergence` compares only the listed state keys, entities and resources; `hashSnapshot` covers every top-level field. When E7 adds `pendingEvents`, two snapshots differing only there hash differently but `firstDivergence` returns `null` | **Open for E7**: extend the `Divergence` `state` key union with `'pendingEvents'` (type-level widening) when §4.7 ships |
| Hash cost | Re-measured 4.7 ms p50 (target 2 ms, informational). A `TextEncoder.encodeInto` byte loop saves only ~0.5 ms (rope flattening dominates), so not taken | Informational; re-measure on the reference host |
| `pack-for-studio` interruption | A SIGINT while a package is stamped kills Node before the `finally` restore runs, leaving that `package.json`/`dist/build-id.js` stamped | Minor, not fixed: `git checkout packages/*/package.json` recovers; stamp window is one `pnpm pack` |

### Implementation notes — E2 (2026-10-18)

| Item | Choice | Reason |
|---|---|---|
| §4.2 test 1 golden "bit patterns" for NaN outputs | A NaN output (sin/cos of ±∞ or NaN) is stored as `"nan"` and checked with `Number.isNaN`; every other output is a 16-digit hex bit pattern | `x - x` for ±∞ yields the hardware default NaN, whose sign differs by CPU (x86 `0xfff8…`, ARM `0x7ff8…`) and engines may canonicalize NaN; no caller can observe it without bit-casting |
| §4.2 constants | Every polynomial / π/2 constant is built from its hex words (`fromWords(hi, lo)`), not the C decimal literal | The musl literals have 21 significant digits; ECMA-262 §12.9.3 lets an engine round a literal past the 20th digit either way |
| §4.2 golden location | `test/golden/dmath-vectors.json` at the repo root (first file in `test/golden/`, which E8's `pnpm test:golden` will share) | As the spec names it |
| §4.2 port fidelity (risk §11.1) | Beyond the ≤ 1 ulp test, the port was compared bit for bit with musl's own C (`sin.c`, `cos.c`, kernels, `__rem_pio2*`, `scalbn`) compiled with `gcc -O2 -ffp-contract=off` on aarch64 (no FMA in the binary): 0 mismatches over 2M inputs (random bit patterns incl. huge/subnormal/NaN, near-multiples of π/2) and over all 3000 golden vectors | Rules out a transcription slip the golden would otherwise pin silently. One-off check, not committed (needs a C toolchain) |
| §4.2 test 4 (dual-runtime `dmathFingerprint`) | Deferred to E8 | It is a field of the §3.4 `determinism-golden.mjs` output, which E8 builds |
| §4.2 test 5 (bench) | `bench/run.mjs --workload dmath`: ~1.2× `Math.*` for sin and cos on the 2-vCPU arm64 host | Informational target ≤ 3× met |
| §4.2 test 3 | Also covers `cos`, the interpreted `evaluate` path and `compileExpression`, with six inputs where V8 13.6 `Math.sin`/`cos` differ from musl by 1 ulp | The red step must fail on this runtime; the known-differing inputs guarantee it |
| E2 verify pass: golden coverage (risk §11.1) | Mutation testing found four non-equivalent slips no test caught (disable `__rem_pio2_large` recomputation: up to 2e8 ulp wrong; drop the q0 = 2 mask: up to 2^63 ulp; 3rd medium round; final z ≥ 2^24 split: 1 ulp each). `scripts/dmath-golden.mjs` section 5 appends 8 inputs + negations (3016 vectors; sections 1–4 unchanged), outputs checked against musl; `dmath.test.ts` checks them ≤ 1 ulp and present in the golden. Remaining survivors are equivalent (unused `PIO2[5..7]` / tail `IPIO2` words, directed-rounding fixups) or change no output over 1M+ candidates | The golden is only as strong as the branches it reaches. Fixed in `fix(E2): pin rare argument-reduction branches…` |
| E2 verify pass: bench | `runDmath` returned no `p95Ms`, so `bench/run.mjs --workload dmath` (and `all`) crashed in the summary print after the JSON | Fixed in `fix(E2): dmath bench workload…`; row now has `p50Ms`/`p95Ms` and the summary prints the ratios |

### Implementation notes — E3 (2026-10-18)

| Item | Choice | Reason |
|---|---|---|
| §4.3 index of a def that fails to compile | It keeps its index in the de-duplicated defs; only a repeated name takes none | "index in the de-duplicated defs"; fixing a broken rule then does not shift the rules after it |
| §4.3 option validation | An unknown `order` mode, or an `orderBase` that is not a finite number, throws at `installRules` | Matches `world.system()` throwing on a non-finite `order` |
| §4.3 doctest harness | `scripts/doctest.mjs` maps `@domecs/rules` | The api.md `rules-stable-order` doctest imports it |
| §4.3 test 4 compose stand-in | A plain priority-100 system stands in for `composeTransforms` | Avoids a `@domecs/rules` dev dependency on `@domecs/scene` |

### Verification notes — E3 (2026-10-18, adversarial pass)

| Item | Finding | Disposition |
|---|---|---|
| `orderBase` magnitude | The spec only says "first order key". With `orderBase` near or above 2^53 (e.g. `Number.MAX_SAFE_INTEGER` as "run last"), `orderBase + i` is not exact: `MAX_SAFE_INTEGER + 1 === MAX_SAFE_INTEGER + 2`, so two stable rules share a key and tie-break by registration index again, silently reopening O-76 | **Fixed** (`fix(E3): bound installRules orderBase…`): `installRules` also throws when \|orderBase\| > 2^51, which keeps every key below 2^52 (double spacing ≤ 0.5), so consecutive keys are distinct and increasing. api.md, rules README and the JSDoc state the bound |
| §4.3 tests 1–4 | Present and non-vacuous: core `scheduler-order.test.ts` (13), rules `ordering.test.ts` (critic probe both modes, reorder, insert at defs index, `orderBase + i` incl. duplicate/compile-error slots, fork contract with a `'registration'` control that diverges) | No change |

### Implementation notes — E5 (2026-10-19)

E4 (per-system RNG streams, snapshot v3) is on hold pending an owner decision; E5 shipped without it.

| Item | Choice | Reason |
|---|---|---|
| §4.5 manifest `rng: 'shared' \| 'own'` | **Not shipped**; deferred to E4 (**shipped in E4.1**, see E4 notes) | The field reports E4's per-system stream mode, which does not exist yet. A field fixed at `'shared'` would freeze an API shape before the owner decides E4; adding it later is additive. Everything else in the systems entry (`priority`, `order`, `components`, `meta`) shipped |
| §4.5 `components` source | All component leaves of `query` and `reactsTo` (`Has`, `Where`, `OnAdded`, `OnRemoved`, `OnChanged`), `Not` branches included, resource leaves skipped; sorted, de-duplicated; computed once at registration | The spec names `collectHasComponents`, but that helper skips `Not` branches and every non-`Has` leaf, so a `reactsTo: OnChanged(Vel)` system would list nothing. "Names referenced by query/reactsTo" is the stated contract; a private walker in `scheduler.ts` implements it |
| §4.5 `register` signature | Resources are taken as `ResourceType<never>` | `ResourceType<T>`'s brand is contravariant in `T`, so `ResourceType<number>` is not assignable to the spec's `ResourceType<unknown>`; `never` accepts every `T` without `any` |
| §4.5 `register` atomicity | All-or-nothing: every argument is checked (against the registries and against the other arguments) before any is registered; the first conflict is returned | The spec is silent; a partial registration on error would leave the caller unsure what is known |
| §4.5 `register` of a non-type | Throws `TypeError` | `RegisterError` has only `name_conflict`; a non-type argument is a programmer error TypeScript already rejects (AGENTS rule 7 allows throws by contract) |
| §4.5 failed event `register` | No side effect: a conflicting event is not noted, so a name held by one registered type stays unambiguous | Only types that are actually used (emit / `on` / trigger) make a name ambiguous, as F-8 describes |
| §4.5 `meta` cloning | Cloned at registration **and** per `describe()` call | Per-call cloning alone would let later mutation of the caller's `def.meta` object leak into the manifest |
| §4.5 rules `meta` | `installRules` sets `meta: { rule: name }` (rules package, E5.2 commit) | The spec's `SystemDefBase.meta` doc says rules set it; not in the plan's E5.2 file list |
| §4.5 persist `description` | A non-string `description` in `ComponentFieldData` is reported as a `SchemaProblem` and dropped, keeping the field | Matches how `registerComponentTypes` treats a bad `default` |
| §4.5 bridge reject reasons | `unknown event "X" (register it …)` vs `ambiguous event name "X": two distinct known event types share it` | Spec asks only for a `reason` |
| §4.5 `meta` JSON-safety (verify pass, `fix(E5)`) | `world.system()` throws `TypeError` naming the path when `meta` holds a function, `undefined`, a non-finite number, a hole, a bigint/symbol, a non-plain object or a cycle; checked before any state changes | Found in adversarial verify: a cyclic `meta` overflowed the stack and a function / `NaN` / `Date` leaked into the "plain-data" manifest. Mirrors the non-finite `order` throw |

### Implementation notes — E7 (2026-10-19)

E4 (snapshot v3) is still on hold; E7 shipped on the v2 envelope.

| Item | Choice | Reason |
|---|---|---|
| ED-2 / §3.2 v3 envelope | `pendingEvents` is an **optional field on the v2 envelope**; `SNAPSHOT_VERSION` stays 2 and no persist migration is added. When E4 bumps to v3 the field simply becomes one of v3's optional fields | E7 depends on E4's v3 bump, which the owner has on hold. The O-38/O-40/O-42 precedent (optional fields, no bump) is the only sound choice without E4; a 2.0 engine ignores the field and abandons the queue, its documented behaviour |
| §4.7 `pendingEvents` type | `payload` is **optional** (`{ event: string; payload?: JsonValue }`), absent for an `undefined` payload; the element type is exported as `SnapshotPendingEvent` | `defineEvent<void>` events emit `undefined`, which has no JSON form; throwing would break void events, and `null` would restore as a different value. A named export spares consumers `NonNullable<WorldSnapshot['pendingEvents']>[number]` |
| §4.7 "converted with `toJsonValue`" | A dedicated plain-data copy (`encodePendingEvents`) instead | `toJsonValue` coerces non-plain leaves to strings and truncates at depth 8, so it cannot "throw for a non-plain payload". Plain = null, boolean, string, finite number (`-0` kept), arrays, objects with `Object.prototype`/`null` prototype; an `undefined` object property is omitted (JSON semantics); `undefined` in an array, non-finite, BigInt, symbol, function, class instance or cycle throws `TypeError` naming the event, its index and the path (`payload.at[1]`) |
| §4.7 empty queue | With the option, the field is **omitted when nothing is in flight** | Restoring an absent field and an empty array both leave the queue empty, so omitting it changes no behaviour and keeps `hashSnapshot(snapshot({pendingEvents:true})) === hashSnapshot(snapshot())` for an idle queue (same convention as `resources`/`changes`) |
| §4.7 restore and `onRestore` emits | The snapshot's queue replaces the abandoned one; events a plugin emits during `onRestore` stay queued **after** it (new internal `EventBus.prependPending`) | SPEC §7.1 already promised that hook emits survive a successful restore; "replace" applies to the abandoned timeline's queue |
| §4.7 restore validation | Malformed field (not an array, entry not an object, `event` not a string) throws "invalid snapshot pendingEvents…" before any effect, alongside the O-41 envelope checks; payloads are not validated (like component values) and are cloned on re-queue | O-41 pattern |
| Verify note "Open for E7" (`firstDivergence`) | **Closed**: `Divergence` state key union gains `'pendingEvents'`, compared after `fixedBacklog` (commit `feat(persist): firstDivergence reports pendingEvents differences (E7.1)`) | As the E1 verify note asked |
| persist `save()` / `createSnapshotHistory` | Unchanged: they take default snapshots, so they carry no pending events (documented in SPEC §7.1 and the persist README) | ED-16 keeps the option opt-in; persisting pending events is not in §4.7's scope |
| §4.7 twin-named pending event (verify pass, `fix(E7)`) | `snapshot({ pendingEvents: true })` throws `TypeError` naming the event when another known event type shares a pending event's name | Found in adversarial verify: the by-name record could never restore (restore refuses the ambiguous name, even into the same world) or restored silently as the twin type in a world knowing only the other. `register` already refuses twins; `emit`/`on` do not |
| §4.7 own `"__proto__"` payload key (verify pass, `fix(E7)`) | The payload copy and `cloneSerializable` define `"__proto__"` as an own data key (`setOwn`) | Found in adversarial verify: `out[k] = v` set the copy's prototype, dropping the data from the snapshot, the restored queue and the hash. The shared `cloneSerializable` fix also covers component/resource values |
| §4.7 idle driver (verify pass) | No change; test added: after restoring a queue the O-48 repaint frame does not tick, the queue keeps the idle loop awake for one delivering step | Coverage gap only |

### Implementation notes — E4 (2026-10-19)

Owner decision (revision 3): `SNAPSHOT_VERSION` is 3 for every 2.1 snapshot.

| Item | Choice | Reason |
|---|---|---|
| §4.4 derivation, "each root word XOR-mixed with the key hash" | Word *i* = first `splitmix32` output seeded with `root[i] XOR rotl(h, 8·i)` (`h` the FNV-1a-32 key hash; `rotl` by 0, 8, 16, 24 bits); then the all-zero fix-up and 8 warm-up draws as specified. Golden: `deriveStream([1,2,3,4], 'rule:move')` = `[1860701461, 1711349229, 1513367337, 2826258467]`, first draws `0.09816509275697172, 0.44299133284948766, 0.6445047117304057, 0.22211877536028624`; the test also checks an independent oracle | XOR-ing every word with the same `h` maps equal root words (e.g. a user seed `[7,7,7,7]`) to four equal state words; the per-word rotation keeps them apart at no cost. The spec text now states the exact function |
| §4.4 stream key | Fixed at registration: the **lowest** of `name`, `name#1`, `name#2`, … that no live own-stream system holds. Equal to the cursor key (`name`, or `name#k` with *k* the number of live systems sharing the name) whenever no earlier same-named system was removed. (Verify pass: the first implementation took the cursor key and skipped held keys upward, so with two live same-named own systems, removing and re-registering the first — two rules handles sharing a rule name, the first calling `update()` — moved it to a fresh `name#2` stream and the live world diverged from a fresh fork; red tests `rng-streams.test.ts` 7b and rules `rng.test.ts` 2b) | Cursor keys shift when an earlier same-named system is removed; a key held by a live system must never be shared, and a system re-registered under its name must resume the key it left, as `RulesHandle.update()` relies on |
| §4.4 stream creation | At registration (claimed after the query is built, so a throwing registration leaves no entry); an own system that never draws still has an entry in `rngStreams` | "registering under key *k* … creates it from `deriveStream(root, k)`" |
| §4.4 `rng` validation | An `rng` other than `'shared'`/`'own'` throws at `world.system()` before any state change; in rules, an unknown `RuleDef.rng` is a `RuleError` with the new `RuleDefPath` member `'rng'`, an unknown `InstallRulesOptions.rng` throws at `installRules` | Mirrors a non-finite `order` (core), a bad `priority` (rules, O-69 R7) and a bad `order` option (E3). `RuleDefPath` is documented as widening in later minors |
| §4.4 validation | `rngRoot`/`rngStreams` present but `null` (or any non-conforming value) are rejected like `scaledTime` (only an absent field means "older build"); stream values must be arrays of 4 finite numbers. Root and stream states are normalized with `seedToState` on restore | O-41 / O-40 pattern |
| §4.4 reseed recipe typing | `WorldSnapshot.rngStreams` is typed `Readonly<Record<string, RngState>> \| undefined`; an explicit `undefined` restores as absent | The spec's recipe `{ ...snap, seed: s, rngRoot: s, rngStreams: undefined }` did not type-check under `exactOptionalPropertyTypes` (the repo's own tsconfig); found by the full typecheck after E4.4 |
| §4.4 v2 restore root (verify pass) | A snapshot without `rngRoot` (v2, or a migrated v2 save) restores onto the world's **`createWorld`** root, not the root it currently holds | The first implementation kept the current root, which may have been adopted from an earlier v3 restore, so the same v2 snapshot restored into the same build gave different own streams depending on what the world had restored before (red test: "a v2 snapshot restores onto the createWorld root…"). "Keeps the world's own root" now reads as the root fixed at `createWorld` |
| §4.4 `deriveStream` export | Exported from `@domecs/core` | Tests 6 and 8 and the reseed recipe need it; it is part of the snapshot contract |
| Plan E4.1 vs E4.3 split | The persist built-in `2 → 3` step shipped in the E4.1 commit (with its `migrate.test.ts` red), E4.3 added the persist save/load tests and the rules option | With `SNAPSHOT_VERSION = 3` and no step, every persist load of a 1.x/2.0 save failed (two existing persist tests went red), and ground rule 3 forbids committing failing tests |
| Plan E4.2 red step | Spec tests 3, 8 and 9 passed on first run: the restore path (map replacement plus missing-key re-derive) had to land in E4.1, whose v2-restore test exercises the same code. Each E4.2 test was checked to fail with the re-derive loop or the root adoption disabled | Recorded so the commit history is not read as a skipped red step |
| §4.5 manifest `rng` (deferred from E5) | **Shipped** in E4.1: `describe().systems[i].rng` is `'shared'` or `'own'` | E5 notes deferred it to E4 |
| E7 `pendingEvents` envelope | Unchanged; now one of v3's optional fields, with `SNAPSHOT_VERSION` 3 | Owner decision; E7 notes anticipated it |
| Goldens re-run | E1 hash goldens (`canonical-hash.test.ts` test 5, `GOLDEN_DEFAULT`/`GOLDEN_STRICT_META`) unchanged: the fixture is a literal v2 envelope without `rngRoot`, and `version` is excluded from the canonical form. E7 `pending-events.test.ts` passes unchanged. Updated for the bump: `resources.test.ts` (`SNAPSHOT_VERSION` and `snap.version` 3), persist `save-load.test.ts` wording (1 → 2 → 3) | Only literal version assertions changed; no hash golden pins a world-built snapshot before E8 (§4.4) |
| Agent docs | AGENTS.md / SKILL.md not edited in E4 | Not in the plan's E4.4 file list; a determinism-checklist line about `rng: 'own'` for A/B comparisons can follow with the E8 release notes |

### Verification notes — revision-3 docs pass (2026-10-19, adversarial pass)

| Finding | Fix | Reason |
|---|---|---|
| The Inputs paragraph named a session scratch path under `/tmp/…/scratchpad/harness/` in a committed document | Replaced with a description of the survey working folder (not committed) | A machine- and session-specific path is meaningless to readers of the repository |
| §8 and plan E8.3/E13.1/E18.1 named release notes `doc/v2.N.0.md` | `doc/release-notes/v2.N.0.md` | The v1.0.0 and v2.0.0 notes live in `doc/release-notes/` |
| §7.1 `ActLog.gaps` lists `'heartbeat_input'`, but the semantics say `setInput` + heartbeat records nothing | Plan E19.2 note: drop the reason unless implementation needs it, recording the choice here | An unreachable variant in a public union invites dead `case` branches |
| Studio docs still say "milestones E1–E18" | Not changed (the docs pass was limited to path references in the studio repo) | Follow-up in the studio repo: E1–E21 |

### Implementation notes — E8 (2026-10-19)

| Item | Choice | Reason |
|---|---|---|
| §3.4 script dependencies | `scripts/determinism-golden.mjs` imports only the built `@domecs/core` dist (no rules) | In the workspace, `@domecs/rules`' dist imports `@domecs/core`, which resolves to core's TypeScript `src` (publishConfig switches to `dist` only when packed), so Node cannot load it without a loader. Every runtime-sensitive piece (`dmath`, the RNG, canonical number formatting in the hash) is in core; rules route `sin`/`cos`/`random()` through it |
| §3.4 fixture sensitivity | `trig` stores `dmath.sin`/`cos` of the six angles where V8 13.6 `Math.*` differ from musl, plus orbit maths with arguments up to ~2^40; `bounce0` keeps `-0` in the final state (a resting ball against the right wall, `vx = -abs(vx) * 0.5`) and accumulates a `1 / vx` sign test | Mutation checks: swapping any `dmath` call in `trig` or the fingerprint for `Math.*`, or the `-0` bounce for `0 - abs(vx)`, changes the corresponding hash on Node 24. A first draft accumulated `sum += sin(a)`, where the 1-ulp difference was rounded away and `Math.*` went unnoticed |
| §3.4 studio access to the script | `pack-for-studio` copies the script next to the tarballs (manifest `golden`), and `--engine <node_modules>` loads core from there | The spec has studio run it "from the packed tarball", but no package ships `scripts/`; adding it to `@domecs/core`'s `files` would publish a test script to npm |
| §3.4 `test:golden` | `pnpm --filter @domecs/core build && node --test test/golden.test.mjs`; the test also checks `--engine` against a symlinked `node_modules` and that two runs print the same line | The script reads `dist/`, so a stale build would test old code |
| E8 exit, alt runtime | `DOMECS_ALT_RUNTIME="env ELECTRON_RUN_AS_NODE=1 <electron 44.9.0>"` (the studio spec's pin, installed in a scratch directory outside both repos): identical output on linux-arm64 (Node 24.19.0 / V8 13.6 vs Electron 44.9.0 / Node 24.22.0 / V8 15.2). On the same host a 2M-input `Math.sin`/`Math.cos` checksum **differs** between those two runtimes, so the golden's equality comes from `dmath`, not from luck | Recorded as evidence for critic risk 2 |
| §9 fork equivalence, "compose at 100" | The real `composeTransforms(Pos, WPos, …, { priority: 100 })` over a `Parent` hierarchy (spawned sparks are children of bodies); `@domecs/rules` gains `@domecs/scene` as a **devDependency** (test only; the published peer set is unchanged) | E3 used a stand-in to avoid the dependency; the RC suite should exercise what studio runs |
| E8.2 red step | The suite passed on first run against the 2.1 engine (after fixing two test-authoring slips: an exponent literal the rules lexer rejects and a wrong snapshot field). Non-vacuity is pinned instead: a fork-point test asserts in-flight `Ping`s, a partial fixed step, six own streams, spawned and despawned entities, a `-0` and composed `WPos`; four controls diverge (no `pendingEvents`; a `JSON.stringify` round trip; `rngStreams` stripped; `order: 'registration'` with a user system registered after the rules) | No 2.1 defect found; the controls show each guarantee is what keeps the fork equal |
| E8.3 release notes path | `doc/release-notes/v2.1.0.md` (§3.3 now says so too) | The task brief said `doc/v2.1.0.md`; §8, the plan and the revision-3 verification pass put release notes next to `v2.0.0.md` in `doc/release-notes/` |
| E8.3 CHANGELOG | The in-progress 2.1.0 block becomes `## [2.1.0] — release candidate (2026-10-19; not yet published)` under an empty `[Unreleased]` | Publishing waits for owner approval (§8); the heading should not show a release date before then |
| E8 exit gates (2026-10-19, linux-arm64 2-vCPU) | All green at the E8.3 commit: `pnpm -r test` (883 tests), `pnpm -r typecheck`, `pnpm -r build` + `pnpm api:surface` (no drift), `pnpm api:check`, `pnpm doctest` + `doctest:check`, `pnpm test:release`, `pnpm test:legibility`, `pnpm test:plantroom`, `pnpm cold-install`, `pnpm test:golden` under Node and with `DOMECS_ALT_RUNTIME` = Electron 44.9.0 as node, `test/pack-for-studio.test.mjs`. `pnpm bench`: no regression beyond noise against 2.0.0 (table in `bench/README.md`; largest median delta +3% windowed, 1 µs, against a 2.0-vs-2.0 spread of up to 4.5%) | §8 RC gates |
| AGENTS.md / SKILL.md | Not edited in E8; the E4 note's suggested checklist line (`rng: 'own'` and `snapshot({ pendingEvents: true })` for A/B forks) is in the release notes' upgrade steps instead | AGENTS.md is the repo's agent instruction file; leaving it to the owner |
| E8 verify pass (2026-10-19) | Re-ran every gate at `5fa074d`: `pnpm -r test` 883 (core 502, input 25, dom 36, inspector 22, persist 92, scene 38, rules 168), `pnpm -r typecheck`, `pnpm -r build`, `api:surface` (no drift), `api:check` 3/3, `doctest` 11/11, `doctest:check` 4/4, `test:release` 8/8, `test:legibility` 1/1, `test:plantroom` 6/6, `test:pack` 2/2, `cold-install` ok, `test:golden` 5/5 with `DOMECS_ALT_RUNTIME` = Electron 44.9.0 as node; the golden also matches under Node 20.20 and 22.23 (the CI matrix); bench re-run interleaved against 2.0.0 within noise (soak 0.96/0.94, telemetry 1.00/0.96, windowed 1.02/1.03 over 9 runs, snapshot 0.99/0.97, p50/p95 ratios). One fix: `--engine` with no directory silently fell back to the workspace build, and `--write --engine` (a vendored copy) would write `../test/golden` outside `vendor/domecs`; both now exit 2 (`fix(E8)`, test in `golden.test.mjs`). FINDINGS O-75 records the dual-runtime half as shipped | A fallback would let studio pin the wrong build without noticing |

### Implementation notes — pre-2.2 engine fixes (2026-10-19)

| Item | Choice | Reason |
|---|---|---|
| Studio finding: `validateEventPayload` not public | Re-exported from `@domecs/core` under its existing name, with the signature unchanged (`(type, payload) => string \| null`); `doc/api.md` Events section + doctest, API surface, test `validate-event-payload.test.ts`; recorded in `doc/FINDINGS_studio.md` | §5 already names `validateEventPayload` for rule `emit` validation, and the function was already exported from `events.ts`; only the package entry point lacked it. Studio kept a copy that could drift |
| Studio docs "milestones E1–E18" | Not changed (studio repo, out of scope for engine work) | Already listed in the revision-3 verification notes as a studio follow-up |
| Verify pass: `validateEventPayload` inherited keys | Unknown-field check and field reads use own properties (`hasOwnProperty.call`) instead of `in` / prototype-chain reads (`fix(E-fix)`) | `{ dx: 1, constructor: 'x' }` or `JSON.parse('{"__proto__":{}}')` was accepted by `action()` as if the key were declared; a declared field named `toString` that was absent was rejected as "got function". The documented rule is "undeclared keys are rejected"; studio now runs this on agent-built payloads |
| Verify pass: "plain object" wording | Behaviour unchanged: the check is "non-null, non-array object", so a `Date` or class instance with no own keys passes | Pre-existing O-39 behaviour; tightening to a prototype check could reject cross-realm objects (Electron IPC, `vm`). `doc/api.md` now says "non-null, non-array object" instead of "plain object" |

### Implementation notes — E9 (2026-10-19)

| Item | Choice | Reason |
|---|---|---|
| §5.1 negative or NaN radius | `within`/`pairs` with `r < 0` or NaN, and `nearest` with `maxDistance < 0` or NaN, match nothing | Read literally, "distance² <= r²" would make `r = -1` behave like `r = 1`; a negative radius is a caller error, and "nothing is within a negative distance" is the sound reading. Documented in SPEC §2.12 and `doc/api.md` |
| §5.1 `nearest` bound | Ring `k`'s bound is `(k − 1) × cellSize × (1 − 2^-40) − (abs(x) + abs(y) + cellSize) × 2^-40`, compared squared and **strictly** (`bound² > best`) | The spec's `(k − 1) × cellSize` is the exact gap only when cell assignment is exact; `Math.floor(v / cellSize)` rounds the quotient, so a point can sit up to a few ulps of `abs(v)` outside its nominal cell, and with large coordinates relative to `cellSize` that exceeds a whole cell. The slack keeps "rounding can only add cells" true; strict comparison keeps an equal-distance, lower-id point in an unvisited ring from being skipped. A mutation to `(k + 1) × cellSize` fails three tests |
| Full-scan fallbacks | `nearest` scans every point once the next ring would need more cell lookups than there are occupied cells; `within`/`pairs` scan when the covering block (padded by the same slack and one cell per side) holds more cells than are occupied, or `r²` overflows | Keeps a far query, or a radius much larger than the cell, from walking millions of empty cells; the scan is the oracle by definition, so results are unchanged |
| Cell keys | Three exact, disjoint tiers chosen by the cell coordinates alone: `abs(c) < 2^14` → small integer in `[0, 2^30)`, `abs(c) < 2^25` → `2^30 + …` (below 2^53), otherwise a `"cx,cy"` string; a cell coordinate beyond ±2^50 (or a quotient that overflows) puts the point on an outlier list every query scans | "Packed by an exact rule" (spec); the small-integer tier halved `set()` cost in the bench (V8 small-integer Map keys). Outliers keep huge coordinates exact without ring arithmetic past 2^53. Tests cover neighbours across both tier boundaries, `±1e300`, `-1.7e308`, `2^60` and subnormals at every cell size |
| `accept` call order | `within` and `pairs` call `accept` in output order on the matches only; `nearest` may call it in any order and number of times (documented as "should be pure") | Calling in cell order would make a side-effecting `accept` see a cell-size-dependent order |
| `createSpatialGrid` validation | `RangeError` unless `cellSize` is finite and > 0 | Spec silent; a zero or NaN cell size cannot index anything, and the API throws by contract like `setScale` |
| Scene index lifetime | `createSpatialHash` refreshes once at creation; positions are as of the last `refresh()` (a despawned id stays until the next refresh); filters use live `world.has`; `dispose()` is idempotent and later calls throw | Spec silent on the initial state; an index that answers `[]` until a first refresh is a trap. Positions-as-of-refresh is the spec's model ("Rebuild … (O(n))"); filters are cheap to read live and need no rebuild |
| Scene field types | A position field that is not a number (or not finite) is not indexed | Mirrors the grid rule for non-finite coordinates |
| `pairs(r, a, b)` with `a ≠ b` | Every ordered pair `(p, q)` with `p` holding `a` and `q` holding `b` within `r`; an entity holding both tags can appear on either side | The spec's literal canonicalization ("the first element carries `a`"); a contact between two entities that both hold both tags is reported in both directions |
| Refresh strategy | In place: `set()` per entity (no allocation when it stays in its cell), then a merge walk over the previous refresh's ascending ids deletes the stale ones | `clear()` + rebuild cost ~0.3 ms at 1000 entities (allocation); in place is ~0.18 ms. Results do not depend on history (insertion-order test) |
| Bench targets | `spatial` workload: `nearest` 0.71 µs average (≤ 2 µs met); `refresh()` 0.175–0.185 ms p50 (≤ 0.1 ms **missed**, informational), of which ~0.12 ms is `world.iterEntitiesWith` itself | Recorded like the hash target in E1. The spec fixes iteration via `iterEntitiesWith`; a faster core iterator or the incremental refresh follow-up would close it |
| Bench loading `@domecs/scene` | The workload registers a `node:module` resolve hook mapping `@domecs/core` to the core dist before importing the scene dist | In the workspace the scene dist's bare `@domecs/core` import resolves to TypeScript source (see the E8 note); the bench must not need a bundler |
| Doctest harness | `scripts/doctest.mjs` `DOMECS_PACKAGES` gains `scene`; `doc/api.md` gains a `@domecs/scene` section (spatial index; hierarchy stays in the README) with doctest `spatial-index`, and a core "Spatial grid" section with doctest `spatial-grid` | §3.3 requires runnable reference fences; `api.md` had no scene section |
| Scene peer range | Unchanged (`workspace:^`) | `@domecs/scene` now needs a core that exports `createSpatialGrid` (2.2). `workspace:^` publishes as `^<core version>`, so the E13 version bump to 2.2.0 makes the range correct; publishing scene 2.2 against a 2.1 core range would be wrong |
| Verify pass: SPEC §2.12 cell wording | SPEC §2.12 no longer says cell coordinates are "exact for every finite `v`"; it says the floor is exact and deterministic but the division rounds (a point within a few ulps of a border can land in the neighbouring cell), and it names the absolute slack in the `nearest` bound (`fix(E9)`) | The old sentence contradicted the `nearest` bound note above (the slack exists because the quotient rounds). Code unchanged; a 1500-case fuzz at offsets up to 1e20 and cell sizes 1e-5…1e9 matched the brute-force oracle for `within`/`nearest`/`pairs`. A mutation setting the slack to 0 survives the test suite (no counterexample found in a targeted search); the slack is kept as a conservative margin |

### Implementation notes — E10 (2026-10-19)

| Item | Choice | Reason |
|---|---|---|
| §4.2 accuracy, `pow` | **Spec correction:** "pow < 1 ulp (fdlibm)" does not hold everywhere. In fdlibm's `|y| > 2^31` path with `\|1 - x\| <= 2^-20` the series' first product `ivln2_h * t` is inexact once `t = x - 1` has a full mantissa (33 bits), so results are off by up to a few hundred ulp (relative ≤ ~2^-43; e.g. `pow(0x3fefffff8f1011a2, 0x41e84954f3000000)`, ~270 ulp). The port keeps fdlibm's bits there (Java `StrictMath.pow` does the same). The 100k accuracy test excludes that region; a separate test bounds it at 2^-40 relative; docs state it | Minimal change: bit reproducibility is the contract, and the spec names fdlibm `e_pow.c` as the source. Patching the region would be an unreviewed variant of a reviewed algorithm; the error is far below anything a sim observes |
| §4.2 test 2, `hypot` | Accuracy is measured against an exact BigInt reference (correctly rounded sqrt(x² + y²)), not `Math.hypot` | V8 13.6's `Math.hypot` is itself more than 1 ulp off on some inputs (e.g. `hypot(0x09b6e074d9767ced, 0x08de49eedc149a22)`: V8 1.17 ulp, musl 0.83 ulp), so "≤ 1 ulp of `Math.*`" fails for a correct port. `atan2` and `pow` are still checked against `Math.*` |
| §4.2 specials, `pow` | ECMAScript `**` semantics, as fdlibm: `(±1) ** ±Infinity` and `1 ** NaN` are `NaN` | "Specials follow C99 Annex F" conflicts with fdlibm (C99 says 1). fdlibm agrees with `Math.pow`/`**`, which is what JS authors and rules expect; documented in `doc/api.md` and the `dmath` doc comment |
| §4.2 golden for the 2.2 functions | A second file, `test/golden/dmath2-vectors.json` (`{ atan2, hypot, pow }` rows `[a, b, f(a, b)]`, 3600 vectors), written by the same `scripts/dmath-golden.mjs` after the sin/cos section | Leaves `dmath-vectors.json` byte-identical (it pins 2.1); the test checks `functions` per file |
| §4.2 port fidelity (risk §11.1) | One-off check, not committed: musl `atan.c`/`atan2.c`/`hypot.c` and fdlibm 5.3 `e_pow.c` compiled with `gcc -ffp-contract=off` on aarch64 matched the port bit for bit on 2.1M inputs (the golden plus random bit patterns, near-1 bases with huge exponents, everyday ranges) | As E2 did for sin/cos |
| §5.2 "an entity used as a value" | Rejected by the **parser** ("An entity is not a value (use .id, or .Component.field)", at the entity's position), so `StaticKind` does not gain `'entity'` | The specified AST has no node for a bare entity in value position (`EntityNode` is not in the `AstNode` union), so the error must be raised while parsing; the rules field (`'when'` / `{action, part: 'expr'}`) is the same as for any parse error |
| §5.2 reserved `self` | `self.hp` (no second field) reports "reserved word" at `self`, naming the `self.Component.field` form; `self.C.f` and `self.id` are entity reads; reserved words are also rejected as set names, `has` targets, aggregate fields and member components | `self.hp` is exactly what a pre-2.2 rule reading a component named `self` looks like, and the spec asks for "reserved word" at the name's position |
| §5.2 `walkFieldRefs` | Visits every read of the evaluated entity's own fields: `C.f`, `self.C.f`, and those inside the 2.2 forms' expression arguments (`nearest(S, Range.r)`, `entity(Target.id)`, `??` operands); never other entities' fields, sets or `has` targets | "Visits self fields only" (spec); `self.C.f` is a self field and evaluates through `resolveField` like `C.f` |
| §5.2 `has` optional argument | `SPECIAL_FORMS.has` is `{ args: ['entity', 'set'], optional: 1 }`, documented as the one form whose optional argument leads | The grammar puts the optional entity first (`has([e,] C)`) |
| §5.2 exports | `@domecs/rules` exports `walkComponentRefs`, `SPECIAL_FORMS`, types `EntityNode`, `AggregateOp`, `CompileRuleOptions`, `SpatialOption`; `compileRule` takes an optional third argument `{ spatial? }` | Studio renames need `walkComponentRefs` from the package entry (spec "Studio" note); the compile-time spatial check needs the option where rules compile |
| §5.2 positions | `position(e)` reads `spatial.component`'s own `x`/`y` fields **live** (committed values; a pending write of the evaluated entity is not seen); missing, non-number or non-finite → no position (no value). `nearest`'s query point is self's live position and `countWithin`'s centre the centre's live position; the candidate sets come from the start-of-run grid (built eagerly before the first entity, only when the query matched any) | The spec fixes the grid to the start of the run and `distanceTo` to live reads but is silent on the query point; live is what `distanceTo` uses, and an entity is visited once per run, so self's position is its start-of-run position unless an earlier action of the same entity staged a write |
| §5.2 `spatial` option | `cellSize` defaults to 32. `installRules` throws when `spatial` is not `{ component, x?, y?, cellSize? }` with non-empty names (and not `__proto__`/`constructor`/`prototype`) or `cellSize` is not a finite number > 0. An unknown `spatial.component` is a `RuleError` on each rule that uses a spatial form, at the form | Validation mirrors `order`/`orderBase`/`rng`; resolving lazily keeps rules without spatial forms independent of the option |
| §5.2 no value vs type error | `entity(1.5)` (non-integer) is a type error, not no value; `avg`/`minOf`/`maxOf` give no value when no member has the field (all skipped), not only for an empty set; a missing hook (an `EvalEnv` without `members`, `tick`, …) is a plain `RuleEvalError` that `??` does not catch | A non-integer id is a mistake in the rule, not an absent entity; "no contributing member" is the same situation as an empty set; a missing hook is an environment error |
| §5.2 reads of self through selectors and aggregates | When `entity(n)` or an aggregate member is the evaluated entity, the read goes through `resolveField`, so it sees the entity's staged writes like `C.f`; `readsStaged` now considers every field read (not only `walkFieldRefs`') | One rule for "the evaluated entity's fields" whatever the spelling |
| §5.2 memoization | `compileExpression(ast, { memoize })` caches a marked aggregate per environment object; `installRules` builds one environment per run. Marked: `count`/`exists` always, field aggregates when no action writes that component. A `RuleNoValueError` is not cached (recomputed, same result) | No public `EvalEnv` change; `compileExpression` is internal |
