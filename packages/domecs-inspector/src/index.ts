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
export {
  createInspector,
  type InspectorBundle,
  type InspectorEntry,
  type InspectorOptions,
  type InspectorSnapshot,
  type InspectorView,
  type TimelineEvent,
  type TimelineEventKind,
} from './inspector.js'
