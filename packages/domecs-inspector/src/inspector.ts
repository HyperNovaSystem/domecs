import type {
  ComponentId,
  ComponentType,
  DomecsError,
  Entity,
  FaultEntry,
  JsonValue,
  Plugin,
  PluginHandle,
  Result,
  SystemicFault,
  SystemId,
  World,
} from '@domecs/core'
import { OnChanged, Faulted, Has, ok } from '@domecs/core'

/**
 * One normalized record. Both buckets share the same shape so filter
 * chains compose without per-source casing. `entity` discriminates:
 * absent ⇒ systemic.
 */
export interface InspectorEntry {
  readonly kind: string
  readonly systemId: SystemId
  readonly tick: number
  readonly wallclock: number
  readonly recoverable: boolean
  readonly entity?: Entity
  readonly component?: ComponentId
  readonly detail?: JsonValue
}

export type TimelineEventKind =
  | 'fault'
  | 'spawn'
  | 'despawn'
  | 'componentAdded'
  | 'componentRemoved'

/**
 * Optional replay-timeline event. Disabled by default; enable with
 * {@link InspectorOptions.recordStateChanges} to interleave faults with
 * structural world changes for a "what happened around tick N" view.
 *
 * `entity` is always present so the timeline is renderable per-entity
 * without a join. `fault` is set only when `eventKind === 'fault'`.
 */
export interface TimelineEvent {
  readonly eventKind: TimelineEventKind
  readonly tick: number
  readonly wallclock: number
  readonly entity: Entity
  readonly component?: ComponentId
  readonly fault?: InspectorEntry
}

/**
 * A point-in-time, serializable copy of an {@link InspectorView}: the fault
 * buckets and the timeline as plain arrays. Unlike the live view (whose arrays
 * mutate as the world runs), a snapshot is safe to hand to an agent or persist.
 */
export interface InspectorSnapshot {
  readonly entries: InspectorEntry[]
  readonly systemic: InspectorEntry[]
  readonly entityScoped: InspectorEntry[]
  readonly timeline: TimelineEvent[]
}

/**
 * Immutable, filter-composable view of the inspector's recorded entries.
 * Filters return a fresh view sharing the same buffer snapshot — the
 * underlying ring buffer keeps growing in the background but a captured
 * view stays stable.
 */
export interface InspectorView {
  readonly entries: readonly InspectorEntry[]
  readonly systemic: readonly InspectorEntry[]
  readonly entityScoped: readonly InspectorEntry[]
  readonly timeline: readonly TimelineEvent[]
  bySource(systemId: SystemId): InspectorView
  byKind(kind: string): InspectorView
  byTick(tick: number): InspectorView
  byTickRange(from: number, to: number): InspectorView
  recoverableOnly(): InspectorView
  /** Drops systemic entries (keeps only entries with an `entity`). */
  onlyFaulted(): InspectorView
  /** Drops entity-scoped entries (keeps only systemic). */
  hideFaulted(): InspectorView
  entriesFor(entity: Entity): readonly InspectorEntry[]
  /** Point-in-time serializable copy of this view (fault buckets + timeline). */
  export(): InspectorSnapshot
}

export interface InspectorOptions {
  /**
   * Ring buffer capacity for {@link InspectorView.entries}. Once full,
   * oldest entries drop. Default 1024.
   */
  bufferSize?: number
  /**
   * When true, the inspector also subscribes to `entitySpawned`,
   * `entityDespawned`, `componentAdded`, and `componentRemoved` and
   * pushes them into the timeline buffer alongside faults. Default
   * false — timeline stays fault-only.
   */
  recordStateChanges?: boolean
  /**
   * Ring buffer capacity for the timeline stream. Defaults to
   * {@link bufferSize}. Only used when `recordStateChanges` is true.
   */
  timelineBufferSize?: number
}

export interface InspectorBundle {
  /** Pass to `world.use(...)`. */
  readonly plugin: Plugin<void>
  /** Live view. Filter calls return immutable snapshot views. */
  readonly view: InspectorView
  /** Drop all recorded entries (both buckets and the timeline). */
  clear(): void
}

const DEFAULT_BUFFER = 1024

export function createInspector(opts: InspectorOptions = {}): InspectorBundle {
  const bufferSize = opts.bufferSize ?? DEFAULT_BUFFER
  const timelineSize = opts.timelineBufferSize ?? bufferSize
  const recordStateChanges = opts.recordStateChanges ?? false

  const entries: InspectorEntry[] = []
  const timeline: TimelineEvent[] = []
  // Dedupes across onAdd / onChange — the consolidator preserves entry
  // identity so a WeakSet keyed on `FaultEntry` survives reordering and
  // shrinkage of the underlying `Faulted.faults` buffer.
  const seen = new WeakSet<FaultEntry>()

  function pushEntry(e: InspectorEntry): void {
    entries.push(e)
    if (entries.length > bufferSize) entries.shift()
  }
  function pushTimeline(t: TimelineEvent): void {
    timeline.push(t)
    if (timeline.length > timelineSize) timeline.shift()
  }
  function ingestFault(entity: Entity, f: FaultEntry, wallclock: number): void {
    if (seen.has(f)) return
    seen.add(f)
    const entry: InspectorEntry = {
      kind: f.kind,
      systemId: f.source,
      tick: f.tick,
      wallclock,
      recoverable: f.recoverable,
      entity,
      ...(f.component !== undefined ? { component: f.component } : {}),
      ...(f.detail !== undefined ? { detail: f.detail } : {}),
    }
    pushEntry(entry)
    if (recordStateChanges) {
      pushTimeline({
        eventKind: 'fault',
        tick: f.tick,
        wallclock,
        entity,
        ...(f.component !== undefined ? { component: f.component } : {}),
        fault: entry,
      })
    }
  }
  function ingestSystemic(fr: SystemicFault, wallclock: number): void {
    const entry: InspectorEntry = {
      kind: fr.entry.kind,
      systemId: fr.source,
      tick: fr.tick,
      wallclock,
      recoverable: fr.entry.recoverable,
      ...(fr.entry.component !== undefined ? { component: fr.entry.component } : {}),
      ...(fr.entry.detail !== undefined ? { detail: fr.entry.detail } : {}),
    }
    pushEntry(entry)
  }

  const plugin: Plugin<void> = {
    name: '@domecs/inspector',
    install(world: World): Result<PluginHandle, DomecsError> {
      const unsubs: Array<() => void> = []

      unsubs.push(
        world.signals.faultRaised.subscribe((fr) => ingestSystemic(fr, Date.now())),
      )

      // onAdd fires for new Faulted attachments — record the whole buffer.
      // onRemove drops nothing from our log (history-preserving).
      const offHas = world.observe(Has(Faulted), {
        onAdd: (view) => {
          const f = world.getComponent(view.id, Faulted)
          if (!f) return
          const now = Date.now()
          for (const x of f.faults) ingestFault(view.id, x, now)
        },
      })
      unsubs.push(offHas)

      // OnChanged(Faulted) fires when the consolidator (or a subsequent
      // appendFault) mutates the buffer. WeakSet dedupe means we only
      // record entries we haven't seen before.
      const offChanged = world.observe(OnChanged(Faulted), {
        onChange: (view) => {
          const f = world.getComponent(view.id, Faulted)
          if (!f) return
          const now = Date.now()
          for (const x of f.faults) ingestFault(view.id, x, now)
        },
      })
      unsubs.push(offChanged)

      if (recordStateChanges) {
        unsubs.push(
          world.signals.entitySpawned.subscribe((entity) =>
            pushTimeline({
              eventKind: 'spawn',
              tick: world.time.tick,
              wallclock: Date.now(),
              entity,
            }),
          ),
        )
        unsubs.push(
          world.signals.entityDespawned.subscribe((entity) =>
            pushTimeline({
              eventKind: 'despawn',
              tick: world.time.tick,
              wallclock: Date.now(),
              entity,
            }),
          ),
        )
        unsubs.push(
          world.signals.componentAdded.subscribe(({ entity, type }: { entity: Entity; type: ComponentType<unknown> }) =>
            pushTimeline({
              eventKind: 'componentAdded',
              tick: world.time.tick,
              wallclock: Date.now(),
              entity,
              component: type.name,
            }),
          ),
        )
        unsubs.push(
          world.signals.componentRemoved.subscribe(({ entity, type }: { entity: Entity; type: ComponentType<unknown> }) =>
            pushTimeline({
              eventKind: 'componentRemoved',
              tick: world.time.tick,
              wallclock: Date.now(),
              entity,
              component: type.name,
            }),
          ),
        )
      }

      return ok({
        teardown() {
          for (const off of unsubs) off()
        },
      })
    },
  }

  const view = buildView(() => entries, () => timeline)

  return {
    plugin,
    view,
    clear() {
      entries.length = 0
      timeline.length = 0
    },
  }
}

function buildView(
  getEntries: () => readonly InspectorEntry[],
  getTimeline: () => readonly TimelineEvent[],
): InspectorView {
  return makeView(getEntries, getTimeline)
}

/**
 * Wraps a live entries source. Filter calls capture the current
 * snapshot and return a leaf view backed by an inert array — filters
 * compose without forcing the live view to re-scan.
 */
function makeView(
  getEntries: () => readonly InspectorEntry[],
  getTimeline: () => readonly TimelineEvent[],
): InspectorView {
  return {
    get entries() {
      return getEntries()
    },
    get systemic() {
      return getEntries().filter((e) => e.entity === undefined)
    },
    get entityScoped() {
      return getEntries().filter((e) => e.entity !== undefined)
    },
    get timeline() {
      return getTimeline()
    },
    bySource(systemId) {
      return leafView(getEntries().filter((e) => e.systemId === systemId), getTimeline())
    },
    byKind(kind) {
      return leafView(getEntries().filter((e) => e.kind === kind), getTimeline())
    },
    byTick(tick) {
      return leafView(getEntries().filter((e) => e.tick === tick), getTimeline())
    },
    byTickRange(from, to) {
      const lo = Math.min(from, to)
      const hi = Math.max(from, to)
      return leafView(
        getEntries().filter((e) => e.tick >= lo && e.tick <= hi),
        getTimeline(),
      )
    },
    recoverableOnly() {
      return leafView(getEntries().filter((e) => e.recoverable), getTimeline())
    },
    onlyFaulted() {
      return leafView(getEntries().filter((e) => e.entity !== undefined), getTimeline())
    },
    hideFaulted() {
      return leafView(getEntries().filter((e) => e.entity === undefined), getTimeline())
    },
    entriesFor(entity) {
      return getEntries().filter((e) => e.entity === entity)
    },
    export(): InspectorSnapshot {
      const all = getEntries()
      return {
        entries: [...all],
        systemic: all.filter((e) => e.entity === undefined),
        entityScoped: all.filter((e) => e.entity !== undefined),
        timeline: [...getTimeline()],
      }
    },
  }
}

function leafView(
  snapshot: readonly InspectorEntry[],
  timelineSnapshot: readonly TimelineEvent[],
): InspectorView {
  return makeView(
    () => snapshot,
    () => timelineSnapshot,
  )
}
