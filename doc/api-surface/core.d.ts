// file: agent.d.ts
/**
 * Thin agent operability facade (PLAN WS-3).
 *
 * Wraps existing world APIs — no new runtime semantics. Agents (and UIs)
 * share one loop: observe → act → step → snapshot, with reset for episodes.
 */
import type { EventType } from './events.js';
import type { WorldManifest } from './manifest.js';
import type { SnapshotOptions, WorldSnapshot } from './snapshot.js';
import type { ActionOptions, ActionResult, World } from './world.js';
/** Options for {@link createAgentBridge}. */
export interface AgentBridgeOptions {
    /**
     * Snapshot used by {@link AgentBridge.reset}. When omitted, a baseline is
     * captured from `world` at construction time (after any setup the caller
     * has already performed).
     */
    baseline?: WorldSnapshot;
}
/**
 * Compact observation for agent control loops.
 * `manifest` is the shipped {@link World.describe} surface — nothing new.
 */
export interface AgentObservation {
    readonly tick: number;
    readonly scale: number;
    readonly entityCount: number;
    readonly manifest: WorldManifest;
}
/**
 * Minimal bridge: `reset / observe / act / step / snapshot`.
 * All methods are thin wrappers over {@link World}.
 */
export interface AgentBridge {
    /** The underlying world — escape hatch for setup systems and queries. */
    readonly world: World;
    /**
     * Restore the baseline snapshot. Systems, plugins, and type definitions
     * remain; entity/resource state returns to the baseline.
     *
     * Not restored (the snapshot does not carry them): `time.scale` and
     * input state. An episode that ends paused/rescaled or with stale
     * `setInput` data carries that into the next episode — restore them
     * explicitly at episode boundaries if your episodes touch either.
     *
     * Entity-id assignment is stable across `reset()`: the snapshot carries
     * the id cursor (O-38), so ids assigned after a restore match ids the
     * live world would have assigned. Pending events are discarded by
     * `restore()`, so an abandoned episode's events never fire into the next.
     */
    reset(): void;
    /** Replace the baseline with a snapshot of the current world state. */
    captureBaseline(): void;
    /** Observe tick/scale/entity counts plus {@link World.describe}. */
    observe(): AgentObservation;
    /** Typed command boundary — delegates to {@link World.action}. */
    act<T>(type: EventType<T>, payload: T, opts?: ActionOptions): ActionResult;
    /**
     * Advance simulation. Omit `dt` for turn-based {@link World.stepOnce};
     * pass a positive `dt` for {@link World.step} (required for `fixed`
     * systems).
     *
     * `step(0)` (or a negative dt) is NOT `step()`: an explicit non-positive
     * dt is the F-6 heartbeat — no systems run, no change-detection swap. A
     * computed dt that rounds to 0 therefore silently advances nothing;
     * guard the call site if that would be a bug.
     */
    step(dt?: number): void;
    /** Capture a plain-data snapshot — delegates to {@link World.snapshot}. */
    snapshot(options?: SnapshotOptions): WorldSnapshot;
}
/**
 * Create an agent bridge over an existing world.
 *
 * Typical episode loop (the reset() before the first episode is boundary
 * hygiene — every episode then starts from the identical restored state):
 * ```ts
 * const bridge = createAgentBridge(world)
 * bridge.reset()
 * const obs = bridge.observe()
 * const result = bridge.act(Cmd, { ... })
 * bridge.step() // or bridge.step(1/60) for fixed schedules
 * const snap = bridge.snapshot()
 * ```
 */
export declare function createAgentBridge(world: World, opts?: AgentBridgeOptions): AgentBridge;

// file: change-log.d.ts
import type { Entity } from './types.js';
/**
 * O-42: change detection by change windows (SPEC §2.9).
 *
 * Every mark — a component added, changed or removed, a resource changed —
 * gets a stamp from one increasing counter. A change-detection filter
 * reports the marks whose stamp falls in its reader's window `(from, to]`:
 * for a system, from the end of its previous run to the start of this one;
 * for any other live query, from the last tick it was read up to the read.
 * Nothing is reset at tick boundaries, so a mark is never lost to a reader
 * that ran earlier in the tick than the writer.
 *
 * Added/changed stamps are kept per (type, entity) and dropped when the
 * component goes away. Removal stamps outlive the entity, so they are
 * pruned once every reader of an `OnRemoved` filter has seen them.
 */
export type MarkKind = 'added' | 'changed' | 'removed';
/** A reader's change window: marks stamped in `(from, to]` are reported. */
export interface ChangeWindow {
    readonly from: number;
    readonly to: number;
}
/**
 * Snapshot form of the marks some system had not seen yet (O-42), so a
 * restored world reports them exactly as the live one would. Marks are in
 * stamp order; `seen[name]` is how many of them that system had already
 * seen. Systems absent from `seen` had seen them all.
 */
export interface ChangesSnapshot {
    readonly marks: ReadonlyArray<readonly ['added' | 'changed' | 'removed', string, Entity] | readonly ['resource', string]>;
    readonly seen: Readonly<Record<string, number>>;
}
/** One change-detection reader for snapshot encoding: a system's cursor. */
export interface ChangeCursor {
    /** The system's name, made unique by occurrence (`name#1`, …) on a clash. */
    readonly name: string;
    readonly seenThrough: number;
    /** The system reads `OnRemoved`: removal marks are carried for it. */
    readonly readsRemovals: boolean;
}
export type ChangeLog = ReturnType<typeof createChangeLog>;
export declare function createChangeLog(): {
    readonly seq: number;
    mark: (kind: MarkKind, name: string, entity: Entity) => void;
    forget: (name: string, entity: Entity) => void;
    markResource: (name: string) => void;
    has: (kind: MarkKind, name: string, entity: Entity, w: ChangeWindow) => boolean;
    /**
     * The stamp maps, name → entity → stamp, for the per-entity hot path
     * (world.ts evalEntity), which compares against its read window inline.
     */
    stamps: Readonly<Record<MarkKind, ReadonlyMap<string, ReadonlyMap<Entity, number>>>>;
    resourceChanged: (name: string, w: ChangeWindow) => boolean;
    removedInWindow: (names: ReadonlySet<string>, from: number, to: number) => Entity[];
    markedInWindow: (kind: "added" | "changed", name: string, from: number, to: number, limit: number) => Entity[] | null;
    watchMarks: (kind: "added" | "changed", name: string) => () => void;
    pruneRemoved: (horizon: number) => void;
    clear: () => void;
    encode: (cursors: readonly ChangeCursor[]) => ChangesSnapshot | undefined;
    decode: (snap: ChangesSnapshot | undefined) => {
        base: number;
        count: number;
    };
};

// file: component.d.ts
import type { ComponentOptions, ComponentSchema, ComponentType } from './types.js';
export interface InternalComponentType<T, Name extends string = string> extends ComponentType<T, Name> {
    readonly __tag: symbol;
    readonly __defaults: Partial<T> | undefined;
    readonly __transient: boolean;
    readonly __validate: ((value: T) => true | string) | undefined;
    readonly __schema: ComponentSchema | undefined;
}
/**
 * Define a component type carrying a payload `T`, keyed by `name`.
 *
 * Two overloads are intentionally kept. The first uses `const Name extends
 * string` to capture the literal name (so `view.Position` is typed when the
 * literal is known at the call site); the second widens to `string` for cases
 * where the name is a runtime value. TypeScript cannot express "infer the
 * literal when available, else widen" in a single signature, so the `Name`
 * type parameter is necessarily duplicated across the two overloads — a known
 * language limitation, not redundancy to be collapsed.
 */
export declare function defineComponent<T, const Name extends string>(name: Name, options?: ComponentOptions<T>): ComponentType<T, Name>;
export declare function defineComponent<T>(name: string, options?: ComponentOptions<T>): ComponentType<T, string>;
export declare function internal<T>(type: ComponentType<T>): InternalComponentType<T>;

// file: driver.d.ts
/**
 * F-5: thin rAF driver. Every browser exemplar was hand-rolling dt-clamp /
 * first-frame priming / visibility-pause logic; owning it here gives one
 * place to fix that mis-tune.
 *
 * The driver owns all rAF bookkeeping (handle, wall-clock reference,
 * visibility handler, wake flag). World behaviour is injected through
 * {@link DriverHooks} so this module never reaches back into world state.
 */
/** Structural twin of `StartOptions` (declared in world.ts, the public surface). */
export interface DriverStartOptions {
    dtClampMs?: number;
    pauseOnHidden?: boolean;
}
export interface DriverHooks {
    /** Advance the world by dt seconds (wall-clock gap, already clamped). */
    step(dt: number): void;
    pause(): void;
    resume(): void;
    /** Whether the world is currently paused (`time.scale === 0`). */
    isPaused(): boolean;
    /** Idle policy: keep scheduling frames while this returns true. */
    shouldKeepAwake(): boolean;
    /** Mutations made by systems mid-tick must not re-arm the driver. */
    isInTick(): boolean;
}
export interface RafDriver {
    startLoop(options?: DriverStartOptions): () => void;
    stop(): void;
    wake(): void;
    /**
     * Wake a sleeping idle loop for one heartbeat frame — `step(0)`: plugin
     * hooks and render, no tick (O-48). Upgraded to a normal wake step if
     * {@link wake} is called before the frame runs.
     */
    repaint(): void;
}
export declare function createRafDriver(opts: {
    idle: boolean;
    headless: boolean;
}, hooks: DriverHooks): RafDriver;

// file: errors.d.ts
/**
 * Closed core error union, plugin error namespacing, and the system fault
 * contract returned by user systems. Discipline lives in doc/BETTER_ERRORS.md.
 */
import type { Entity } from './types.js';
import type { JsonValue, Result, SerializedError } from './result.js';
export type SystemId = string;
export type ComponentId = string;
export type EventId = string;
/**
 * Closed discriminated union owned by `@domecs/core`. Plugin APIs compose
 * their own error unions with {@link PluginError} rather than mutating
 * this union — see {@link PluginResult}.
 *
 * `migration_failed` carries `recoverable: boolean` so userland can choose
 * to retry / partial-load. `event_handler_threw` is for an explicit
 * framework-owned isolation point; it is NOT a blanket promise that every
 * user `throw` becomes recoverable data.
 *
 * `retryable` signals whether the failure is transient (true — the same
 * operation could succeed on a subsequent attempt) or deterministic (false —
 * retrying without fixing the root cause will always fail).
 *
 * Retryability rationale per variant:
 * - plugin_install_failed: false — install contracts are deterministic; a bad
 *   return/throw won't fix itself without code changes.
 * - persist_io: usually true — storage backends can have transient outages
 *   (disk full briefly, network blip); a retry is worth attempting. False
 *   when the failure is deterministic: `load()` on an empty slot (O-28)
 *   stays empty until something is saved — boot paths should use
 *   `loadIfPresent` instead of retrying. Always consult the `retryable`
 *   field; do not hard-code by kind.
 * - migration_failed: false — a missing migrator or non-advancing version will
 *   always fail; code changes are required. (The existing `recoverable` field
 *   is distinct: it signals whether partial-load is safe, not retry-ability.)
 * - schema_mismatch: false — a type drift is deterministic until the schema or
 *   stored values are corrected.
 * - query_invalid: false — malformed query structure will always be rejected.
 * - event_handler_threw: true — handler may have hit transient state; a retry
 *   on re-emit could succeed.
 */
/** Closed union — adding a variant is a breaking change. */
export type DomecsError = {
    kind: 'plugin_install_failed';
    plugin: string;
    cause: SerializedError;
    retryable: boolean;
} | {
    kind: 'persist_io';
    op: 'save' | 'load';
    cause: SerializedError;
    retryable: boolean;
} | {
    kind: 'migration_failed';
    from: number;
    to: number;
    reason: string;
    recoverable: boolean;
    retryable: boolean;
} | {
    kind: 'schema_mismatch';
    component: ComponentId;
    expected: string;
    got: string;
    retryable: boolean;
} | {
    kind: 'query_invalid';
    reason: string;
    retryable: boolean;
} | {
    kind: 'event_handler_threw';
    event: EventId;
    cause: SerializedError;
    retryable: boolean;
};
/** All valid `DomecsError` kind literals, in source order. */
export declare const ERROR_KINDS: readonly ["plugin_install_failed", "persist_io", "migration_failed", "schema_mismatch", "query_invalid", "event_handler_threw"];
export type ErrorKind = (typeof ERROR_KINDS)[number];
/** Returns `true` when `k` is a known `DomecsError` kind literal. */
export declare function isKnownDomecsErrorKind(k: string): k is ErrorKind;
/**
 * Returns a non-empty, actionable repair hint for a given {@link DomecsError}.
 * Intended for developer consoles, inspector UIs, and error reporting tools.
 * Built on {@link match} for compile-time exhaustiveness — adding a variant
 * to the union breaks this until a case is supplied.
 */
export declare function getErrorRepairHint(e: DomecsError): string;
/**
 * Render a {@link DomecsError} as a single human-readable line for logs,
 * toasts, and inspector UI. Built on {@link match}, so adding a variant to
 * the union breaks this at compile time until a case is supplied — no
 * silent `[object Object]` fallthrough. Pairs with `tapErr`:
 * `tapErr(world.use(p), (e) => console.warn(describeError(e)))`.
 */
export declare function describeError(e: DomecsError): string;
/**
 * Template-literal constraint forces plugin error kinds to carry a
 * `PluginName/` prefix, eliminating silent cross-plugin collisions when
 * two plugins independently choose the same short label (e.g. `'timeout'`).
 * The prefix should reuse {@link Plugin.name}, which the dependency
 * resolver already requires to be unique within a world.
 */
export interface PluginError {
    kind: `${string}/${string}`;
}
/**
 * Composition helper for plugin-exposed services: a `Result` whose error
 * channel is `DomecsError` unioned with the plugin's own namespaced
 * variants. Keeps `match` exhaustive at the call site without growing the
 * core union.
 */
export type PluginResult<T, E extends PluginError = never> = Result<T, DomecsError | E>;
/**
 * A single fault returned from a system. `entity` absent ⇒ systemic
 * (routes to the world error stream rather than attaching `Faulted`).
 *
 * `error.kind` is the structural label and is copied into the resulting
 * `FaultEntry.kind`; the rest of the error payload is normalized into
 * `FaultEntry.detail` by the scheduler.
 */
export interface SystemFault<E extends {
    kind: string;
} = DomecsError> {
    entity?: Entity;
    component?: ComponentId;
    error: E;
    recoverable: boolean;
    /** When `true`, re-running the fault-raising operation is safe to attempt multiple times. */
    idempotent?: boolean;
}
/**
 * Return type for systems that participate in the Result contract.
 * Returning `void` (the common ergonomic case) is treated as success.
 */
export interface SystemResult<E extends {
    kind: string;
} = DomecsError> {
    errors?: readonly SystemFault<E>[];
}
/**
 * One row in the `Faulted` buffer. The scheduler builds this from a
 * returned `SystemFault` — system authors never construct it directly.
 */
export interface FaultEntry {
    kind: string;
    /** JSON-safe projection of the originating `SystemFault.error` payload,
     * produced by `toJsonValue` (see `result.ts`): a {@link JsonValue} tree with
     * non-serializable leaves stringified and recursion bounded by
     * `MAX_CAUSE_DEPTH`. Absent when the fault carried no payload beyond
     * its `kind`. */
    detail?: JsonValue;
    source: SystemId;
    tick: number;
    component?: ComponentId;
    recoverable: boolean;
}
/** Systemic fault forwarded to the world error stream. */
export interface SystemicFault {
    source: SystemId;
    tick: number;
    entry: FaultEntry;
}

// file: events.d.ts
import type { ComponentSchema, FieldSchema } from './types.js';
/**
 * Per-event nominal-identity tag. Stored on every `EventType` returned by
 * `defineEvent`; the bus keys all internal maps on this symbol so distinct
 * `defineEvent('Same')` calls never collide. F-8.
 */
export declare const eventTag: unique symbol;
export interface EventType<T> {
    readonly name: string;
    readonly [eventTag]: symbol;
    readonly __t?: T;
}
/** Options for {@link defineEvent}. */
export interface EventDefOptions {
    /**
     * Optional payload field-schema for reflection, reusing the component
     * {@link ComponentSchema} vocabulary so tooling renders an event payload the
     * same way it renders a component.
     */
    readonly schema?: ComponentSchema;
}
/** Internal view of an {@link EventType} carrying its optional payload schema. */
export interface InternalEventType<T> extends EventType<T> {
    readonly __schema?: ComponentSchema;
}
export declare function defineEvent<T>(name: string, options?: EventDefOptions): EventType<T>;
export declare function internalEvent<T>(type: EventType<T>): InternalEventType<T>;
/**
 * O-39: shallow payload validation against an event's declared schema, used
 * by `world.action()` so the typed command boundary rejects malformed
 * commands instead of accepting them as no-ops. Only applies when the event
 * was defined with `{ schema }` — schema-less events stay unvalidated.
 *
 * Rules (FieldSchema carries no required-marker, so absence is optional):
 * - payload must be a plain object
 * - keys not declared in the schema are rejected (catches typo'd fields)
 * - declared keys, when present, must match their `kind` (`enum` must be a
 *   member of `options`); `unknown` accepts anything
 *
 * @returns `null` when valid, else a human-readable reason fragment.
 */
export declare function validateEventPayload(type: EventType<unknown>, payload: unknown): string | null;
/**
 * Result of `world.describeEvent(type)`. `fields` is the declared
 * `schema.fields` when present (`fieldsSource: 'schema'`), otherwise empty
 * (`fieldsSource: 'none'`). Events have no defaults to infer from, so unlike
 * {@link ComponentDescriptor} there is no `'defaults'` source.
 */
export interface EventDescriptor {
    readonly name: string;
    readonly fields: Readonly<Record<string, FieldSchema>>;
    readonly fieldsSource: 'schema' | 'none';
}
export interface EventView {
    of<T>(type: EventType<T>): readonly T[];
    emit<T>(type: EventType<T>, payload: T): void;
}
/** A single buffered emission, paired with its originating `EventType`. */
export interface EmittedEvent {
    readonly type: EventType<unknown>;
    readonly payload: unknown;
}
export interface EventBus {
    /** Enqueue for delivery at step 1 of next tick. */
    emit<T>(type: EventType<T>, payload: T): void;
    /** Subscribe directly; fn fires at flush time for events of that type. */
    on<T>(type: EventType<T>, fn: (e: T) => void): () => void;
    /** Swap pending -> current, returning the view for event systems this tick. */
    flush(): EventView;
    /** Current view (for inspection). */
    view(): EventView;
    /** Whether any events are queued for the next tick. */
    hasPending(): boolean;
    /**
     * Snapshot the currently-pending emissions as `{ type, payload }` pairs in
     * deterministic order: by first-emit of each type, then payload order within
     * a type. Used by `world.action` to report the events a command produced
     * during its tick (which are buffered for next tick at the time of reading).
     */
    pendingEvents(): EmittedEvent[];
    /**
     * Every event type this bus has observed — emitted, subscribed to, or
     * {@link note}d — in first-seen order. Powers `world.describe().events`.
     * Note: an event type defined but never used in this world is unknowable
     * and will not appear.
     */
    knownTypes(): EventType<unknown>[];
    /** Record `type` as known without emitting or subscribing (O-51). */
    note(type: EventType<unknown>): void;
    /**
     * Set all pending (undelivered) events aside and start an empty queue,
     * returning the set-aside events. Called by `world.restore()`: events
     * queued before a restore belong to the abandoned timeline and must not
     * fire into the first tick after it (SPEC §7.1). The current
     * (already-flushed) view is left alone — it is replaced wholesale at the
     * next flush.
     */
    takePending(): PendingEvents;
    /**
     * Make `taken` the pending queue again, dropping anything emitted since
     * {@link takePending}. `world.restore()` calls it when the restore throws,
     * so a failed restore leaves the pending events as they were.
     */
    putBackPending(taken: PendingEvents): void;
}
/** Pending events set aside by {@link EventBus.takePending}; opaque to callers. */
export type PendingEvents = Map<symbol, unknown[]>;
/**
 * Optional sink invoked when a direct `on()` subscriber throws during
 * `flush()`. The bus catches the throw, reports `(eventName, cause)` here,
 * and continues delivering the remaining subscribers/events. The world wires
 * this to build an `event_handler_threw` fault and route it to
 * `signals.faultRaised`; the bus itself stays decoupled from fault plumbing.
 */
export type HandlerFaultSink = (eventName: string, cause: unknown) => void;
export declare function createEventBus(onHandlerFault?: HandlerFaultSink): EventBus;

// file: faulted.d.ts
import type { FaultEntry } from './errors.js';
/**
 * Errors as data. Entity-scoped failures attach as a buffer on the entity
 * itself, flowing through the same query/system machinery as any other
 * component. See doc/BETTER_ERRORS.md §"Errors as Components".
 *
 * DOMECS stores at most one component of a given type per entity, so this
 * cannot be a single record — multiple systems may fault the same entity
 * in a single tick. The scheduler appends within a tick; the built-in
 * `consolidateFaults` end-of-tick system collapses redundant entries.
 */
export declare const Faulted: import("./types.js").ComponentType<{
    faults: readonly FaultEntry[];
}, string>;
/**
 * Priority for the built-in end-of-tick `consolidateFaults` system. Runs
 * after every user system and before render so the buffer is collapsed by
 * the time the renderer queries `[Faulted]`.
 */
export declare const CONSOLIDATE_FAULTS_PRIORITY: number;
/** Stable name of the built-in consolidator (so it can be disabled). */
export declare const CONSOLIDATE_FAULTS_NAME = "domecs:consolidateFaults";

// file: id-set.d.ts
import type { Entity } from './types.js';
/**
 * Entity set that iterates in ascending id order (SPEC §8). Live query
 * membership and archetype buckets use it so iteration does not depend on
 * the order entities happened to join: `restore()` rebuilds membership from
 * the id-sorted snapshot, and a restored world must iterate exactly like the
 * live one did (O-40).
 *
 * Membership lives in a `Set` (O(1) add/delete/has/size); iteration order
 * lives in `sorted`, maintained lazily:
 * - an add above the current tail appends — spawns allocate increasing ids,
 *   so this is the common case;
 * - an add below the tail (an older entity joining via `addComponent`) is
 *   parked in `late`;
 * - a delete is parked in `gone` and its id stays in `sorted` until then.
 * The next read (or a backlog past half the run, so sets nobody iterates
 * stay bounded) merges the sorted `late` ids in and drops the `gone` ones in
 * one pass: O(n + k log k) for k parked changes, free while unchanged.
 */
export declare class SortedIdSet implements Iterable<Entity> {
    private readonly members;
    private sorted;
    private late;
    private gone;
    get size(): number;
    has(id: Entity): boolean;
    add(id: Entity): void;
    delete(id: Entity): boolean;
    clear(): void;
    /**
     * Members in ascending id order. The array is owned by the set: read it
     * before the next mutation and never write to it.
     */
    ordered(): readonly Entity[];
    /**
     * Iterates the members as of the call, in ascending id order. Adds and
     * deletes made while iterating are not reflected — a deleted id that was a
     * member at the start is still yielded — so callers that mutate mid-loop
     * must re-check membership.
     */
    [Symbol.iterator](): Iterator<Entity>;
    private compactIfBacklogged;
    private normalize;
}
/** Ascending entity-id comparator for `Array.prototype.sort`. */
export declare function byId(a: Entity, b: Entity): number;
/**
 * Merge disjoint ascending id runs (one per matching archetype) into one
 * ascending array. Entity ids are dense non-negative integers, so when the
 * id span is within 8x the result size the runs are marked into a bitmap and
 * read back in order — linear, and independent of the number of runs. A
 * sparse span falls back to pairwise two-way merges, O(n log k).
 */
export declare function mergeSortedRuns(runs: ReadonlyArray<readonly Entity[]>): Entity[];

// file: index.d.ts
export { defineComponent } from './component.js';
export { defineResource } from './resource.js';
export { createWorld } from './world.js';
export { createAgentBridge } from './agent.js';
export type { AgentBridge, AgentBridgeOptions, AgentObservation, } from './agent.js';
export { defineEvent } from './events.js';
export { createRng, restoreRng, seedToState } from './rng.js';
export { createTime, quantizeMs } from './time.js';
export { Has, Not, Or, And, OnAdded, OnRemoved, OnChanged, Where, OnChangedResource, normalize as normalizeQuery, collectHasComponents, QueryNodeKind, } from './query.js';
export type { World, WorldOptions, WorldSignals, ActionEvent, ActionVerdict, ActionResolver, ActionOptions, ActionResult, } from './world.js';
export type { EventType, EventView, EmittedEvent, EventDescriptor, EventDefOptions } from './events.js';
export type { WorldManifest, PluginManifestEntry } from './manifest.js';
export type { InputSnapshot, PointerSnapshot, GamepadSnapshot } from './input.js';
export type { System, SystemContext, SystemDef, TickSystemDef, FixedSystemDef, EventSystemDef, OnceSystemDef, ReactiveSystemDef, SystemHandle, SystemSchedule, } from './scheduler.js';
export type { Signal } from './signals.js';
export { definePlugin } from './plugin.js';
export type { Plugin, PluginSpec, PluginHandle, Capability, TickInfo } from './plugin.js';
export { SNAPSHOT_VERSION } from './snapshot.js';
export type { SnapshotOptions, WorldSnapshot } from './snapshot.js';
export type { ChangesSnapshot } from './change-log.js';
export type { Rng, RngState } from './rng.js';
export type { TimeState } from './time.js';
export { entry } from './types.js';
export type { ComponentType, ComponentValue, ComponentOptions, ComponentBag, ComponentEntry, ComponentDescriptor, ComponentSchema, FieldSchema, FieldKind, ResourceType, ResourceValue, ResourceOptions, ResourceDescriptor, Entity, } from './types.js';
export type { QueryDef, QueryHooks, QueryNode, QueryResult, QueryShorthand, NodeOrComponent, OneShotQueryDef, TemporalQueryNode, EntityView, FieldsFromComponents, } from './query.js';
export { ok, err, isOk, isErr, mapR, mapErr, andThen, unwrapOr, tap, tapErr, all, attempt, attemptAsync, match, assertNever, normalizeCause, toJsonValue, MAX_CAUSE_DEPTH, } from './result.js';
export type { Result, Ok, Err, JsonValue, SerializedError } from './result.js';
export { describeError, ERROR_KINDS, isKnownDomecsErrorKind, getErrorRepairHint } from './errors.js';
export type { DomecsError, ErrorKind, PluginError, PluginResult, SystemFault, SystemResult, SystemicFault, SystemId, ComponentId, EventId, FaultEntry, } from './errors.js';
export { Faulted, CONSOLIDATE_FAULTS_NAME, CONSOLIDATE_FAULTS_PRIORITY, } from './faulted.js';

// file: input.d.ts
import type { Entity } from './types.js';
/** Per-frame pointer state. Frame-relative deltas (`delta`, `wheel`) accumulate
 * over the frame's events and reset to zero each tick. */
export interface PointerSnapshot {
    /** Pointer X in client (CSS) pixels, relative to the pointer target. */
    x: number;
    /** Pointer Y in client (CSS) pixels, relative to the pointer target. */
    y: number;
    /** Bitmask of currently-held pointer buttons (the DOM `PointerEvent.buttons`
     * value: 1 = primary, 2 = secondary, 4 = auxiliary/middle, …). */
    buttons: number;
    /** Pointer movement accumulated this frame, in client (CSS) pixels. `+x` is
     * rightward, `+y` is downward (screen convention). Resets to `{0,0}` each tick. */
    delta: {
        x: number;
        y: number;
    };
    /** Wheel scroll accumulated this frame, summed from `WheelEvent.deltaY`.
     * Sign follows the DOM convention: **positive = scrolled down / away from the
     * user**, negative = scrolled up / toward the user. Magnitude is in the units
     * the browser reports for `deltaY` (typically pixels; per the event's
     * `deltaMode` it may instead be lines or pages). Resets to `0` each tick. */
    wheel: number;
    /** Entities the pointer entered this frame. Identifiers are plain {@link Entity}
     * values. Empty in the headless stub. */
    entered: readonly Entity[];
}
/** Snapshot of one connected gamepad, mirroring the Gamepad API. */
export interface GamepadSnapshot {
    /** The gamepad's slot index, as reported by `navigator.getGamepads()`. */
    index: number;
    /** Analog axis positions, each normalized to `-1..1`. */
    axes: readonly number[];
    /** Per-button state. `value` is the analog press depth in the range `0..1`
     * (`0` released, `1` fully pressed); `pressed` is the digital threshold. */
    buttons: readonly {
        pressed: boolean;
        value: number;
    }[];
}
export interface InputSnapshot {
    readonly keys: ReadonlySet<string>;
    readonly keyDelta: {
        pressed: ReadonlySet<string>;
        released: ReadonlySet<string>;
    };
    readonly mods: Readonly<{
        ctrl: boolean;
        alt: boolean;
        shift: boolean;
        meta: boolean;
    }>;
    readonly pointer: PointerSnapshot;
    readonly gamepads: readonly GamepadSnapshot[];
    readonly focus: {
        activeTag: string;
        consumesKeys: boolean;
    };
}
export declare function emptyInput(): InputSnapshot;

// file: manifest.d.ts
import type { EventDescriptor } from './events.js';
import type { SystemSchedule } from './scheduler.js';
import type { ComponentDescriptor, ResourceDescriptor } from './types.js';
/**
 * Serializable projection of an installed plugin for {@link WorldManifest}.
 * Deliberately NOT the internal `InstalledPlugin` (which carries live
 * `install`/`teardown` functions and arbitrary `options`) — a manifest exists
 * to be read and polled, so it stays JSON-shaped.
 */
export interface PluginManifestEntry {
    readonly name: string;
    readonly version?: string;
    readonly provides: readonly string[];
}
/**
 * The single machine-readable description of a live world (§6). Schema fields
 * answer "what *can* exist"; debug fields answer "what *does* exist right
 * now". All debug counts are O(1)/O(archetype) reads, never full scans, so
 * `world.describe()` is cheap enough to poll.
 */
export interface WorldManifest {
    readonly components: ComponentDescriptor[];
    readonly resources: ResourceDescriptor[];
    /**
     * Event types this world has seen emitted, subscribed to, or named as an
     * event system's trigger, with their declared schema fields (O-51).
     */
    readonly events: EventDescriptor[];
    readonly systems: {
        readonly name: string;
        readonly schedule: SystemSchedule;
        readonly enabled: boolean;
    }[];
    readonly plugins: PluginManifestEntry[];
    readonly capabilities: string[];
    readonly snapshotVersion: number;
    readonly entityCount: number;
    readonly componentCounts: Record<string, number>;
    readonly archetypes: {
        readonly components: string[];
        readonly entityCount: number;
    }[];
}

// file: plugin.d.ts
import type { DomecsError } from './errors.js';
import { type Result } from './result.js';
import type { WorldSnapshot } from './snapshot.js';
import type { World } from './world.js';
/**
 * Lifecycle contract for a plugin (SPEC §9.1, doc/BETTER_ERRORS.md Phase 1).
 *
 * `install` returns a `Result`: success carries an optional `PluginHandle`
 * (lifecycle hooks + teardown); failure carries a `DomecsError` and is
 * quarantined — provided capabilities are unwound, but the world keeps
 * running. Throws from `install` are treated as failures and normalized
 * into `{ kind: 'plugin_install_failed', plugin, cause }`.
 */
export interface Plugin<O = void> {
    readonly name: string;
    readonly version?: string;
    readonly depends?: readonly string[];
    readonly provides?: readonly string[];
    install(world: World, options: O): Result<PluginHandle | void, DomecsError>;
}
/**
 * What kind of frame a plugin tick hook runs in (O-57). On a heartbeat
 * (`step(dt)` with `dt <= 0`, SPEC §4.0) hooks and render run but no system
 * does, so a plugin that hands systems one-tick data — input edges, deltas —
 * should publish without consuming it.
 */
export interface TickInfo {
    readonly heartbeat: boolean;
}
export interface PluginHandle {
    teardown?(): void;
    onTickStart?(world: World, info: TickInfo): void;
    onTickEnd?(world: World, info: TickInfo): void;
    onRender?(world: World, info: TickInfo): void;
    /** Typed snapshot hook (TYPE_EVAL §3.2b — subsumed by BETTER_ERRORS Phase 1). */
    onSnapshot?(snap: WorldSnapshot): WorldSnapshot;
    onRestore?(snap: WorldSnapshot): WorldSnapshot;
}
/**
 * Authoring spec for {@link definePlugin}. Differs from {@link Plugin} only
 * in `install`'s return: an author may return a bare `PluginHandle`, nothing
 * (`void`), or a full `Result` — `definePlugin` normalizes all three to the
 * `Result` contract the registry consumes.
 */
export interface PluginSpec<O = void> {
    readonly name: string;
    readonly version?: string;
    readonly depends?: readonly string[];
    readonly provides?: readonly string[];
    install(world: World, options: O): PluginHandle | void | Result<PluginHandle | void, DomecsError>;
}
/**
 * Author a plugin without hand-writing the `Result` boilerplate. `install`
 * may return a bare `PluginHandle`, `void`, or a `Result`; a bare/void return
 * is auto-wrapped in `ok()`, while an explicit `Result` (success or failure)
 * is passed through untouched. This keeps a bare-handle return valid through
 * the Result-contract migration — the footgun that bit lighthouse-class
 * plugins. `name`/`version`/`depends`/`provides` pass through unchanged.
 */
export declare function definePlugin<O = void>(spec: PluginSpec<O>): Plugin<O>;
export interface Capability<K extends string> {
    readonly name: K;
}
export interface InstalledPlugin {
    plugin: Plugin<unknown>;
    handle: PluginHandle | null;
    options: unknown;
}
export interface PluginRegistry {
    use<O>(plugin: Plugin<O>, options?: O): Result<() => void, DomecsError>;
    capability<K extends string>(name: K): Capability<K>;
    list(): ReadonlyArray<InstalledPlugin>;
    callTickStart(world: World, info: TickInfo): void;
    callTickEnd(world: World, info: TickInfo): void;
    callRender(world: World, info: TickInfo): void;
    teardownAll(): void;
}
export declare function createPluginRegistry(world: World): PluginRegistry;

// file: query.d.ts
import type { ComponentType, Entity, ResourceType } from './types.js';
export type QueryNode = {
    kind: 'has';
    type: ComponentType<unknown>;
} | {
    kind: 'changed';
    type: ComponentType<unknown>;
} | {
    kind: 'added';
    type: ComponentType<unknown>;
} | {
    kind: 'removed';
    type: ComponentType<unknown>;
} | {
    kind: 'where';
    type: ComponentType<unknown>;
    predicate: (value: unknown) => boolean;
} | {
    kind: 'changedResource';
    resource: ResourceType<unknown>;
} | {
    kind: 'not';
    child: QueryNode;
} | {
    kind: 'and';
    children: QueryNode[];
} | {
    kind: 'or';
    children: QueryNode[];
};
export type QueryShorthand = ReadonlyArray<ComponentType<unknown>> | QueryNode;
/**
 * A query specification accepted by the world's query/observe APIs: either a
 * tuple of `ComponentType`s or a combinator `QueryNode`.
 *
 * Field inference forks on the form. The tuple form
 * (`world.query([Position, Velocity])`) infers the matched view's `Fields`, so
 * `view.Position` / `view.Velocity` are typed. The combinator form
 * (`Has`/`And`/`Or`/…) does not carry per-field types and falls back to the
 * unconstrained {@link EntityView} (`Record<string, unknown>`); read those
 * components via `world.getComponent(view.id, T)`.
 */
export type QueryDef = QueryShorthand;
/**
 * The set of `kind` discriminants in the `QueryNode` union, as a runtime const
 * and a derived literal type. Keep in sync with the `QueryNode` union above.
 */
export declare const QueryNodeKind: readonly ["has", "changed", "added", "removed", "where", "changedResource", "not", "and", "or"];
export type QueryNodeKind = (typeof QueryNodeKind)[number];
declare const TEMPORAL: unique symbol;
/**
 * A temporal query node (`OnAdded`/`OnRemoved`/`OnChanged`/`OnChangedResource`).
 * Structurally a `QueryNode`, but carries a phantom brand (`[TEMPORAL]: true`)
 * so the one-shot selectors can reject it at compile time. The brand has no
 * runtime representation — the constructors return the same plain node object.
 *
 * Defined as an *intersection* (not `interface extends QueryNode`): `QueryNode`
 * is a union, and an interface cannot extend a union (TS2312), nor would the
 * result stay assignable back to `QueryNode`. The intersection keeps temporal
 * nodes usable everywhere a `QueryNode` is accepted (reactive `reactsTo`,
 * `And`/`Or` nesting) while still carrying the brand.
 */
export type TemporalQueryNode = QueryNode & {
    readonly [TEMPORAL]: true;
};
/**
 * Query accepted by the one-shot selectors (`countEntities` / `listEntities` /
 * `selectViews`). Plain `QueryNode`s and component arrays are allowed; temporal
 * `On*` nodes are excluded via a *negative brand*: the optional `[TEMPORAL]?:
 * never` rejects the `true` carried by `TemporalQueryNode`, while a plain
 * `QueryNode` (brand absent) satisfies the optional-`never` prop by absence.
 */
export type OneShotQueryDef = ReadonlyArray<ComponentType<unknown>> | (QueryNode & {
    readonly [TEMPORAL]?: never;
});
/**
 * Argument accepted by predicate combinators (`Not` / `And` / `Or`):
 * either a `QueryNode` or a bare `ComponentType` (auto-wrapped as `Has(T)`).
 * SPEC §2.4.
 */
export type NodeOrComponent = QueryNode | ComponentType<unknown>;
/**
 * Maps a `ComponentType<T, Name>` to the field `{ [Name]: T }`. Used to project
 * a tuple of component types into the typed body of an `EntityView` (D-2).
 *
 * Implementation note: we distribute over `T[number]` to build a union of
 * single-field records, then collapse that union into one record via
 * `UnionToIntersection`. A direct mapped type (`[K in T[number] as …]`) drops
 * the per-element link between `Name` and `Value` because TypeScript infers
 * the value position against the union as a whole — the resulting record's
 * fields all end up typed as the union of every value type.
 */
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
type ComponentTypeToField<C> = C extends ComponentType<infer V, infer N> ? Readonly<{
    [P in N]: V;
}> : never;
export type FieldsFromComponents<T extends ReadonlyArray<ComponentType<unknown, string>>> = UnionToIntersection<ComponentTypeToField<T[number]>>;
/**
 * Live read-only entity view returned by queries and renderer hooks.
 *
 * When a query is built from the array shorthand
 * (`world.query([Position, Velocity])`), `Fields` is inferred so that
 * `view.Position` and `view.Velocity` are typed. For combinator forms
 * (`Has`/`And`/`Or`/…) where field inference is not currently wired up,
 * `Fields` defaults to `Record<string, unknown>` and callers can fall back
 * to `world.getComponent(view.id, T)` for typed access.
 */
export type EntityView<Fields = Record<string, unknown>> = Readonly<Fields> & {
    readonly id: Entity;
};
export interface QueryResult<Fields = Record<string, unknown>> {
    readonly entities: ReadonlyArray<EntityView<Fields>>;
    readonly size: number;
    onAdd(fn: (e: EntityView<Fields>) => void): () => void;
    onRemove(fn: (e: EntityView<Fields>) => void): () => void;
    /**
     * Release this live query from the world's archetype indexes. After disposal,
     * `entities` is empty, `size` is 0, and add/remove subscriptions are cleared.
     */
    dispose(): void;
}
export interface QueryHooks<Fields = Record<string, unknown>> {
    onAdd?: (e: EntityView<Fields>) => void;
    onRemove?: (e: EntityView<Fields>) => void;
    onChange?: (e: EntityView<Fields>) => void;
}
export declare function Has<T>(type: ComponentType<T>): QueryNode;
export declare function Not(arg: NodeOrComponent): QueryNode;
export declare function Or(...args: NodeOrComponent[]): QueryNode;
export declare function And(...args: NodeOrComponent[]): QueryNode;
export declare function OnChanged<T>(type: ComponentType<T>): TemporalQueryNode;
export declare function OnAdded<T>(type: ComponentType<T>): TemporalQueryNode;
export declare function OnRemoved<T>(type: ComponentType<T>): TemporalQueryNode;
export declare function Where<T>(type: ComponentType<T>, predicate: (value: T) => boolean): QueryNode;
/**
 * Gate that is true when the world resource `resource` changed within the
 * reader's change window (SPEC §2.9). Structurally neutral — it constrains
 * *when* a query matches, not *which* entities. Bare `OnChangedResource(R)`
 * matches the whole world then; compose with `And(Has(X), OnChangedResource(R))` to scope the
 * reaction to `X` entities. Reactive only: rejected by the one-shot selectors.
 */
export declare function OnChangedResource<T>(resource: ResourceType<T>): TemporalQueryNode;
export declare function normalize(def: QueryDef): QueryNode;
export declare function treeHas(node: QueryNode, kinds: ReadonlySet<QueryNode['kind']>): boolean;
/**
 * Collect the names of every resource referenced by a `OnChangedResource(R)`
 * leaf anywhere in the tree. Used by the reactive scheduler's
 * resource-only fallback to fire a `reactsTo: OnChangedResource(R)` system in an
 * entity-empty world where the structural member count is zero.
 */
export declare function collectChangedResourceNames(node: QueryNode, out?: Set<string>): Set<string>;
export declare function collectTypesByKind(node: QueryNode, kind: QueryNode['kind'], out?: Set<string>): Set<string>;
/**
 * Collect every `ComponentType` referenced by a `Has(T)` leaf anywhere in
 * the tree, returning the actual type objects (not just their names).
 *
 * Used by the DOM renderer to auto-derive `changedOn` from a view's query
 * when the caller omits it (P-3): "redraw when any component this view
 * structurally depends on changes." Negative branches (`Not(...)`) are
 * skipped — a `Not(Dead)` view doesn't want to redraw every time a `Dead`
 * tag flips elsewhere.
 */
export declare function collectHasComponents(node: QueryNode, out?: Map<string, ComponentType<unknown>>, inNot?: boolean): Map<string, ComponentType<unknown>>;
export {};

// file: resource.d.ts
import type { ResourceOptions, ResourceType } from './types.js';
export interface InternalResourceType<T, Name extends string = string> extends ResourceType<T, Name> {
    readonly __tag: symbol;
    /** Produces a fresh default value, or `undefined` when none was declared. */
    readonly __default: (() => T) | undefined;
    readonly __validate: ((value: T) => true | string) | undefined;
}
export declare function defineResource<T, const Name extends string>(name: Name, options?: ResourceOptions<T>): ResourceType<T, Name>;
export declare function defineResource<T>(name: string, options?: ResourceOptions<T>): ResourceType<T, string>;
export declare function internalResource<T>(type: ResourceType<T>): InternalResourceType<T>;

// file: result.d.ts
/**
 * Result<T, E> — the framework's contract at recoverable seams (system
 * returns, plugin lifecycle, persistence, services). Discipline lives in
 * doc/BETTER_ERRORS.md; this file holds the primitives.
 *
 * Programmer-error invariants still throw. `Result` is for *expected*
 * failure modes that callers should acknowledge.
 */
/** The success arm of a {@link Result}. */
export type Ok<T> = {
    readonly ok: true;
    readonly value: T;
};
/** The failure arm of a {@link Result}. */
export type Err<E> = {
    readonly ok: false;
    readonly error: E;
};
export type Result<T, E> = Ok<T> | Err<E>;
export declare const ok: <T>(value: T) => Result<T, never>;
export declare const err: <E>(error: E) => Result<never, E>;
export declare const isOk: <T, E>(r: Result<T, E>) => r is Ok<T>;
export declare const isErr: <T, E>(r: Result<T, E>) => r is Err<E>;
export declare function mapR<T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E>;
export declare function mapErr<T, E, F>(r: Result<T, E>, f: (e: E) => F): Result<T, F>;
export declare function andThen<T, U, E>(r: Result<T, E>, f: (t: T) => Result<U, E>): Result<U, E>;
export declare function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T;
/**
 * Run a side effect on the success value and pass the Result through
 * unchanged. For logging/telemetry in a Result pipeline without unwrapping:
 * `tap(world.use(p), () => log('plugin installed'))`.
 */
export declare function tap<T, E>(r: Result<T, E>, f: (t: T) => void): Result<T, E>;
/**
 * Run a side effect on the error and pass the Result through unchanged.
 * Pairs with {@link describeError}:
 * `tapErr(world.use(p), (e) => console.warn(describeError(e)))`.
 */
export declare function tapErr<T, E>(r: Result<T, E>, f: (e: E) => void): Result<T, E>;
export declare function all<T, E>(rs: ReadonlyArray<Result<T, E>>): Result<readonly T[], E>;
export declare function attempt<T>(fn: () => T): Result<T, {
    kind: 'thrown';
    cause: SerializedError;
}>;
export declare function attemptAsync<T>(fn: () => Promise<T>): Promise<Result<T, {
    kind: 'thrown';
    cause: SerializedError;
}>>;
/**
 * Exhaustive discriminated-union dispatch. Primary error-handling idiom —
 * adding a new variant to a closed union breaks every `match` site at
 * compile time until the new case is added.
 */
export declare function match<E extends {
    kind: string;
}, R>(e: E, cases: {
    [K in E['kind']]: (e: Extract<E, {
        kind: K;
    }>) => R;
}): R;
/**
 * Escape hatch for the rare manual `switch (err.kind)` site. The compiler
 * will flag any unhandled discriminant before this throws at runtime.
 */
export declare function assertNever(x: never): never;
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export interface SerializedError {
    name?: string;
    message: string;
    stack?: string;
    cause?: JsonValue;
}
export declare const MAX_CAUSE_DEPTH = 3;
/**
 * Normalize an arbitrary thrown value into a JSON-serializable form. Walks
 * `Error.cause` chains to {@link MAX_CAUSE_DEPTH}; deeper chains truncate
 * silently. Non-Error / non-JSON-stringifiable values fall back to
 * `String(value)`.
 *
 * Runs once at framework boundaries (scheduler, persistence, plugin host) —
 * user code never needs to call it.
 */
export declare function normalizeCause(value: unknown, depth?: number): SerializedError;
/**
 * Coerce an arbitrary value into a JsonValue, recursing with the same
 * depth budget as {@link normalizeCause}. Non-serializable leaves
 * (`bigint`, `symbol`, `function`, `undefined`, cyclic graphs) fall back
 * to `String(value)`. Used by the scheduler when projecting a returned
 * `SystemFault`'s payload into a `FaultEntry.detail`.
 */
export declare function toJsonValue(value: unknown, depth?: number): JsonValue;

// file: rng.d.ts
export type RngState = readonly [number, number, number, number];
export interface Rng {
    uniform(): number;
    uniformInt(max: number): number;
    uniformRange(lo: number, hi: number): number;
    pick<T>(arr: readonly T[]): T;
    uniformRoll(sides: number): number;
    seed(): RngState;
    fork(label: string): Rng;
}
export declare function seedToState(seed: number | RngState): [number, number, number, number];
export declare function createRng(initial: number | RngState): Rng;
export declare function restoreRng(state: RngState): Rng;
/**
 * Set `rng`'s state to `state` in place, as `restoreRng(state)` would start.
 * Returns false when `rng` was not made by {@link createRng}.
 */
export declare function rewindRng(rng: Rng, state: RngState): boolean;

// file: scheduler.d.ts
import type { EventType, EventView } from './events.js';
import type { InputSnapshot } from './input.js';
import { type EntityView, type QueryDef, type QueryResult } from './query.js';
import type { Rng } from './rng.js';
import type { TimeState } from './time.js';
import type { World } from './world.js';
export type SystemSchedule = 'tick' | 'fixed' | 'event' | 'once' | 'reactive';
/**
 * Fields shared across all SystemDef variants: query, priority, enabled gate,
 * initial state, and the erased Fields phantom.
 */
interface SystemDefBase<Fields = Record<string, unknown>, State = unknown> {
    query?: QueryDef;
    priority?: number;
    enabled?: () => boolean;
    state?: State;
    /**
     * Erased Fields phantom — keeps a structural slot for the inferred field
     * shape so callers can ascribe it explicitly when needed. The runtime
     * never reads this; declaring it lets `system<T>(...)` propagate Fields
     * into the system function signature.
     */
    readonly __fields?: Fields;
}
/** Per-tick system (the default when `schedule` is omitted). */
export interface TickSystemDef<Fields = Record<string, unknown>, State = unknown> extends SystemDefBase<Fields, State> {
    schedule?: 'tick';
}
/** Fixed-rate system; `rateHz` must be a whole-number divisor of the world's base rate. */
export interface FixedSystemDef<Fields = Record<string, unknown>, State = unknown> extends SystemDefBase<Fields, State> {
    schedule: 'fixed';
    rateHz?: number;
}
/** Event-driven system; runs when any of `triggers` fired this tick. */
export interface EventSystemDef<Fields = Record<string, unknown>, State = unknown> extends SystemDefBase<Fields, State> {
    schedule: 'event';
    triggers?: EventType<unknown>[];
}
/** Runs exactly once, on the first tick after registration. */
export interface OnceSystemDef<Fields = Record<string, unknown>, State = unknown> extends SystemDefBase<Fields, State> {
    schedule: 'once';
}
/** Reactive system; `ctx.entities` is the change-delta from `reactsTo`. */
export interface ReactiveSystemDef<Fields = Record<string, unknown>, State = unknown> extends SystemDefBase<Fields, State> {
    schedule: 'reactive';
    reactsTo: QueryDef;
}
/**
 * Discriminated union of all system definition variants. The `schedule` field
 * acts as the discriminant; invalid field combinations (e.g. `rateHz` on a
 * `'tick'` system) are unrepresentable at compile time.
 */
export type SystemDef<Fields = Record<string, unknown>, State = unknown> = TickSystemDef<Fields, State> | FixedSystemDef<Fields, State> | EventSystemDef<Fields, State> | OnceSystemDef<Fields, State> | ReactiveSystemDef<Fields, State>;
export interface SystemContext<Fields = Record<string, unknown>, State = unknown> {
    entities: ReadonlyArray<EntityView<Fields>>;
    time: Readonly<TimeState>;
    input: InputSnapshot;
    events: EventView;
    world: World;
    rand: Rng;
    state: State;
}
/**
 * A system returns `void` (treated as success — no `Faulted` attached) or
 * a `SystemResult` whose `errors` are appended to the targeted entities'
 * `Faulted` buffer. The declared return type is `void` (TypeScript's
 * void-return special rule lets the function return anything; the scheduler
 * shape-checks for SystemResult at runtime). Authors who want compile-time
 * validation should annotate the return type explicitly with
 * `SystemResult<E>`. See doc/BETTER_ERRORS.md.
 */
export type System<Fields = Record<string, unknown>, State = unknown> = (ctx: SystemContext<Fields, State>) => void;
export interface SystemHandle {
    readonly name: string;
    readonly schedule: SystemSchedule;
    enabled: boolean;
    enable(): void;
    disable(): void;
    remove(): void;
    replaceFn?(fn: System): void;
}
export interface CompiledSystem {
    id: number;
    name: string;
    def: SystemDef;
    fn: System;
    pendingFn?: System;
    schedule: SystemSchedule;
    priority: number;
    enabled: boolean;
    state: unknown;
    query?: QueryResult;
    reactsTo?: QueryResult;
    /** for fixed: divisor = baseHz / rateHz */
    fixedDivisor: number;
    /** for once: has it already run? */
    ranOnce: boolean;
    /** Monotonic tie-break for equal priorities; never reused (O-43). */
    registrationIndex: number;
    /** Set by remove(); a phase already iterating skips it (O-43). */
    removed: boolean;
    /**
     * O-42 change window: the change-log stamp this system has seen through.
     * A run reports marks in `(seenThrough, runStart]`; when it ends,
     * `seenThrough` moves to the stamp at that point, so the system's own
     * writes are not reported back to it.
     */
    seenThrough: number;
    /** The change-log stamp when the current run started. */
    runStart: number;
    /** True while the system's function is executing. */
    running: boolean;
    /** Its query or reactsTo has a change-detection node (snapshot cursor). */
    watchesChanges: boolean;
    /** Its query or reactsTo has an `OnRemoved` node (removal-mark pruning). */
    watchesRemoved: boolean;
}
export interface Scheduler {
    register(name: string, def: SystemDef, fn: System): SystemHandle;
    /**
     * The systems of one schedule in run order. The array is never mutated:
     * register/remove swap in a new one, so a phase iterating it is not
     * disturbed by systems added or removed mid-phase (O-43). Callers skip
     * entries whose `removed` flag is set.
     */
    systemsByMode(mode: SystemSchedule): readonly CompiledSystem[];
    /** Every registered system, in registration order. */
    all(): readonly CompiledSystem[];
    /** The live SystemHandle for a registered system by name, or undefined. */
    getHandle(name: string): SystemHandle | undefined;
    /** Remove a system by handle (no-op if already removed). */
    remove(s: CompiledSystem): void;
    applyPendingReplacements(): void;
}
/**
 * @param makeQuery builds a live query owned by `owner`: its change window
 *   is the system's (O-42).
 * @param initialSeen the change-log stamp a newly registered system's
 *   window starts after.
 */
export declare function createScheduler(makeQuery: (def: QueryDef, owner: CompiledSystem) => QueryResult, fixedStep: number, initialSeen: (name: string) => number): Scheduler;
export {};

// file: signals.d.ts
export interface Signal<T> {
    /** Register `fn` to be invoked with each emitted payload. Returns an
     * unsubscribe function that detaches `fn`. The unsubscribe is **idempotent**:
     * calling it more than once is a safe no-op (subsequent calls do nothing). */
    subscribe(fn: (e: T) => void): () => void;
}
export interface EmittableSignal<T> extends Signal<T> {
    emit(payload: T): void;
    readonly size: number;
}
export declare function createSignal<T>(): EmittableSignal<T>;

// file: snapshot.d.ts
import type { ChangesSnapshot } from './change-log.js';
import type { Entity } from './types.js';
export declare const SNAPSHOT_VERSION = 2;
/** Options for `world.snapshot()`. */
export interface SnapshotOptions {
    /**
     * Drop entities whose serializable component bag is empty after transient
     * components are excluded — transient-only entities and bare `spawn()`
     * entities. Default `false` (every alive entity is recorded). Persisting
     * with this on keeps save files lean; the persist plugin
     * `pruneTransientOnlyEntities()` applies it to the no-arg `save()` path.
     */
    readonly pruneEmptyEntities?: boolean;
}
export interface WorldSnapshot {
    readonly version: number;
    readonly seed: readonly [number, number, number, number];
    readonly tick: number;
    /**
     * Cumulative unquantized scaled time in seconds — the drift-free total
     * that drives the fixed-step scheduler (SPEC §2.7). Restore resumes it and
     * re-derives `time.elapsed`, the fixed-step count, and the accumulator from
     * it, so a restored world's `fixed` systems keep the live world's cadence
     * (O-40). Optional: snapshots from older builds lack it, and restore starts
     * the clock at zero.
     */
    readonly scaledTime?: number;
    /**
     * Fixed steps due under `scaledTime` that had not run yet (O-40). Omitted
     * when 0 — the normal case after a completed tick. Positive when a
     * `tickStart` hook paused the world after time advanced (the live world
     * runs them on resume), or when the snapshot was taken inside the
     * fixed-step loop. Restore keeps them owed.
     */
    readonly fixedBacklog?: number;
    /**
     * The `fixedStep` that `fixedBacklog` is counted in; present with it. A
     * world restored with another `fixedStep` re-counts the owed time in its
     * own steps instead of owing the same number of differently sized ones.
     */
    readonly fixedStep?: number;
    readonly entities: ReadonlyArray<{
        readonly id: Entity;
        readonly components: Record<string, unknown>;
    }>;
    /**
     * Entity-id cursor at snapshot time (O-38). Restoring honors it, so ids
     * assigned after a restore match ids assigned on the live world even when
     * the highest-id entity was despawned before the snapshot (previously the
     * cursor was re-derived as maxAliveId+1, recycling despawned ids and
     * making episodes incomparable). Optional: snapshots from older builds
     * lack it, and restore falls back to the maxAliveId+1 derivation.
     */
    readonly nextId?: number;
    /**
     * World-singleton resources, keyed by resource name (v2).
     * Omitted entirely when the world has no materialized resources. Values are
     * deep-cloned at snapshot time, like component values.
     */
    readonly resources?: Record<string, unknown>;
    /**
     * Change marks some system had not seen yet, with each such system's
     * position (O-42, SPEC §2.9). Restore re-issues them, so a restored
     * world's change-detection filters report what the live world's would.
     * Omitted when every system has seen every mark.
     */
    readonly changes?: ChangesSnapshot;
    readonly meta?: Record<string, unknown>;
}
export declare function cloneSerializable<T>(value: T): T;

// file: time.d.ts
export interface TimeState {
    tick: number;
    elapsed: number;
    delta: number;
    scaledDelta: number;
    scale: number;
    fixedStep: number;
    fixedAccumulator: number;
}
export declare function createTime(fixedStep: number): TimeState;
export declare function quantizeMs(seconds: number): number;
/**
 * Fixed steps due after `totalScaledSeconds` of scaled time (SPEC §2.7 F-3).
 * Shared by the tick and by restore (O-40) so both derive the same count
 * from the same float expression.
 */
export declare function fixedStepsDue(totalScaledSeconds: number, fixedStep: number): number;

// file: types.d.ts
export type Entity = number;
declare const __componentTag: unique symbol;
declare const __resourceTag: unique symbol;
/**
 * Component schema. `Name` is the literal name string supplied at
 * `defineComponent('Foo')` — it propagates through queries so the resulting
 * `EntityView` has a typed `e.Foo` field instead of `unknown` (D-2).
 */
export interface ComponentType<T, Name extends string = string> {
    readonly name: Name;
    readonly [__componentTag]: symbol;
    create(value?: Partial<T>): T;
}
/**
 * Extract a component's value type from its `ComponentType`. Replaces the
 * `ReturnType<typeof X.create>` idiom that proliferated across consumers:
 * `ComponentValue<typeof Ship>` instead of `ReturnType<typeof Ship.create>`.
 */
export type ComponentValue<C> = C extends ComponentType<infer T, string> ? T : never;
export interface ComponentOptions<T> {
    defaults?: Partial<T>;
    transient?: boolean;
    validate?: (value: T) => true | string;
    /**
     * Optional field-level schema for reflection. Lets dev tools
     * render edit widgets for this component from the world alone via
     * `world.describeComponent(type)` — no hand-rolled per-app schema registry.
     * When omitted, `describeComponent` infers field kinds from `defaults`.
     */
    schema?: ComponentSchema;
}
/** Field kinds a reflection widget can render. */
export type FieldKind = 'number' | 'string' | 'boolean' | 'enum' | 'object' | 'unknown';
/**
 * Per-field reflection metadata. `kind` is required; the rest are optional
 * widget hints (numeric range/step, enum `options`, display `label`,
 * `readonly`). Field names are plain strings, not keyed to `T` — this is a
 * runtime descriptor consumed by tooling, not a type-level constraint.
 */
export interface FieldSchema {
    readonly kind: FieldKind;
    readonly min?: number;
    readonly max?: number;
    readonly step?: number;
    readonly options?: ReadonlyArray<string | number>;
    readonly label?: string;
    readonly readonly?: boolean;
}
/** A component's field schema: a map of field name → {@link FieldSchema}. */
export interface ComponentSchema {
    readonly fields: Readonly<Record<string, FieldSchema>>;
}
/**
 * Result of `world.describeComponent(type)`. `fields` is resolved: the
 * explicit `schema.fields` when one was declared (`fieldsSource: 'schema'`),
 * otherwise inferred from `defaults` by runtime `typeof`
 * (`fieldsSource: 'defaults'`), otherwise empty (`fieldsSource: 'none'`).
 * `defaults` is an independent clone safe for tooling to read or mutate.
 */
export interface ComponentDescriptor {
    readonly name: string;
    readonly transient: boolean;
    readonly defaults: Record<string, unknown> | undefined;
    readonly fields: Readonly<Record<string, FieldSchema>>;
    readonly fieldsSource: 'schema' | 'defaults' | 'none';
}
/**
 * Result of `world.describeResource(type)` — parity with
 * {@link ComponentDescriptor} for world-singleton values. `hasDefault` is
 * true when a `default` factory/value was declared at `defineResource`;
 * `hasValue` is true once the resource has been materialized in this world
 * (read at least once, or set explicitly).
 */
export interface ResourceDescriptor {
    readonly name: string;
    readonly hasValue: boolean;
    readonly hasDefault: boolean;
}
/**
 * A world-singleton value, addressed by identity rather than per-entity
 *. Defined with {@link defineResource}; read/written via
 * `world.getResource(type)` / `world.setResource(type, value)`. The distinct
 * brand (`__resourceTag`) keeps resources from being passed where a
 * `ComponentType` is expected and vice-versa. The brand's function type
 * carries `T` so it is load-bearing (no phantom type parameter — consumers
 * compiling engine source under `noUnusedParameters` would fail TS6133) and
 * resources of different `T` are not mutually assignable. Purely type-level:
 * `defineResource` never materializes the property at runtime.
 */
export interface ResourceType<T, Name extends string = string> {
    readonly name: Name;
    readonly [__resourceTag]: (value: T) => void;
}
/** Extract a resource's value type from its `ResourceType`. */
export type ResourceValue<R> = R extends ResourceType<infer T, string> ? T : never;
export interface ResourceOptions<T> {
    /**
     * Initial value, materialized lazily on first `resource()` read. A function
     * is treated as a per-world factory (called once per world) so object/array
     * defaults are not shared across worlds; any other value is deep-cloned per
     * world. For a resource whose value is itself a function, wrap it:
     * `default: () => myFn`.
     */
    default?: T | (() => T);
    /** Reject invalid values on `setResource` / lazy default; return `true` or a message. */
    validate?: (value: T) => true | string;
}
/**
 * Tagged spawn entry — a (type, value) pair whose value position is tied to
 * the type's T within the same tuple. See F-7 in doc/findings.md.
 */
export type ComponentEntry<T = unknown> = readonly [ComponentType<T>, T];
export type ComponentBag = ReadonlyMap<ComponentType<unknown>, unknown> | ReadonlyArray<ComponentEntry<any>>;
/**
 * Helper for heterogeneous spawn-tuple arrays. `entry(Position, {x,y})`
 * preserves per-tuple T inference under strict TypeScript, eliminating the
 * `as never` casts that `ComponentType<T>` invariance otherwise forces at
 * call sites (F-7).
 */
export declare function entry<T>(type: ComponentType<T>, value: T): ComponentEntry<T>;
export {};

// file: world-resources.d.ts
import type { ResourceDescriptor, ResourceType } from './types.js';
/**
 * World-singleton resource state (#16), extracted from world.ts (O-23).
 *
 * `values` holds materialized values by name; `registry` guards against two
 * ResourceType objects colliding on a name (mirrors typeRegistry).
 * Resource changes are stamped into the world's change log through
 * `recordChange`, like component marks (O-42, SPEC §2.9).
 */
export type ResourceState = ReturnType<typeof createResourceState>;
export declare function createResourceState(recordChange: (name: string) => void): {
    get: <T>(type: ResourceType<T>) => T | undefined;
    set: <T>(type: ResourceType<T>, value: T) => void;
    markChanged: <T>(type: ResourceType<T>) => void;
    types: () => ResourceType<unknown>[];
    describe: <T>(type: ResourceType<T>) => ResourceDescriptor;
    snapshotValues: () => Record<string, unknown> | undefined;
    validateSnapshot: (snapResources: Record<string, unknown>) => void;
    clearForRestore: () => void;
    restoreValues: (snapResources: Record<string, unknown>) => void;
};

// file: world-state.d.ts
import type { ChangeCursor, ChangeLog } from './change-log.js';
import { type Rng } from './rng.js';
import { type WorldSnapshot } from './snapshot.js';
import { type TimeState } from './time.js';
import type { ComponentType, Entity } from './types.js';
import type { SortedIdSet } from './id-set.js';
import type { EntityView, QueryNode } from './query.js';
import type { ResourceState } from './world-resources.js';
/**
 * Snapshot/restore mechanics, extracted from world.ts (O-23). The public
 * `World.snapshot()`/`World.restore()` stay in the factory as orchestration
 * (they run the plugin onSnapshot/onRestore hook chains); the entity/
 * resource/clock serialization work lives here, threaded through a
 * {@link WorldStateCtx} that exposes the factory's closure state.
 */
export interface ArchetypeBucket {
    readonly key: string;
    readonly types: Set<string>;
    readonly entities: SortedIdSet;
}
export interface CompiledQuery {
    id: number;
    node: QueryNode;
    hasTickFilter: boolean;
    hasRemoved: boolean;
    /** Has a change-detection node (OnAdded/OnChanged/OnRemoved/OnChangedResource). */
    temporal: boolean;
    /**
     * O-42: the system whose `query`/`reactsTo` this is — its change window
     * is the system's. Null for any other live query, whose window runs from
     * `seenThrough` to the read and advances at tick end to `readThrough`.
     */
    owner: {
        seenThrough: number;
        runStart: number;
        running: boolean;
    } | null;
    seenThrough: number;
    readThrough: number;
    /** `time.tick` of its last read; -1 if never read (idle-driver check). */
    lastReadTick: number;
    /** Whether a read now would report anything, without counting as one. */
    peekUnread: () => boolean;
    matchingArchetypes: Set<ArchetypeBucket>;
    structuralMembers: SortedIdSet;
    onAddFns: Set<(v: EntityView) => void>;
    onRemoveFns: Set<(v: EntityView) => void>;
}
/**
 * F-3 drift-free fixed-step bookkeeping. Restore rebuilds it from the
 * snapshot's `scaledTime` (O-40): every field is a pure function of
 * `totalScaledSeconds` and `time.fixedStep` after a completed tick.
 */
export interface StepClock {
    fixedStepCounter: number;
    totalScaledSeconds: number;
    fixedStepsFired: number;
    lastQuantizedElapsedMs: number;
}
export interface WorldStateCtx {
    alive: Set<Entity>;
    stores: Map<string, Map<Entity, unknown>>;
    typeRegistry: Map<string, ComponentType<unknown>>;
    archetypes: Map<string, ArchetypeBucket>;
    entityArchetype: Map<Entity, ArchetypeBucket>;
    changes: ChangeLog;
    /** Cursors of the systems that read change-detection filters (O-42). */
    changeCursors(): ChangeCursor[];
    /**
     * Restore re-issued the snapshot's marks as stamps `base+1 … base+count`;
     * move every reader's window to match `seen` (O-42).
     */
    resumeChangeWindows(base: number, count: number, seen: Readonly<Record<string, number>>): void;
    viewCache: Map<Entity, EntityView>;
    queries: CompiledQuery[];
    time: TimeState;
    clock: StepClock;
    resources: ResourceState;
    makeView(entity: Entity): EntityView;
    ensureArchetype(types: Set<string>): ArchetypeBucket;
    getRand(): Rng;
    setRand(r: Rng): void;
    getNextId(): Entity;
    setNextId(id: Entity): void;
    setEmptyArch(arch: ArchetypeBucket): void;
}
export declare function buildSnapshot(ctx: WorldStateCtx, pruneEmpty: boolean): WorldSnapshot;
/**
 * Replace world state with `s`. The caller has already passed `s` through
 * {@link validateSnapshot} — before any state is wiped, so an invalid
 * snapshot throws cleanly instead of leaving the world half-restored — and
 * hands over the clock it parsed.
 */
export declare function applySnapshot(ctx: WorldStateCtx, s: WorldSnapshot, clock: SnapshotClock): void;
/** The clock fields of a snapshot, validated, with absent fields defaulted. */
export interface SnapshotClock {
    readonly scaledTime: number;
    readonly fixedBacklog: number;
    /** The step `fixedBacklog` is counted in; undefined means this world's. */
    readonly fixedStep: number | undefined;
}
/**
 * Check everything restore would reject — the envelope shape, every entity
 * record, resource values and the clock fields — without touching any
 * state. `world.restore()` calls it on the envelope the `onRestore` hooks
 * produce, before it applies it, so a malformed snapshot throws while the
 * live world is still intact (O-41). Returns the parsed clock.
 */
export declare function validateSnapshot(ctx: WorldStateCtx, s: WorldSnapshot): SnapshotClock;

// file: world.d.ts
import type { DomecsError, SystemicFault } from './errors.js';
import { type EmittedEvent, type EventDescriptor, type EventType, type EventView } from './events.js';
import { type InputSnapshot } from './input.js';
import { type Capability, type Plugin } from './plugin.js';
import { type Result } from './result.js';
import { type Rng, type RngState } from './rng.js';
import { type SnapshotOptions, type WorldSnapshot } from './snapshot.js';
import { type System, type SystemDef, type SystemHandle } from './scheduler.js';
import type { WorldManifest } from './manifest.js';
import { type Signal } from './signals.js';
import { type TimeState } from './time.js';
import type { ComponentBag, ComponentDescriptor, ComponentType, Entity, ResourceDescriptor, ResourceType } from './types.js';
import { type EntityView, type FieldsFromComponents, type OneShotQueryDef, type QueryDef, type QueryHooks, type QueryResult } from './query.js';
export interface WorldSignals {
    entitySpawned: Signal<Entity>;
    entityDespawned: Signal<Entity>;
    componentAdded: Signal<{
        entity: Entity;
        type: ComponentType<unknown>;
    }>;
    componentRemoved: Signal<{
        entity: Entity;
        type: ComponentType<unknown>;
    }>;
    tickStart: Signal<Readonly<TimeState>>;
    tickEnd: Signal<Readonly<TimeState>>;
    /**
     * Inspector / error-stream channel for systemic faults (no `entity` on
     * the returned `SystemFault`). Entity-scoped faults attach as `Faulted`
     * components instead; this signal carries the ones that have no entity
     * to attach to. See doc/BETTER_ERRORS.md.
     */
    faultRaised: Signal<SystemicFault>;
}
export interface World {
    readonly rand: Rng;
    readonly time: Readonly<TimeState>;
    readonly signals: WorldSignals;
    readonly events: EventView;
    readonly input: InputSnapshot;
    /**
     * Publish a new InputSnapshot for subsequent systems to read (SPEC §4 step 2).
     * Intended for use by the `@domecs/input` plugin at `onTickStart`; user code may
     * call it in headless tests to drive input deterministically. Replaces the
     * current snapshot wholesale; there is no merge.
     */
    setInput(snap: InputSnapshot): void;
    /**
     * Public idle-driver wake. External event sources — input plugins,
     * WebSocket feeds, custom drivers — call `world.requestTick()` after they
     * mutate world state from outside a tick so the idle RAF loop schedules a
     * frame. No-op when the driver is not running, when `idle: false`, or when
     * already inside a tick.
     */
    requestTick(): void;
    /**
     * Spawn an entity, optionally with an initial component bag.
     *
     * **Shallow-copy semantics (O-34):** each value is shallow-merged via
     * `ComponentType.create()`. Top-level scalars on the caller's object stop
     * tracking the live store; nested object/array refs stay shared. Prefer
     * capturing the entity id and reading via {@link World.getComponent}.
     */
    spawn(components?: ComponentBag): Entity;
    despawn(entity: Entity): void;
    /** Whether `entity` was spawned and has not been despawned (O-61). */
    isAlive(entity: Entity): boolean;
    /**
     * The entity's current view — `{ id, [ComponentName]: value }` for every
     * component it holds, the same object queries hand out — or undefined if
     * it is not alive (O-54).
     */
    getView(entity: Entity): EntityView | undefined;
    has(entity: Entity, type: ComponentType<unknown>): boolean;
    addComponent<T>(entity: Entity, type: ComponentType<T>, value: T): void;
    removeComponent(entity: Entity, type: ComponentType<unknown>): void;
    getComponent<T>(entity: Entity, type: ComponentType<T>): T | undefined;
    markChanged<T>(entity: Entity, type: ComponentType<T>): void;
    /**
     * Read a world-singleton resource. Returns the current value,
     * lazily materializing the declared default on first read, or `undefined`
     * when no default was declared and nothing has been set. The returned object
     * is the live singleton — mutating it mutates the resource.
     */
    getResource<T>(type: ResourceType<T>): T | undefined;
    /** Replace a resource's value, validate it, and mark it changed. */
    setResource<T>(type: ResourceType<T>, value: T): void;
    /**
     * Flag a resource as changed without replacing its value — for in-place
     * edits (`world.getResource(Cfg)!.v = 2`). `OnChangedResource(type)` gates
     * report it within each reader's change window (SPEC §2.9).
     */
    markResourceChanged<T>(type: ResourceType<T>): void;
    emit<T>(type: EventType<T>, payload: T): void;
    on<T>(type: EventType<T>, fn: (e: T) => void): () => void;
    /**
     * Typed overload (TYPE_EVAL §3.1): when `def.query` is a tuple of
     * `ComponentType<unknown, Name>` (typically with `as const`), the system's
     * `ctx.entities` is typed as `ReadonlyArray<EntityView<{ Name: T }>>`.
     */
    system<T extends ReadonlyArray<ComponentType<unknown, string>>, S = unknown>(name: string, def: Omit<SystemDef<FieldsFromComponents<T>, S>, 'query'> & {
        query: readonly [...T];
    }, fn: System<FieldsFromComponents<T>, S>): SystemHandle;
    system(name: string, def: SystemDef, fn: System): SystemHandle;
    /**
     * Retrieve the live {@link SystemHandle} for a registered system by `name`
     * (built-in or user-registered), or `undefined` if none is registered under
     * that name. The returned handle is the SAME one `system()` produced, so
     * flipping its `enabled` / calling `disable()` really affects scheduling on
     * the next step. This is the public escape hatch for disabling built-ins such
     * as the fault consolidator (`CONSOLIDATE_FAULTS_NAME`), whose handle is
     * otherwise unreachable.
     */
    getSystem(name: string): SystemHandle | undefined;
    /**
     * Set the time-scale multiplier. `0` is equivalent to {@link pause}; any
     * positive value updates the stored pre-pause scale, so a subsequent
     * {@link resume} restores the most recent positive scale (D-3). Negative
     * or non-finite values throw.
     */
    setScale(scale: number): void;
    pause(): void;
    resume(): void;
    componentTypes(): ComponentType<unknown>[];
    /** Every resource type registered or touched in this world. */
    resourceTypes(): ResourceType<unknown>[];
    /**
     * Iterate every live entity that currently holds component `type`, paired
     * with its value. Convenience over `world.query(Has(type))` + per-entity
     * `getComponent`; equivalent in semantics, cheaper at the call-site. F-10.
     */
    iterEntitiesWith<T>(type: ComponentType<T>): Iterable<{
        id: Entity;
        value: T;
    }>;
    archetype(entity: Entity): ComponentType<unknown>[];
    /**
     * Reflect a component's name, transient flag, default value, and field
     * schema. `fields` resolves to the explicit `schema.fields`
     * when one was declared, otherwise it is inferred from `defaults` by runtime
     * `typeof`. Lets dev tools build edit widgets from the world alone — no
     * per-app schema registry. Works on any `ComponentType` without prior
     * registration; enumerate with `componentTypes()`.
     */
    describeComponent(type: ComponentType<unknown>): ComponentDescriptor;
    /**
     * Reflect an event's name and optional payload schema. `name` is an opaque
     * diagnostic label; event identity is the internal symbol.
     */
    describeEvent(type: EventType<unknown>): EventDescriptor;
    /**
     * Reflect a resource's name, whether a default was declared, and whether it
     * has been materialized in this world. Registers the type on first call,
     * the same as any resource access.
     */
    describeResource<T>(type: ResourceType<T>): ResourceDescriptor;
    /**
     * One machine-readable manifest of the whole live world: the schema surface
     * (components/resources/events/systems/plugins/capabilities/snapshotVersion)
     * plus live debug counts (entityCount/componentCounts/archetypes). All
     * counts are O(1)/O(archetype) reads — cheap enough to poll.
     */
    describe(): WorldManifest;
    /**
     * Typed overload (D-2): an array of `ComponentType<T, Name>` produces a
     * `QueryResult` whose `EntityView` exposes `view.Name: T` typed fields.
     */
    query<T extends ReadonlyArray<ComponentType<unknown, string>>>(def: readonly [...T]): QueryResult<FieldsFromComponents<T>>;
    query(def: QueryDef): QueryResult;
    /**
     * Leak-free one-shot selectors. Unlike `query()`, these evaluate against the
     * world's current state WITHOUT registering a live query — there is nothing
     * to dispose, so they never leak. Use them for ad-hoc reads (UI labels, AI
     * decisions, asserts) where a persistent live query would accumulate. They
     * accept the same structural defs as `query()` — `Has`/`Not`/`And`/`Or`/
     * `Where` — but reject reactive `On*` nodes (`OnAdded`/`OnChanged`/
     * `OnRemoved`/`OnChangedResource`) at *compile time* via the `OneShotQueryDef`
     * negative brand, since those need per-tick delta tracking only a live query
     * or reactive system provides. (Untyped JS callers are still rejected at
     * runtime by the `oneshotNode()` guard.)
     */
    countEntities(def: OneShotQueryDef): number;
    listEntities(def: OneShotQueryDef): Entity[];
    selectViews<T extends ReadonlyArray<ComponentType<unknown, string>>>(def: readonly [...T]): EntityView<FieldsFromComponents<T>>[];
    selectViews(def: OneShotQueryDef): EntityView[];
    /**
     * Observe a query reactively and receive structural + optional per-tick
     * change callbacks. Returns an unsubscribe function.
     *
     * - `onAdd` / `onRemove` fire when membership changes.
     * - `onChange` requires `def` to include at least one change-detection node
     *   such as `OnAdded(...)`, `OnRemoved(...)`, or `OnChanged(...)`; plain `Has(...)`
     *   queries do not support reactive change ticks.
     * - When valid, `onChange` fires for current members on ticks where the
     *   change-detection portion of the query is non-empty.
     */
    observe(def: QueryDef, hooks: QueryHooks): () => void;
    /**
     * Advance the world by `dt` seconds (real-time tick).
     * - `dt > 0` → normal real-time tick; time advances by `dt`.
     * - `dt <= 0` → **heartbeat**: plugin hooks + render fire, but system
     *   execution and change-detection buffer swap are skipped. Use for
     *   lightweight UI repaints between turns (SPEC F-6).
     *
     * For the turn-based no-arg single advance, use {@link stepOnce}.
     */
    step(dt: number): void;
    /**
     * Advance exactly one tick with `delta = 0` — the turn-based single step.
     * Systems run normally; time does not advance. This is the former no-arg
     * `step()` behaviour.
     *
     * **Fixed schedule (O-37):** `fixed` systems only run when the scaled-time
     * accumulator crosses a step boundary. `stepOnce()` uses dt=0, so the
     * accumulator never advances and `fixed` systems never fire. For headless
     * tests of fixed-schedule sims, use `step(world.time.fixedStep)` (or
     * `stepN(n, dt)` with a positive `dt`).
     */
    stepOnce(): void;
    stepN(n: number, dt?: number): void;
    turn<T>(type: EventType<T>, payload: T, dt?: number): void;
    /**
     * Turn-based command with a structured result. Emits `type`, advances
     * one tick (like `turn()`), then reports `{ accepted, consumedTurn, reason,
     * events, snapshot? }`. `events` are the events emitted *during* the tick
     * (the command's downstream effects — the action event itself was flushed
     * and consumed at step 1). `accepted`/`consumedTurn`/`reason` come from
     * `opts.resolve` (default `{ accepted: true, consumedTurn: true }`).
     * `turn()` remains the void fire-and-forget form.
     */
    action<T>(type: EventType<T>, payload: T, opts?: ActionOptions): ActionResult;
    startLoop(options?: StartOptions): () => void;
    stop(): void;
    /**
     * Install a plugin. Returns `Result<dispose, DomecsError>` — failed
     * installs (thrown or returned `err()`) are quarantined: provided
     * capabilities are unwound, the world keeps running, the caller decides
     * how to surface the failure. See doc/BETTER_ERRORS.md.
     */
    use<O>(plugin: Plugin<O>, options?: O): Result<() => void, DomecsError>;
    capability<K extends string>(name: K): Capability<K>;
    snapshot(options?: SnapshotOptions): WorldSnapshot;
    restore(snap: WorldSnapshot): void;
}
export interface WorldOptions {
    seed?: number | RngState;
    headless?: boolean;
    fixedStep?: number;
    idle?: boolean;
    /**
     * Dev-mode guardrail (BETTER_ERRORS Phase 4). When true, a system that
     * returns a non-void value not shaped like `SystemResult` (e.g. typo'd
     * `{ erorrs: [...] }`) logs a one-shot console.warn naming the system.
     * Also validates each fault entry's shape
     * (`{ error: { kind: string, ... }, recoverable: boolean }`) — malformed
     * entries are warned about (one-shot per system) and skipped instead of
     * producing a vague entry with an undefined kind.
     * Off by default — production code should not pay the shape-check cost.
     * See doc/error-handling.md.
     */
    strictReturns?: boolean;
}
/**
 * Options for {@link World.startLoop}. The rAF driver is intentionally thin:
 * compute wall-clock dt, clamp it, pipe it to `step(dt)`. Consumers that
 * need custom scheduling keep using `step(dt)` directly.
 */
export interface StartOptions {
    /** Per-frame dt ceiling in ms (default 100). Prevents tab-return spikes
     *  from exploding into hundreds of fixed-step ticks. */
    dtClampMs?: number;
    /**
     * When `document.hidden` flips true, pause via {@link World.pause} if the
     * world was running; on re-show, resume **only** a pause this driver
     * initiated. App-managed pauses (`world.pause()` / Pause button) are not
     * trampled. Default true; has no effect outside a DOM. Pass `false` to
     * opt out entirely.
     *
     * Known limit: ownership is tracked as a flag, not an epoch. If the tab
     * hides while running (driver claims the pause) and app logic then calls
     * `resume()` followed by its own `pause()` while still hidden, the stale
     * ownership bit makes re-show resume over that app pause. Apps driving
     * pause state from background logic (timers, sockets) should pass
     * `pauseOnHidden: false` and manage visibility themselves.
     */
    pauseOnHidden?: boolean;
}
/** An event emitted during an {@link World.action} tick. */
export type ActionEvent = EmittedEvent;
/**
 * The game's verdict on an action, produced by an {@link ActionResolver}.
 * `consumedTurn` defaults to `accepted` when omitted (an accepted command
 * spends the turn; a rejected one does not). `reason` is for diagnostics /
 * UI on rejection.
 */
export interface ActionVerdict {
    accepted: boolean;
    consumedTurn?: boolean;
    reason?: string;
}
/**
 * Derives the verdict from the events the action produced this tick and the
 * resulting world. Policy lives here, in game code — the engine stays
 * agnostic about what "accepted" means. Omit it to default to
 * `{ accepted: true, consumedTurn: true }`.
 */
export type ActionResolver = (ctx: {
    events: readonly ActionEvent[];
    world: World;
}) => ActionVerdict;
export interface ActionOptions {
    /** dt forwarded to the underlying `step`. Omit for a turn-based tick
     *  advance (like `turn()`); a non-positive explicit dt is a heartbeat and
     *  will not process the action (see §4.0) — the result is then
     *  `{ accepted: false, consumedTurn: false, events: [] }` with a reason,
     *  the resolver is not invoked, and the action stays buffered for the
     *  next real tick. */
    dt?: number;
    /** Compute accepted/consumedTurn/reason from the tick's events + world. */
    resolve?: ActionResolver;
    /** Attach `world.snapshot()` to the result. `true` uses defaults; pass a
     *  `SnapshotOptions` object to forward options (e.g. `pruneEmptyEntities`). */
    snapshot?: boolean | SnapshotOptions;
}
/**
 * Structured result of {@link World.action}: did the command land, did it
 * spend the turn, why not, what events it produced, and an optional snapshot.
 */
export interface ActionResult {
    accepted: boolean;
    consumedTurn: boolean;
    reason?: string;
    events: readonly ActionEvent[];
    snapshot?: WorldSnapshot;
}
export declare function createWorld(options?: WorldOptions): World;
