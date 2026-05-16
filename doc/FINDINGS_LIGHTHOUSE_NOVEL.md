# DOMECS Findings — lighthouse_novel

## 2026-05-13 — transient-only view entities leave empty snapshot records

`lighthouse_novel` spawns DOM view entities whose components are all marked `transient`. DOMECS correctly omits those components from `world.snapshot()`, but the snapshot still includes the entity record with an empty `components` object. For a UI-heavy visual novel (choices, transcript lines, save slot cards, gallery cards), that can add save-file noise and revive empty entities on restore.

Suggested follow-up: either have snapshot skip entities that have no non-transient components after filtering, or provide a documented plugin hook/pattern for pruning transient-only view entities before save serialization.

## 2026-05-16 — `Plugin.install` Result-typed contract is a silent breaking change for existing apps

After BETTER_ERRORS Phase 1 landed, `Plugin.install` must return `Result<PluginHandle | void, DomecsError>` instead of a bare `PluginHandle`. `lighthouse_novel.pruneTransientOnlyEntities` returned the raw handle object and failed `tsc --noEmit` without any runtime warning beforehand: workspace `file:` deps mean engine drift surfaces only on the next typecheck.

Fix was mechanical: import `ok` from `@domecs/core` and wrap the handle (`return ok({...})`). Worth calling out because:

- DOMECS docs and SPEC §9 examples in older revisions still showed the bare-handle shape.
- The handle's `onSnapshot(snap: unknown): unknown` workaround used to be needed to dodge a stricter parameter type; under the new typed signature (`WorldSnapshot → WorldSnapshot`) the workaround is no longer necessary and produces a worse type than the contract.

Suggested follow-up: when a contract drift like this is unavoidable, ship a codemod (or at minimum a short migration note in `doc/PACKAGING.md` keyed off the next published version), and update README/SPEC examples in the same commit so search-engine results don't show the old shape.
