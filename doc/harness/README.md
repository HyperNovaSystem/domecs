# Studio harness: engine gaps

Design and plan for the engine half of the Studio AI harness: the 2.1–2.3 work that makes forks
equal the live world bit for bit and lets behaviours be written as rule data.

| File | What it is |
|---|---|
| [2026-10-18-harness-engine-gaps.md](2026-10-18-harness-engine-gaps.md) | **Spec (authoritative)**, revision 3. Gaps G1–G21, owner decisions (§2), cross-cutting contracts (§3), per-release items (§4–§7), release mechanics (§8), and the review dispositions plus per-milestone implementation and verification notes (Appendix C) |
| [2026-10-18-harness-engine-gaps-plan.md](2026-10-18-harness-engine-gaps-plan.md) | **Implementation plan.** Milestones E1–E21 (+ conditional EC4) as red → green → commit tasks with their commit lines |

Releases at a glance:

- **2.1** determinism foundation + build identity: canonical hash, `dmath`, rule ordering,
  per-system RNG streams (snapshots always v3), registry and name lookup, `RuleError.field`,
  pending events in snapshots (E1–E8).
- **2.2** behaviour language I + record/replay and branching: spatial grid, cross-entity rules,
  world expressions, input in rules, act log + replay, `createBranch`/`runBranch` (E9–E12, E19,
  E20, RC E13).
- **2.3** behaviour language II + ergonomics + scenes: rule effects and event rules, contacts,
  `runSystems`/`render`, small items, `instantiateScene`/`unloadScene` (E14–E17, E21, RC E18).
- **Conditional:** `redefineComponent` (EC4).

Related documents:

- [`plan/FINDINGS.md`](../../plan/FINDINGS.md): the O-ledger; each item's row (O-75..O-90 and the
  reused ids) opens when its work starts and closes in the change that ships it.
- [`plan/PLAN.md`](../../plan/PLAN.md): governing product direction.
- [`doc/SPEC.md`](../SPEC.md), [`doc/api.md`](../api.md) and [`doc/api-surface/`](../api-surface/):
  where shipped items land.
- Studio counterpart (sibling repository): `../studio/docs/superpowers/specs/2026-10-18-studio-harness-design.md`
  and `../studio/docs/superpowers/plans/2026-10-18-studio-harness-plan.md` (paths relative to this
  repository's root).

The spec and plan use repository-root-relative paths in backticks (for example `plan/FINDINGS.md`);
Markdown links are relative to the file. Both files moved here from the gitignored `plan/` folder
on 2026-10-19 so they are versioned with the code they govern.
