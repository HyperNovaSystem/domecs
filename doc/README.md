# DOMECS Documentation

Design documentation for DOMECS. These files are the living specification; the repository's root `README.md` is the pitch.

## Contents

1. **[critique.md](critique.md)** — Adversarial read of the top-level README. Identifies load-bearing claims, hidden dependencies, and eleven concrete issues that shape v0.1.
2. **[exemplars.md](exemplars.md)** — Six exemplar applications (roguelike, management sim, visual novel, board game, control dashboard, game editor) used as forcing functions for requirements.
3. **[SPEC.md](SPEC.md)** — Normative v0.1 specification: core model, scheduling, renderer, persistence, determinism contract, plugins, adapters.
4. **[api.md](api.md)** — Draft TypeScript API surface for every public package.

## Reading order

- New to the project → [../README.md](../README.md), then `critique.md` to see what the README over-promises, then `SPEC.md`.
- Implementing core → `SPEC.md` §§ 2–4, 8, then `api.md` sections for `domecs`.
- Implementing a plugin → `SPEC.md` § 9, then `api.md` plugin interface.
- Validating a design change → cross-check against `exemplars.md` requirement intersection table.

## Stability

Pre-v0.1. Everything here may change. Tracked in Reqall under project **HyperNovaSystem/domecs**.
