# DOMECS Findings — lighthouse_novel

## 2026-05-13 — transient-only view entities leave empty snapshot records

`lighthouse_novel` spawns DOM view entities whose components are all marked `transient`. DOMECS correctly omits those components from `world.snapshot()`, but the snapshot still includes the entity record with an empty `components` object. For a UI-heavy visual novel (choices, transcript lines, save slot cards, gallery cards), that can add save-file noise and revive empty entities on restore.

Suggested follow-up: either have snapshot skip entities that have no non-transient components after filtering, or provide a documented plugin hook/pattern for pruning transient-only view entities before save serialization.
