# DOMECS Findings — Fleet Pulse Exemplar

Notes from fleshing out `fleet_app`, based on exemplar #5 in `doc/exemplars.md`.

## Summary

The current DOMECS slice can express a dashboard whose simulation is driven by external events rather than an always-on game loop. `world.emit()` from a feed handler, event systems, explicit `markChanged`, and reactive systems were enough to ingest a 500-update burst and coalesce it into one dashboard projection tick. Transient components also worked well for virtual table rows, map pins, chart samples, and user viewport state.

The implementation exposed several dashboard-specific pressure points that should be addressed before treating Fleet Pulse as a full validation of the exemplar.

## Findings

### 1. Numeric range filters exist, but are not indexed

Fleet Pulse uses `Where(Telemetry, t => t.speed > 80)` and similar predicates for alarm/range queries. This satisfies expressiveness, but `Where` is documented as a per-entity scan over matching archetypes.

Suggestion:

- Add a v0.2 range-index recipe or plugin API, e.g. `indexRange(Telemetry, 'speed')`.
- Keep `Where` as the ergonomic fallback, but expose when a hot range query is scanning too many entities.
- Dashboard examples should show the tag-component workaround (`Speeding`, `LowBattery`) for alarms that need archetype-cached iteration.

### 2. Reactive coalescing works at tick granularity, not at feed policy granularity

A 500-update batch becomes one reactive projection run when emitted before a single `world.step()`. That is the right core behavior. A real WebSocket can deliver many callbacks between frames or too many updates to retain losslessly forever.

Suggestion:

- Document an official external-feed adapter pattern: queue, coalesce by entity/key, then emit one `TelemetryBatchEvent` per frame/tick.
- Expose event-buffer pressure metrics (events per type, payload count/bytes, oldest age).
- Consider optional coalescing/drop policies for dashboard telemetry while preserving lossless events as the default for games/sims.

### 3. Virtualized rendering currently means structural component churn

The prototype projects only visible table rows by adding/removing transient `TableRow` components. This validates selective rendering, but scrolling/sorting causes structural query changes and mount/unmount churn.

Suggestion:

- Add a DOM virtual-list helper that owns row recycling without requiring app code to mutate entity archetypes.
- Provide renderer metrics for created/destroyed/updated nodes so dashboards can catch accidental full-table remounts.
- Document the tradeoff between transient projection components and view-level windowing.

### 4. Projection systems can over-mark derived views

The dashboard projection updates every `MapPin` during a telemetry-driven projection pass, even though a 500-update burst may touch fewer than all 400 vehicles. This is simple and safe, but not an ideal demonstration of fine-grained reactivity.

Suggestion:

- Provide helper APIs for iterating `Changed(T)` entity ids directly and for batch `markChanged` calls.
- Encourage derived-view systems to update only affected entities when feasible.
- Add dev diagnostics for high mark counts per tick, not only missing marks.

### 5. Dashboard persistence wants transient redaction plus user preferences

Transient components cleanly omit table viewport, rows, map pins, and chart samples from snapshots. Production dashboards still often persist user preferences (columns, sort, filters) separately from world/entity state.

Suggestion:

- Document a preferences/localStorage pattern alongside `world.snapshot()`.
- Clarify snapshot boundaries for dashboards: live feed state may be disposable, but operator preferences usually are not.

### 6. One-shot queries are easy to leak

Fleet Pulse's projection code needed ad hoc answers such as "how many `TableRow` projections exist?" and "which entities currently have `TableRow`?". The natural call is `world.query(Has(TableRow))`, but DOMECS queries are live objects that should be disposed. Using them as one-shot selectors inside projection code can quietly accumulate compiled queries.

Suggestion:

- Add a one-shot query API or recipe, e.g. `world.select(query)` / `world.count(query)` / `world.entities(query, fn)`, that does not register persistent hooks.
- Alternatively, make identical `world.query(...)` calls deduplicate/cache safely, or expose diagnostics for undisposed query growth.
- Emphasize `entitiesWith(Component)` in examples when only a single component is needed, and consider an `entitiesMatching(QueryDef)` iterable for multi-component cases.

### 7. Reactive systems need dependency/write-cycle hygiene

The projection system reacts to input components (`Telemetry`, `TableViewport`, `AlarmState`) and writes derived components (`TableRow`, `MapPin`, `ChartSeries`, `DashboardStats`). It is easy to accidentally include a derived output such as `DashboardStats` in `reactsTo`, or to mark a component that triggers the same projection, creating confusing same-tick/next-tick behavior.

Suggestion:

- Add dev diagnostics when a reactive system marks/writes a component that appears in its own `reactsTo` query.
- Document a pattern that separates source state, derived projection state, and aggregate singleton stats.
- Consider a `derived`/`projection` system helper with explicit `reads` and `writes` metadata so the inspector can show dependency graphs and warn about cycles.

### 8. Aggregate dashboard panes are not naturally entity views

The map pins and table rows fit `domecs-dom` entity views. Aggregate UI such as stats panels, alarm queues, chart summaries, and drill-down panes were painted manually from `tickEnd` subscribers. That works, but it means each dashboard invents its own mini-renderer for singleton/resources and aggregate lists.

Suggestion:

- Add/document DOM view helpers for singleton/resource-backed panels, e.g. `definePanel({ changedOn, update })` or `defineResourceView(...)`.
- Let DOM views subscribe to `Changed(DashboardStats)`/`Changed(ChartSeries)` without requiring the component to be attached to a list-rendered entity.
- Provide examples for aggregate views that are common in dashboards: KPI cards, alarm summaries, sparkline charts, and detail panes.

### 9. External feed tests need timing and pressure benchmarks

The behavioral test proves that a 500-update batch is not dropped and is projected once. It does not prove that the browser remains responsive at sustained 500 updates/second, nor does it measure event-buffer size, projection time, DOM update count, or query count.

Suggestion:

- Add a dashboard benchmark harness: sustained 500 updates/s for N seconds with 400 vehicles, 50 virtual rows, and 500 map pins.
- Track event ingestion time, projection time, DOM create/update/destroy counts, query count, and heap growth.
- Make the benchmark headless by default for CI, with an optional browser profile for renderer costs.

## What worked well

- Event systems were a natural fit for WebSocket-style telemetry ingestion.
- Reactive systems coalesced hundreds of value mutations into one projection pass.
- Transient projection components kept UI state out of snapshots.
- DOM rendering was a good fit for sortable tables, chart bars, alarm text, and drill-down panels.
- Multi-view projection remained natural: a vehicle can appear as a map pin, table row, alarm item, chart aggregate, and detail pane without changing the core entity schema.
