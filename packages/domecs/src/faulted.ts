import { defineComponent } from './component.js'
import type { FaultEntry } from './errors.js'

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
export const Faulted = defineComponent<{ faults: readonly FaultEntry[] }>('Faulted', {
  defaults: { faults: [] },
})

/**
 * Priority for the built-in end-of-tick `consolidateFaults` system. Runs
 * after every user system and before render so the buffer is collapsed by
 * the time the renderer queries `[Faulted]`.
 */
export const CONSOLIDATE_FAULTS_PRIORITY = Number.MAX_SAFE_INTEGER

/** Stable name of the built-in consolidator (so it can be disabled). */
export const CONSOLIDATE_FAULTS_NAME = 'domecs:consolidateFaults'
