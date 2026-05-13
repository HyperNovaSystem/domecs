# DOMECS Findings — Tessera Exemplar

Notes from fleshing out `tessera_game`, based on exemplar #4 in `doc/exemplars.md`.

## Summary

The current DOMECS slice is expressive enough for a deterministic board game: headless worlds, event-delivered commands, explicit PRNG state in snapshots, transient UI components, DOM views, and `Changed(Component)` queries all worked. Tessera also exposed rollback/history and reactive-system ergonomics that should be tightened before v1.

## Findings

### T-1: Reactive systems need clearer `ctx.entities` behavior

A reactive system with `reactsTo: Changed(Piece)` did not receive those entities in `ctx.entities` unless the same query was also supplied as `query: Changed(Piece)`. That is internally consistent with the current scheduler, but surprising for exemplar code.

Suggestion: either document the pattern prominently or make reactive systems default `ctx.entities` to `reactsTo` when `query` is omitted.

### T-2: Snapshot timing matters for per-move history

Recording a snapshot inside the command event system missed downstream reactive changes (`EvalStats` from `Changed(Piece)`). Recording at `tickEnd` captured the full committed move.

Suggestion: provide/document a post-tick snapshot hook or turn helper for board games: command accepted → all event/reactive systems settle → snapshot recorded exactly once.

### T-3: Event buffers are not rollback state

Core `world.snapshot()` does not include pending/current event buffers. Tessera avoids the issue by treating the accepted move log as durable game state and by not leaving authoritative events pending across undo/redo.

Suggestion: for rollback-safe games, document that durable command logs must be components/resources or extend snapshots with an event-buffer plugin hook.

### T-4: Replay protocols should avoid raw entity ids

Tessera move commands use entity ids and remain deterministic because initial spawn order is stable. Networked play would be safer with stable domain ids (`owner,index`) independent of ECS allocation details.

Suggestion: add exemplar guidance for stable application ids in replay/network commands, with helper resolution tables kept out of hot systems.

### T-5: Snapshot history wants a first-class ring/list utility

The exemplar hand-rolls `history.snapshots`, `cursor`, undo, redo, branch truncation, and replay rebuild. This is exactly the board-game/editor overlap called out by the exemplars.

Suggestion: ship or document a snapshot history/ring utility that supports per-turn snapshots, branch truncation, JSON export, and optional diff compression.

### T-6: Command-time clocks are deterministic but need policy support

Tessera models tournament clock consumption as command payload data (`spentMs`) so rules never read wall-clock time. This keeps replay deterministic, but authority/trust policy is application-specific.

Suggestion: document deterministic clock patterns: local trusted, server-authoritative, and adjudicated network clocks.

### T-7: Turn/action APIs should return an acceptance result

The browser and tests determine whether a command was accepted by comparing `moveLog.length` before and after `world.turn(...)`. That keeps the rules deterministic, but it is a clumsy application-level convention and makes rejected-command UX depend on reading a mutable component (`GameState.lastError`).

Suggestion: add or document a turn-command helper that returns `{ accepted, reason, events, snapshot? }` after the command tick settles. Board games and roguelikes both need the validate/apply/consume-turn distinction.

### T-8: Stable lookup tables want a resource pattern

Tessera keeps `cellByKey`, `cellIds`, and `pieceIds` in closure/controller state rather than ECS components. This is acceptable because the board is generated deterministically and no cells/pieces are despawned, but rollback-heavy games often need stable lookup tables that are neither components nor DOM state.

Suggestion: define a snapshot-safe world resource pattern for deterministic indexes (`resource(BoardIndex)`) or document how apps should rebuild indexes after `restore()`.

### T-9: Snapshot equality needs a canonical helper

Determinism tests compare `JSON.stringify(world.snapshot())`. That works only because entity/component insertion order is stable in this implementation. A richer engine with plugin snapshot hooks, resource snapshots, or migration metadata could accidentally make semantically identical snapshots differ by key ordering.

Suggestion: provide a canonical snapshot serializer/hash for determinism and replay tests.

### T-10: DOM view updates do not cover purely local UI state

Selection highlighting in the browser shell is transient local state, not a component. The app therefore manually reapplies selection CSS after undo/redo/heartbeat. That is the right separation for authoritative game state, but the renderer has no documented pattern for non-authoritative view state that still affects entity views.

Suggestion: document local UI-state projection patterns: transient components when state should be in the world, controller-side repaint hooks when it should not, and how each interacts with snapshot/restore.

## What worked well

- `createWorld({ headless: true })` and `world.turn(...)` were a natural fit for board-game rules.
- `world.snapshot()`/`restore()` produced hermetic state suitable for undo/redo and replay verification.
- Transient UI state stayed out of snapshots.
- DOM views over all board cells/pieces were simple; unlike Harbor/Halls, Tessera wants the whole board rendered.
- Explicit `markChanged(Piece)` plus `Changed(Piece)` was useful for a headless AI-evaluation delta path.
