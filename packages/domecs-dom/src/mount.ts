import type { ComponentType, Entity, EntityView, QueryResult, World } from '@domecs/core'
import { Changed, collectHasComponents, normalizeQuery, ok } from '@domecs/core'
import type { ViewDef } from './view.js'

export interface MountOptions {
  readonly slots: Readonly<Record<string, HTMLElement>>
  readonly views: ReadonlyArray<ViewDef>
}

export interface MountHandle {
  teardown(): void
}

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

export function mountDOM(world: World, opts: MountOptions): MountHandle {
  const claimed = mountedSlots.get(world) ?? new Set<string>()
  for (const slotName of Object.keys(opts.slots)) {
    if (claimed.has(slotName)) {
      throw new Error(
        `@domecs/dom: slot "${slotName}" already mounted on this world (SPEC §5.6 — slot mounting is exclusive)`,
      )
    }
  }
  for (const slotName of Object.keys(opts.slots)) claimed.add(slotName)
  mountedSlots.set(world, claimed)

  const states: ViewState[] = []
  for (const def of opts.views) {
    const slotEl = opts.slots[def.slot]
    if (!slotEl) {
      throw new Error(
        `@domecs/dom: view targets slot "${def.slot}" which was not registered in mountDOM({ slots })`,
      )
    }
    const q = world.query(def.query)
    const changedTypes = resolveChangedTypes(def)
    const state: ViewState = {
      def,
      slotEl,
      query: q,
      changedQueries: changedTypes.length > 0
        ? changedTypes.map((c) => world.query(Changed(c)))
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
  const useResult = world.use(rendererPlugin)
  if (!useResult.ok) {
    // Installing the in-process renderer is part of mountDOM's contract; a
    // failure here is a programmer error (e.g. duplicate plugin name on the
    // same world), not a recoverable seam — surface it loudly.
    throw new Error(
      `@domecs/dom: failed to install renderer plugin: ${useResult.error.kind}`,
    )
  }
  const unuse = useResult.value

  return {
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
  }
}

function commit(state: ViewState): void {
  for (const [id, view] of state.pendingDestroy) {
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
 * - `changedOn` omitted (default): derive from the `Has(T)` leaves of the
 *   view's query. This is the principle-of-least-surprise default — a view
 *   over `[Position, Velocity]` redraws when either component changes. P-3.
 * - `changedOn: []` (explicit empty): opt back into the legacy "redraw every
 *   tick" behaviour. Useful for animation-style views that depend on time,
 *   not component identity.
 * - `changedOn: [Type, ...]`: explicit list. Used for finer-grained gating
 *   (e.g. a view over `[Position, Sprite]` that only cares about `Position`).
 */
function resolveChangedTypes(def: ViewDef): ReadonlyArray<ComponentType<unknown>> {
  if (def.changedOn !== undefined) return def.changedOn
  if (!def.update) return []
  const collected = collectHasComponents(normalizeQuery(def.query))
  return Array.from(collected.values())
}
