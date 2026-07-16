# DOMECS Documentation

Design and reference documentation for DOMECS. These files are the living
specification; the repository's root `README.md` is the pitch.

## Contents

### Specification & API

1. **[SPEC.md](SPEC.md)** — Normative specification: core model, scheduling, renderer, persistence, determinism contract, plugins, adapters.
2. **[api.md](api.md)** — Human-readable TypeScript API surface for every public package. The authoritative contract is the committed type surface in `api-surface/`; where they disagree, the types win.
3. **[api-surface/README.md](api-surface/README.md)** — The committed, machine-readable `.d.ts` surface snapshots (one per package) and the CI no-drift gate that guards them.
4. **[exemplars.md](exemplars.md)** — Six exemplar applications used as forcing functions for requirements.
5. **[PACKAGING.md](PACKAGING.md)** — Packaging, publishing, Vite app templates, and deployment interop.

### Legibility & design rationale

6. **[LEGIBILITY.md](LEGIBILITY.md)** — The six legibility laws (all enforced as of v1.0). The standing review checklist for every public change.
7. **[agent-legible-api-design.md](agent-legible-api-design.md)** — The agent-legible API design rubric the legibility pass applied.
8. **[error-handling.md](error-handling.md)** — Result/error-handling conventions and the `DomecsError` model.
9. **[BETTER_ERRORS.md](BETTER_ERRORS.md)** — Error-surface design notes.
10. **[TYPE_EVAL.md](TYPE_EVAL.md)** — Type-level evaluation / inference design notes.

### Release & forward planning

11. **[../CHANGELOG.md](../CHANGELOG.md)** — Released changes, starting with v1.0.0.
12. **[ROADMAP.md](ROADMAP.md)** — Post-v1.0 roadmap: directional items + tooling.
13. **[../plan/FINDINGS.md](../plan/FINDINGS.md)** — Consolidated findings ledger: what shipped (§1), open/actionable (§2, incl. the 2026-06-01 engine review O-20…O-26 and the fleet O-16 repro recipe), and deferred engine features (§3). **Canonical and sole findings file** — new findings land here.
14. **[../plan/PLAN.md](../plan/PLAN.md)** — Governing post-v1.0 plan: thesis, workstreams, stop-doing list, kill gates.

## Reading order

- New to the project → [../README.md](../README.md), then `SPEC.md`.
- Agents / AI tooling → [../AGENTS.md](../AGENTS.md) and [../skills/domecs/SKILL.md](../skills/domecs/SKILL.md).
- Implementing core → `SPEC.md` §§ 2–4, 8, then `api.md` sections for `@domecs/core`.
- Implementing a plugin → `SPEC.md` § 9, then `api.md` plugin interface.
- Packaging or deploying an app → `PACKAGING.md`, then the standalone Vite example apps (the root README's Live demos table links all five).
- Proposing a public API change → `LEGIBILITY.md` (the six laws) and `agent-legible-api-design.md`, then `api-surface/`.
- Planning future work → `../plan/PLAN.md` (governing), then `ROADMAP.md` and `../plan/FINDINGS.md`.

## Stability

v1.0 — **API-stable**. All five `@domecs/*` packages are at `1.0.0`. Semver is
honored; the product contract continues to harden via corrective `1.0.x`
releases. See `../CHANGELOG.md` and governing direction in
`../plan/PLAN.md`.
