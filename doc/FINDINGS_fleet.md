# Engine findings surfaced by fleet_app (DOMECS exemplar #5)

App-side deficiencies live in `fleet_app/FINDINGS.md`. This file collects
deficiencies whose fix would land in `@domecs/*`, so engine maintainers can
triage all fleet-surfaced findings in one place. The curated cross-app synthesis
in `../FINDINGS.md` draws from these.

## O-16 — orphaned/ghost DOM rows under same-tick remove-all/re-add

Synthesis entry: `../FINDINGS.md` O-16 (sharpens O-5/O-6). This note adds the
reproduction recipe fleet_app pinned down on 2026-05-31.

**Confirmed deterministic repro (no real browser needed).** Earlier notes said a
`@domecs/dom` reconciliation test was still needed; here it is. Mount a view over
`Has(TableRow)` whose `create`/`update` paint a per-entity *rank* into the node,
then in one tick run a projection that `removeComponent(TableRow)` over the whole
current window and `addComponent(TableRow)` for a freshly-sorted window (partial
membership overlap). After a single `world.step`, the slot retains stale nodes
carrying their PRE-sort rank.

**The trap that hid it:** the rendered row *count* stays correct (`= size`, e.g.
50) — the corruption is duplicate/stale *content*, not extra nodes. A test that
asserts only `childElementCount` passes while the DOM is visibly wrong. Assert the
set of rendered ranks equals `1..N` (i.e. no duplicates), not just the length.

Observed signature in fleet (seed `0x51ee7`, window 50, sort speed desc from the
initial callsign-asc order): stale ranks `3,4,17,18,27,28,41,42` survive as
duplicates. Reproduces both under the rAF `startLoop` in a browser and in jsdom
via manual `world.step` — see `fleet_app/test/fleet.dom.test.ts`.

**Suspected mechanism (unchanged from O-16):** `mount.ts commit()` reads correct;
the lost removal is upstream — a query-membership / changed-set delta that
coalesces a same-tick remove+add so an entity that genuinely *left* the query
never fires `onRemove`, leaving its node neither destroyed nor `update()`d.

**Fleet-side mitigation (does not fix the engine):** `sim.ts rebuildTableRows()`
now updates `TableRow` in place keyed by entity (remove only leavers, add only
enterers, mutate survivors), so the view never sees a mass component exit. The
engine defect remains — any consumer doing hand-rolled despawn+respawn in one tick
will still corrupt the DOM.
