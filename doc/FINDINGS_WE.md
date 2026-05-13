# Findings

## 2026-05-13 — studio DOMECS exemplar

- `studio` now validates the DOMECS Studio editor slice: separate editor/guest worlds, guest-world plugin installation, entity tree, schema-driven inspector, prefab spawning, visual-script binding projection, scene save, play/pause/step controls, and time-travel scrubber.
- The inspector uses `world.componentTypes()` to discover registered component types but still needs Studio-maintained field metadata to render widgets. This is intentional for the exemplar and records a framework gap in `domecs/doc/FINDINGS_STUDIO.md`.
- The snapshot ring is diff-based and bounded, with one base checkpoint plus diffs. It proves compact time travel for small changes, but a production implementation needs binary/structured-clone storage and checkpoint tuning for long editing sessions.
- The browser UI is vanilla DOM and redraws panels wholesale after editor events. This keeps the exemplar simple, but a polished Studio should move these projections behind reusable DOMECS DOM views/windowing.

## 2026-05-13 — fleet_app DOMECS exemplar

- `fleet_app` now validates the Fleet Pulse dashboard slice: 400 vehicle entities, 100 infrastructure entities, WebSocket-style telemetry events, coalesced reactive projection, virtualized table rows, map pins, charts, alarms, and transient UI state.
- The implementation intentionally uses DOMECS `Where(...)` for numeric range alarm tests. This proves expressiveness but not indexed range-query performance; see `domecs/doc/FINDINGS_FLEET.md` for the framework follow-up.
- The virtual table currently adds/removes transient `TableRow` components when sorting or scrolling. It is acceptable for the exemplar but a production dashboard should use a row-recycling virtual-list renderer to avoid structural churn.
- Feed bursts are coalesced when callers queue them into one `TelemetryBatchEvent`/tick. A real WebSocket adapter should add backpressure metrics and coalescing policy rather than emitting unbounded individual events.

## 2026-05-13 — lighthouse_novel DOMECS exemplar

- The exemplar satisfies the event-driven core loop without tick/fixed story systems, but the typewriter fields are currently rendered fully revealed. A later polish pass should add a bounded typewriter reveal mode that still allows idle RAF suspension when text is complete.
- Save slots are in-memory `WorldSnapshot` records with metadata and restore support. A production visual novel should add IndexedDB persistence plus JSON import/export UI for the 50+ slot workflow called out by the DOMECS exemplar.
- The 2,000-node script scale is represented with generated archive-letter data, not authored story content. This is enough to validate that the narrative graph stays out of ECS entity storage, but future playtesting needs a richer DSL/import pipeline.
