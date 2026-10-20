# Record change marks only where something can read them

_Design spec for PLAN WS-5 A2.6, written 2026-10-20 before any code. When it
ships, the normative rules move into SPEC §2.9 and §7.1 and this file is
deleted. Until then SPEC.md governs._

## Why

Every mark (`markChanged`, a component add or removal, `despawn`) writes a
stamp into a per-type map, `name → entity → stamp` (`change-log.ts`
`put`). That `Map.set` is paid even when no system, live query, view or
observer filters on the type, which is the common case. Apps mark
defensively, and many marked types are only read by plain `Has` queries.

What it costs, measured on a fresh build (`pnpm bench`, 2026-10-20):

- The headless windowed workload marks `Row` every tick with no change
  reader. It runs at 1.43× Koota p95, and Koota pays nothing for an unread
  `set`.
- Profiles of the soak with no reader put `put`/`markChanged` at the top of
  self time. With a reader (the like-for-like headline) the marks are needed,
  so **this change does not move the soak headline**. It removes cost only
  where nobody reads.

Koota's `changeDetection: 'auto'` makes the same trade: it diffs a trait
only while something subscribes to it.

## Definitions

- **Change node:** an `OnAdded(T)`, `OnChanged(T)` or `OnRemoved(T)` node in
  a query.
- **Reader:** anything that evaluates change nodes against a window. That
  means a system's `query` or `reactsTo`, a live `world.query(...)`, a DOM
  view's redraw gate (`changedOn`), and the `__observe_N` systems behind
  `observe()`.
- **Watched:** `(kind, T)` is watched while at least one registered reader
  has a `kind` node on `T`. A disabled system, a paused `tick`/`fixed`
  system, a sub-rate `fixed` system between steps, and an `event` system
  with no events are all still registered, so they keep the pair watched.
  A `once` system stops watching after it runs. A live query stops
  watching when disposed.
- **Grace window:** the stamps after `lastTickEndSeq`, the end of the last
  completed full tick. A heartbeat (`step(0)`, §4.0) is not a completed tick.

## Rules

1. **Watched marks are recorded as today.** Nothing changes for a
   `(kind, T)` pair that is watched when the mark is made.
2. **Unwatched marks go to the grace buffer.** A mark of an unwatched pair
   gets its stamp from the same counter, so order is global as before. It
   is appended to a per-world buffer instead of the stamp map:
   `[stamp, op, kind, name, entity]` in parallel arrays, so appending
   allocates nothing after warmup. `forget` (a component removed, which
   drops its added/changed marks) is buffered as an op too, for names that
   have buffered marks.
3. **A new reader adopts the buffer.** When a pair becomes watched (a
   system, query, view or observer registered), the buffered ops for that
   pair are replayed into the stamp maps in stamp order, `put` and `forget`
   alike, with their original stamps. The new reader's window starts at
   `lastTickEndSeq` (SPEC §2.9, unchanged), so it reports exactly the marks
   it reports today.
4. **The buffer empties at each completed full tick.** When a tick ends,
   `lastTickEndSeq` advances past every buffered stamp. No reader created
   later can see those marks, so they are dropped (`length = 0`, keeping
   capacity). Heartbeats do not empty the buffer.
5. **Unwatching is lazy.** When a pair stops being watched, its stamp map
   is kept until the end of the next completed full tick, then cleared if
   the pair is still unwatched. A reader registered in between still finds
   every mark since `lastTickEndSeq`.
6. **Removal marks follow the same rules.** An unwatched `OnRemoved` pair
   buffers its removal marks, and rule 3 adopts them. Retention for watched
   pairs is unchanged: kept until every `OnRemoved` reader has seen them.
7. **Resource marks are unchanged.** `resourceStamps` is one entry per
   resource name, not per entity, so it is not worth the bookkeeping.

## Snapshots and restore

- `snapshot()` carries the marks of a *watched* pair that some system
  cursor has not seen (the rule today), plus the grace buffer's marks that
  are later than some system cursor. The marks keep the same
  `[kind, name, entity]` form, so the format and `SNAPSHOT_VERSION` do not
  change.
- Today `encode` takes one floor across all cursors and carries every mark
  above it, whatever its type. That carries marks of types no system
  reads, which no reader in a restored world with the same systems (the
  restore contract, §7.1) can ever report. Under this spec those marks are
  not carried. **Snapshots get smaller, and reader results are identical.**
- `restore()` (`decode`) records every carried mark in the stamp maps,
  watched or not, as today ("Restore keeps every carried mark"). So the
  restored world's next snapshot, taken before any tick, carries what the
  live world's would. Rule 5 clears unwatched maps after the next completed
  tick, in the live and restored worlds alike.

## Equivalence (what must hold)

For any program (registrations, marks, adds, removes, despawns, steps,
heartbeats, snapshots, restores, query reads), every reader reports the same
entities in the same order as in a world that records every mark. That
covers systems, live queries, views and observers, and readers registered
mid-tick, between ticks, or after a restore. The only observable difference
is the `changes` field of a snapshot, which may list fewer marks.

How it is verified:

- **Differential tests.** A test-only `recordAll` switch keeps today's
  behavior. Seeded random programs (~10k, including all the cases above)
  run against both modes. Every reader's output at every read must match,
  and so must `restore(snapshot())` round trips under the same systems.
- **Targeted tests** for each rule: a reader registered mid-tick sees the
  marks since the tick start; a reader registered after a heartbeat sees
  marks from before it; remove followed by re-add replays `forget` in order
  (no stale `OnChanged`); a disabled reader keeps its type watched; lazy
  unwatch; snapshot bytes for unread types.
- **Bench.** The frozen protocol (`bench/README.md`). It must improve the
  headless windowed workload, and an added unread-marks workload, and must
  not regress the like-for-like soak beyond its CI.

## Versioning

Reader-visible behavior is unchanged. Snapshot output changes: `changes`
can be shorter, so a test that compares snapshot JSON across engine versions
sees a difference. That is a **minor** release with a CHANGELOG note. It is
not a patch, because snapshot output is part of what apps persist and diff.

## Out of scope

- Value-diff detection (Koota's `'always'`). Marks stay explicit (I-2).
- Watching individual fields rather than types.
- Changing what a reader reports. Any rule that would change a reader's
  results is a different proposal.
