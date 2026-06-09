import type { ComponentType, Entity, EntityView, QueryResult, World } from '@domecs/core'
import { OnChanged, collectHasComponents, normalizeQuery, ok, err, type Result } from '@domecs/core'
import type { ViewDef } from './view.js'

export interface MountOptions {
  readonly slots: Readonly<Record<string, HTMLElement>>
  readonly views: ReadonlyArray<ViewDef>
}

export interface MountHandle {
  teardown(): void
}

/**
 * Discriminated union of all expected failure modes for {@link mountDOM}.
 *
 * - `slot_already_mounted`: the named slot is already claimed by a prior
 *   `mountDOM` call on the same world (SPEC §5.6 — slot mounting is exclusive).
 * - `unregistered_slot`: a view targets a slot name that was not supplied in
 *   `opts.slots`.
 * - `plugin_install_failed`: the internal renderer plugin could not be
 *   installed (e.g. `mountDOM` called twice on the same world after teardown
 *   has not fully cleaned up, or a programmer-error duplicate plugin name).
 */
export type MountError =
  | { readonly kind: 'slot_already_mounted'; readonly slot: string }
  | { readonly kind: 'unregistered_slot'; readonly slot: string }
  | { readonly kind: 'plugin_install_failed'; readonly reason: string }

const mountedSlots = new WeakMap<World, Set<string>>()

interface MountedRecord {
  el: HTMLElement
  view: EntityView
}

interface ViewState {
  def: ViewDef
  slotEl: HTMLElement
  query: QueryResult
  changedQueries: QueryResult[] | null
  mounted: Map<Entity, MountedRecord>
  pendingCreate: Map<Entity, EntityView>
  pendingDestroy: Map<Entity, EntityView>
  unsubAdd: () => void
  unsubRemove: () => void
}

/**
 * Mount a DOM renderer onto `world`.
 *
 * Returns a `Result`:
 * - `ok(handle)` — renderer installed; call `handle.teardown()` to unmount.
 * - `err({ kind: 'slot_already_mounted', slot })` — the named slot is already
 *   claimed on this world (SPEC §5.6).
 * - `err({ kind: 'unregistered_slot', slot })` — a view targets a slot that
 *   was not supplied in `opts.slots`.
 * - `err({ kind: 'plugin_install_failed', reason })` — the internal renderer
 *   plugin failed to install (e.g. duplicate call on same world without prior
 *   teardown).
 */
export function mountDOM(world: World, opts: MountOptions): Result<MountHandle, MountError> {
  const claimed = mountedSlots.get(world) ?? new Set<string>()
  for (const slotName of Object.keys(opts.slots)) {
    if (claimed.has(slotName)) {
      return err({ kind: 'slot_already_mounted', slot: slotName })
    }
  }
  for (const slotName of Object.keys(opts.slots)) claimed.add(slotName)
  mountedSlots.set(world, claimed)

  const states: ViewState[] = []
  // Roll back everything built so far before an error return: slot claims,
  // plus the live queries and onAdd/onRemove subscriptions of every view
  // already processed (otherwise a failed mount leaks reactive queries that
  // keep accumulating per-tick deltas forever).
  const rollback = (): void => {
    for (const slotName of Object.keys(opts.slots)) claimed.delete(slotName)
    for (const state of states) {
      state.unsubAdd()
      state.unsubRemove()
      state.query.dispose()
      for (const q of state.changedQueries ?? []) q.dispose()
    }
  }
  for (const def of opts.views) {
    const slotEl = opts.slots[def.slot]
    if (!slotEl) {
      rollback()
      return err({ kind: 'unregistered_slot', slot: def.slot })
    }
    const q = world.query(def.query)
    const changedTypes = resolveChangedTypes(def)
    const state: ViewState = {
      def,
      slotEl,
      query: q,
      changedQueries: changedTypes.length > 0
        ? changedTypes.map((c) => world.query(OnChanged(c)))
        : null,
      mounted: new Map(),
      pendingCreate: new Map(),
      pendingDestroy: new Map(),
      unsubAdd: () => {},
      unsubRemove: () => {},
    }
    state.unsubAdd = q.onAdd((e) => {
      state.pendingDestroy.delete(e.id)
      state.pendingCreate.set(e.id, e)
    })
    state.unsubRemove = q.onRemove((e) => {
      state.pendingCreate.delete(e.id)
      state.pendingDestroy.set(e.id, e)
    })
    for (const e of q.entities) state.pendingCreate.set(e.id, e)
    states.push(state)
  }

  const rendererPlugin = {
    name: '@domecs/dom/renderer',
    install() {
      return ok({
        onRender() {
          for (const state of states) commit(state)
        },
      })
    },
  }

  let useResult: Result<() => void, { kind: string; [k: string]: unknown }>
  try {
    useResult = world.use(rendererPlugin)
  } catch (e) {
    // world.use throws synchronously for programmer-error conditions
    // (e.g. duplicate plugin name). Map to an enumerable MountError.
    const reason = e instanceof Error ? e.message : String(e)
    rollback()
    return err({ kind: 'plugin_install_failed', reason })
  }

  if (!useResult.ok) {
    // The install function returned an err Result (e.g. plugin_install_failed
    // from a caught throw inside install). Map the error kind to a reason string.
    const reason = `${useResult.error.kind}`
    rollback()
    return err({ kind: 'plugin_install_failed', reason })
  }
  const unuse = useResult.value

  return ok({
    teardown() {
      unuse()
      for (const state of states) {
        state.unsubAdd()
        state.unsubRemove()
        state.query.dispose()
        for (const q of state.changedQueries ?? []) q.dispose()
        for (const [, rec] of state.mounted) {
          state.def.destroy?.(rec.el, rec.view)
          rec.el.remove()
        }
        state.mounted.clear()
        state.pendingCreate.clear()
        state.pendingDestroy.clear()
      }
      const set = mountedSlots.get(world)
      if (set) for (const k of Object.keys(opts.slots)) set.delete(k)
    },
  })
}

function commit(state: ViewState): void {
  for (const id of state.pendingDestroy.keys()) {
    const rec = state.mounted.get(id)
    if (rec) {
      state.def.destroy?.(rec.el, rec.view)
      rec.el.remove()
      state.mounted.delete(id)
    }
  }
  state.pendingDestroy.clear()

  for (const [id, view] of state.pendingCreate) {
    if (state.mounted.has(id)) continue
    const el = state.def.create(view)
    state.slotEl.appendChild(el)
    state.mounted.set(id, { el, view })
  }
  state.pendingCreate.clear()

  if (state.def.update && state.mounted.size > 0) {
    const changed = collectChanged(state.changedQueries)
    if (!changed) {
      for (const view of state.query.entities) {
        const rec = state.mounted.get(view.id)
        if (!rec) continue
        rec.view = view
        state.def.update(rec.el, view)
      }
    } else if (changed.size > 0) {
      for (const view of state.query.entities) {
        if (!changed.has(view.id)) continue
        const rec = state.mounted.get(view.id)
        if (!rec) continue
        rec.view = view
        state.def.update(rec.el, view)
      }
    }
  }
}

function collectChanged(changedQueries: QueryResult[] | null): Set<Entity> | null {
  if (!changedQueries) return null
  const out = new Set<Entity>()
  for (const q of changedQueries) {
    for (const e of q.entities) out.add(e.id)
  }
  return out
}

/**
 * Resolve the set of components this view should treat as redraw triggers.
 *
 * - `changedOn` omitted / `{ mode: 'auto' }`: derive from the `Has(T)` leaves
 *   of the view's query. P-3.
 * - `{ mode: 'legacy' }`: return `[]` — callers map an empty array to
 *   `changedQueries: null`, which causes `commit` to update every mounted
 *   entity every tick (legacy "redraw everything" behaviour).
 * - `{ mode: 'explicit', types }`: return `types` directly.
 */
function resolveChangedTypes(def: ViewDef): ReadonlyArray<ComponentType<unknown>> {
  if (def.changedOn !== undefined) {
    if (def.changedOn.mode === 'explicit') return def.changedOn.types
    if (def.changedOn.mode === 'legacy') return []
    // 'auto' — fall through to auto-derive below
  }
  // changedOn omitted or { mode: 'auto' }
  if (!def.update) return []
  const collected = collectHasComponents(normalizeQuery(def.query))
  return Array.from(collected.values())
}
