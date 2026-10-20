# Record change marks only where something can read them

_Design spec for PLAN WS-5 A2.6, revision 2, written 2026-10-20 before any
code. Revision 1 claimed reader equivalence too broadly; Codex's review
(Reqall #9206) found eight holes, each with a reproduced trace, and this
revision closes them (see "Review log"). When it ships, the normative rules
move into SPEC §2.9 and §7.1 and this file is deleted. Until then SPEC.md
governs._

## Why

Every mark (`markChanged`, a component add or removal, `despawn`) writes a
stamp into a per-type map, `name → entity → stamp` (`change-log.ts`
`put`). That `Map.set` is paid even when no reader filters on the type, which
is the common case. Apps mark defensively, and many marked types are only
read by plain `Has` queries.

What it costs, measured on a fresh build (`pnpm bench`, 2026-10-20):

- The headless windowed workload marks `Row` every tick with no change
  reader. It runs at 1.43× Koota p95, and Koota pays nothing for an unread
  `set`.
- With a reader (the like-for-like soak headline) the marks are needed, so
  **this change does not move the soak headline**. It removes cost only
  where nobody reads.

Koota's `changeDetection: 'auto'` makes the same trade.

## Step 0: measure the upside before building it

The exact design below is not small. Before any of it is built, an
**unsafe** prototype that simply drops marks of unwatched pairs measures the
ceiling under the frozen bench protocol: the headless windowed workload, plus
a new unread-marks workload (N entities, every one marked each tick, no
reader). **If the ceiling is under a 15% p95 improvement on both, this spec
is shelved** and the mark path is optimized in place instead (A1).

**Step 0 result (2026-10-20, i9-11900H, Node 26.7, 7 paired trials).** An
unsafe prototype dropped every mark of the unread type:

- Headless windowed: 0.997× (CI 0.96–1.11). There is no gain, because the
  windowed cost is not in the marks.
- Soak with no change reader (5,000 entities marked per tick): 0.77× (CI
  0.67–0.84), about a 23% ceiling.

The gate passes on the unread-marks workload only. Next step: port the A1
overhead cuts first, re-measure this ceiling on the post-A1 baseline, and
build the design only if it still clears 15% there.

## Definitions

- **Change node:** an `OnAdded(T)`, `OnChanged(T)` or `OnRemoved(T)` node.
- **Reader:** a registered system (`query` and `reactsTo`), a live
  `world.query(...)`, a DOM view gate (redraw and failure-retry queries), or
  an `observe()` system.
- **Dependencies of a reader:** every `(kind, T)` of every change node in its
  trees, found by an exhaustive walk through `And`, `Or`, `Not` and `Where`,
  including nodes under `Not`. (The O-54 `watchMarks` driver picks one
  candidate per query and is **not** this registry.)
- **Watched:** `(kind, T)` while at least one registered reader depends on
  it. Disabled, paused, sub-rate and idle `event` systems are registered, so
  they keep their pairs watched. A `once` system stops watching when it has
  run: it can never read again, and SPEC §7.1 already says a `once` system
  that has run is not a reader. Its pairs then follow rule 8 (lazy
  unwatch), even though its compiled queries are not disposed. A live
  query keeps its pairs until disposed.
- **Grace window:** the stamps after `lastTickEndSeq`, the end of the last
  completed full tick. A heartbeat (`step(0)`, §4.0) and a tick that throws
  are not completed full ticks.

## Rules

A `(kind, T)` pair is in exactly one of two states.

- **Materialized:** its stamp map is authoritative, as today.
- **Buffered:** it has no stamp map. Its marks since `lastTickEndSeq` live
  in the grace buffer.

Every pair starts buffered.

1. **Registered query trees are frozen.** Registration deep-clones and
   freezes the normalized tree. Today `QueryNode` is mutable and a reader
   keeps evaluating the caller's object, so mutating a registered tree can
   add a dependency after its history was discarded (review trace 1). This
   is a compatibility decision: mutating a registered tree stops having any
   effect. Note it in the CHANGELOG.
2. **Watched pairs are materialized; marks to them work as today.**
3. **Marks to buffered pairs go to the grace buffer.** The mark gets its
   stamp from the same counter. It is appended to parallel arrays
   `[stamp, kind, name, entity]`, so appending allocates nothing while
   capacity lasts. A component removal (today's `forget`) deletes the
   entity's added and changed stamps **immediately** in every materialized
   map of that name. If a pair of that name is buffered, it also appends a
   kind-specific deletion entry, one for `added` and one for `changed`.
4. **Adoption.** When a buffered pair becomes watched (a reader is
   registered, including one registered from inside a system), it is
   materialized. Its buffered entries are folded in stamp order into a fresh
   map: a put sets the stamp, and a deletion of that kind deletes it. A pair
   is adopted only from the buffered state, so adoption never merges into or
   overwrites a newer materialized map (review trace 3). A new reader's
   window starts at `lastTickEndSeq` (SPEC §2.9, unchanged), and every mark
   it can report is in the folded map.
5. **Removal logs are per name.** Today removals go into one global,
   stamp-ordered log that `removedInWindow` binary-searches and
   `pruneRemoved` consumes from the front. Appending adopted (older) stamps
   to it breaks that order (review trace 2). Instead each name keeps its own
   stamp-ordered removal log. Adopted entries are older than any later mark
   of that name, so each log stays ordered. `removedInWindow` reads the logs
   of the names asked for, and pruning runs per log.
6. **The buffer is bounded.** When the buffer exceeds twice its folded size
   plus 1024 entries, it is compacted in place to one entry per
   `(kind, name, entity)` (the latest put, or a deletion), in stamp order.
   That is amortized O(1) per mark, with memory proportional to the distinct
   pairs marked in the grace window, the same bound today's maps have. This
   matters for long heartbeat-only or between-tick streams, which never
   empty the buffer (review trace 8).
7. **The buffer empties at each completed full tick.** Once
   `lastTickEndSeq` passes every buffered stamp, no new reader can see them,
   so the buffer is reset (length 0, capacity kept). Heartbeats and throwing
   ticks do not empty it. Cleanup runs after the tick's `finally`, on
   success only.
8. **Unwatching is lazy.** When a pair loses its last reader it stays
   materialized until the end of the next completed full tick. Then, if it
   is still unwatched, its map is dropped and it becomes buffered with an
   empty buffer. A reader registered in between finds every mark since
   `lastTickEndSeq` in the map.
9. **Restore.** `decode` materializes every pair it carries marks for, as
   unwatched, under rule 8. Named systems registered after a restore can
   take a pending cursor from before `lastTickEndSeq` (`pendingCursors`,
   SPEC §7.1, review trace 5). Pending cursors expire at the end of the next
   completed full tick, which is exactly when rule 8 would drop those maps,
   so every carried mark a pending cursor can claim is still there.
10. **Resource marks are unchanged.** There is one stamp per resource name.

## Snapshots

- `snapshot()` carries a mark only if its pair is read by some **system**
  cursor that has not seen it: added/changed marks under the ordinary floor,
  removal marks under `removedFloor` (for `OnRemoved` readers), as today. The
  difference from today is the pair filter. Today `encode` takes one floor
  across all cursors and carries every mark above it, of every type. `seen`
  ranks are computed after filtering.
- Buffered marks are never carried, because no system reads a buffered pair
  (rule 2). Revision 1 carried them, and that contradicted its own
  restore-then-snapshot promise (review trace 6).
- Restore then snapshot: decoded pairs are materialized (rule 9), so a
  snapshot taken before the next completed tick re-encodes every carried
  mark that a system in the restored world reads. Marks an older engine
  carried for pairs no system reads are dropped on that re-encode.
- The format and `SNAPSHOT_VERSION` do not change. Only `changes.marks` can
  be shorter.

## Equivalence (what must hold)

Take any operation trace: registrations, disposals, marks, adds, removes,
despawns, steps, heartbeats, throwing ticks, snapshots, restores and query
reads. Every reader (systems, live queries, views, observers, including
readers registered mid-tick, from inside a system, between ticks or after a
restore) reports the same entities in the same order as under a
record-everything engine. Two conditions apply:

- No code mutates a registered query tree. Rule 1 makes that a no-op.
- No code's decisions depend on the contents of `snapshot.changes`, for
  example a plugin's `onSnapshot` copying `changes.marks.length` somewhere
  (review trace 7). That field is the one output that intentionally
  differs.

How it is verified:

- **Deterministic tests first,** one per review trace:
  1. a mutated tree (now a no-op);
  2. adopted removals interleaved with a live removal reader across a
     heartbeat;
  3. add, remove, re-add, then a watched change while an older buffered
     add awaits adoption;
  4. `Not`, `Or` and multi-leaf `And` dependencies;
  5. restore, heartbeat, a named registration, then a full tick;
  6. the restore-then-snapshot round trip;
  7. a long heartbeat-only stream (bounded memory).
- **Then differential tests.** A test-only `recordAll` switch keeps today's
  behavior. Seeded random traces (~10k) cover everything above. Every
  reader's output at every read must match, and so must `restore(snapshot())`
  continuations under the same systems.
- **Bench:** step 0's ceiling, then the shipped version under the frozen
  protocol. It must improve the windowed and unread-marks workloads, and must
  not regress the like-for-like soak beyond its CI.

## Versioning

**Minor** release, with a CHANGELOG note for each of:

- registered query trees are frozen (rule 1);
- `changes` can be shorter, and legacy snapshots' marks for pairs no system
  reads are dropped on re-encode.

Reader results are unchanged under the conditions above.

## Out of scope

- Value-diff detection (Koota's `'always'`). Marks stay explicit (I-2).
- Watching individual fields rather than types.
- Changing what a reader reports. Any rule that would change a reader's
  results is a different proposal.

## Review log

- **Revision 1** was reviewed by Codex (Reqall #9206). It found:
  1. registration bypass through mutable query trees;
  2. removal replay breaking the global log order;
  3. name-wide `forget` replay deleting newer marks;
  4. the O-54 watcher mistaken for a reader registry;
  5. restored cursors starting before the grace window;
  6. self-contradictory snapshot rules;
  7. unrestricted snapshot consumers;
  8. an unbounded buffer.
- **Revision 2** answers them with rules 1, 5, 3–4, the exhaustive dependency
  walk, rule 9, the system-pair snapshot filter, the equivalence conditions
  and rule 6, in that order. It also adds step 0, the shelve-if-small gate.
