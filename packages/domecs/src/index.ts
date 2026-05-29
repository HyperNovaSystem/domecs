export { defineComponent } from './component.js'
export { defineResource } from './resource.js'
export { createWorld } from './world.js'
export { defineEvent } from './events.js'
export { createRng, restoreRng, seedToState } from './rng.js'
export { createTime, quantizeMs } from './time.js'
export {
  Has,
  Not,
  Or,
  And,
  Added,
  Removed,
  Changed,
  Where,
  ChangedResource,
  normalize as normalizeQuery,
  collectHasComponents,
} from './query.js'
export type { World, WorldOptions, WorldSignals } from './world.js'
export type { EventType, EventView } from './events.js'
export type { InputSnapshot, PointerSnapshot, GamepadSnapshot } from './input.js'
export type {
  System,
  SystemContext,
  SystemDef,
  SystemHandle,
  SystemSchedule,
} from './scheduler.js'
export type { Signal } from './signals.js'
export { definePlugin } from './plugin.js'
export type { Plugin, PluginSpec, PluginHandle, Capability } from './plugin.js'
export { SNAPSHOT_VERSION } from './snapshot.js'
export type { SnapshotOptions, WorldSnapshot } from './snapshot.js'
export type { Rng, RngState } from './rng.js'
export type { TimeState } from './time.js'
export { entry } from './types.js'
export type {
  ComponentType,
  ComponentValue,
  ComponentOptions,
  ComponentBag,
  ComponentEntry,
  ComponentDescriptor,
  ComponentSchema,
  FieldSchema,
  FieldKind,
  ResourceType,
  ResourceValue,
  ResourceOptions,
  Entity,
} from './types.js'
export type {
  QueryDef,
  QueryHooks,
  QueryNode,
  QueryResult,
  QueryShorthand,
  NodeOrComponent,
  EntityView,
  FieldsFromComponents,
} from './query.js'

// BETTER_ERRORS Phase 1 — Result discipline + errors as data.
export {
  ok,
  err,
  isOk,
  isErr,
  mapR,
  mapErr,
  andThen,
  unwrapOr,
  tap,
  tapErr,
  all,
  attempt,
  attemptAsync,
  match,
  assertNever,
  normalizeCause,
  toJsonValue,
  MAX_CAUSE_DEPTH,
} from './result.js'
export type { Result, JsonValue, SerializedError } from './result.js'
export { describeError } from './errors.js'
export type {
  DomecsError,
  PluginError,
  PluginResult,
  SystemFault,
  SystemResult,
  SystemicFault,
  SystemId,
  ComponentId,
  EventId,
  FaultEntry,
} from './errors.js'
export {
  Faulted,
  CONSOLIDATE_FAULTS_NAME,
  CONSOLIDATE_FAULTS_PRIORITY,
} from './faulted.js'
