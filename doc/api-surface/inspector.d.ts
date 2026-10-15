// file: index.d.ts
/**
 * @domecs/inspector — headless fault/state observation for dev tools.
 *
 * Surfaces `Faulted` entity components and systemic faults from
 * `world.signals.faultRaised` into a queryable, filter-composable view.
 * See doc/BETTER_ERRORS.md §"Phase 3 — Inspector integration".
 *
 * UI panels (Studio, custom devtools) wrap this surface — the package
 * itself has no DOM dependency.
 */
export { createInspector, type InspectorBundle, type InspectorEntry, type InspectorOptions, type InspectorSnapshot, type InspectorView, type TimelineEvent, type TimelineEventKind, } from './inspector.js';

// file: inspector.d.ts
import type { ComponentId, Entity, JsonValue, Plugin, SystemId } from '@domecs/core';
/**
 * One normalized record. Both buckets share the same shape so filter
 * chains compose without per-source casing. `entity` discriminates:
 * absent ⇒ systemic.
 */
export interface InspectorEntry {
    readonly kind: string;
    readonly systemId: SystemId;
    readonly tick: number;
    readonly wallclock: number;
    readonly recoverable: boolean;
    readonly entity?: Entity;
    readonly component?: ComponentId;
    readonly detail?: JsonValue;
}
export type TimelineEventKind = 'fault' | 'spawn' | 'despawn' | 'componentAdded' | 'componentRemoved';
/**
 * Optional replay-timeline event. Disabled by default; enable with
 * {@link InspectorOptions.recordStateChanges} to interleave faults with
 * structural world changes for a "what happened around tick N" view.
 *
 * `entity` is always present so the timeline is renderable per-entity
 * without a join. `fault` is set only when `eventKind === 'fault'`.
 */
export interface TimelineEvent {
    readonly eventKind: TimelineEventKind;
    readonly tick: number;
    readonly wallclock: number;
    readonly entity: Entity;
    readonly component?: ComponentId;
    readonly fault?: InspectorEntry;
}
/**
 * A point-in-time, serializable copy of an {@link InspectorView}: the fault
 * buckets and the timeline as plain arrays. Unlike the live view (whose
 * getters return the current contents on each read), a snapshot is safe to
 * hand to an agent or persist.
 */
export interface InspectorSnapshot {
    readonly entries: InspectorEntry[];
    readonly systemic: InspectorEntry[];
    readonly entityScoped: InspectorEntry[];
    readonly timeline: TimelineEvent[];
}
/**
 * Immutable, filter-composable view of the inspector's recorded entries.
 * Filters return a fresh view over a copy of the entries and the timeline
 * taken when filtering — the ring buffers keep changing in the background,
 * but a filtered view stays stable (O-60). Restoring a snapshot does not
 * record its faults again when an entry with the same entity, source, kind,
 * tick, component and detail is already recorded; a fault raised again by
 * a later tick is recorded again.
 */
export interface InspectorView {
    readonly entries: readonly InspectorEntry[];
    readonly systemic: readonly InspectorEntry[];
    readonly entityScoped: readonly InspectorEntry[];
    readonly timeline: readonly TimelineEvent[];
    bySource(systemId: SystemId): InspectorView;
    byKind(kind: string): InspectorView;
    byTick(tick: number): InspectorView;
    byTickRange(from: number, to: number): InspectorView;
    recoverableOnly(): InspectorView;
    /** Drops systemic entries (keeps only entries with an `entity`). */
    onlyFaulted(): InspectorView;
    /** Drops entity-scoped entries (keeps only systemic). */
    hideFaulted(): InspectorView;
    entriesFor(entity: Entity): readonly InspectorEntry[];
    /** Point-in-time serializable copy of this view (fault buckets + timeline). */
    export(): InspectorSnapshot;
}
export interface InspectorOptions {
    /**
     * Ring buffer capacity for {@link InspectorView.entries}. Once full,
     * oldest entries drop. Default 1024.
     */
    bufferSize?: number;
    /**
     * When true, the inspector also subscribes to `entitySpawned`,
     * `entityDespawned`, `componentAdded`, and `componentRemoved` and
     * pushes them into the timeline buffer alongside faults. Default
     * false — timeline stays fault-only.
     */
    recordStateChanges?: boolean;
    /**
     * Ring buffer capacity for the timeline stream. Defaults to
     * {@link bufferSize}. Only used when `recordStateChanges` is true.
     */
    timelineBufferSize?: number;
}
export interface InspectorBundle {
    /** Pass to `world.use(...)`. */
    readonly plugin: Plugin<void>;
    /** Live view. Filter calls return immutable snapshot views. */
    readonly view: InspectorView;
    /** Drop all recorded entries (both buckets and the timeline). */
    clear(): void;
}
export declare function createInspector(opts?: InspectorOptions): InspectorBundle;
