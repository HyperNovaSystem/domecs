import type { ComponentType, Entity, EntityView, QueryNode, QueryResult, World } from '@domecs/core'
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
 * - `invalid_view_query`: a view's query contains a temporal node
 *   (`OnAdded`/`OnRemoved`/`OnChanged`/`OnChangedResource`). View membership
 *   is a standing set; use `changedOn` for change-gated redraws (O-52).
 * - `invalid_changed_on`: a view with `update` has no redraw trigger —
 *   `{ mode: 'explicit', types: [] }`, or `auto` over a query with no
 *   positive `Has`/`Where` leaf. Use `{ mode: 'legacy' }` to redraw every
 *   tick on purpose (O-55).
 */
export type MountError =
  | { readonly kind: 'slot_already_mounted'; readonly slot: string }
  | { readonly kind: 'unregistered_slot'; readonly slot: string }
  | { readonly kind: 'plugin_install_failed'; readonly reason: string }
  | { readonly kind: 'invalid_view_query'; readonly slot: string; readonly reason: string }
  | { readonly kind: 'invalid_changed_on'; readonly slot: string; readonly reason: string }

const mountedSlots = new WeakMap<World, Set<string>>()
// O-55 (D7): each mountDOM installs its own renderer plugin, so a world can
// take several mounts on distinct slots (SPEC §5.6).
const mountCount = new WeakMap<World, number>()

interface MountedRecord {
  el: HTMLElement
  view: EntityView
}

interface ViewState {
  world: World
  def: ViewDef
  slotEl: HTMLElement
  query: QueryResult
  changedQueries: QueryResult[] | null
  mounted: Map<Entity, MountedRecord>
  pendingCreate: Map<Entity, EntityView>
  pendingDestroy: Map<Entity, EntityView>
  /**
   * O-53: entities whose `create` threw. They stay unmounted until they are
   * marked changed (the view's `changedOn` types) or re-enter the query, so
   * a failing `create` is not retried — and rethrown — every frame.
   */
  failed: Set<Entity>
  /**
   * O-53: the queries that trigger a failed create's retry — the redraw
   * triggers, or for a view without them (create-only, `legacy`) `OnChanged`
   * of its `Has` leaves. Created on the first failure.
   */
  retryQueries: QueryResult[] | null
  /**
   * O-52: the query has a `Where` filter. Structural onAdd/onRemove ignore
   * `Where`, so membership is reconciled against the filtered
   * `query.entities` at each commit.
   */
  filtered: boolean
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
    const node = normalizeQuery(def.query)
    const temporal = findKind(node, TEMPORAL_KINDS)
    if (temporal) {
      rollback()
      return err({
        kind: 'invalid_view_query',
        slot: def.slot,
        reason: `view queries cannot contain temporal nodes (found ${temporal}); use changedOn for change-gated redraws`,
      })
    }
    const changedTypes = resolveChangedTypes(def)
    if (changedTypes === null) {
      rollback()
      return err({
        kind: 'invalid_changed_on',
        slot: def.slot,
        reason:
          def.changedOn?.mode === 'explicit'
            ? 'changedOn { mode: "explicit" } needs at least one type'
            : 'the view has update but its query has no Has/Where leaf to redraw on; pass changedOn explicitly, or { mode: "legacy" } to redraw every tick',
      })
    }
    const q = world.query(def.query)
    const state: ViewState = {
      world,
      def,
      slotEl,
      query: q,
      changedQueries: changedTypes.length > 0
        ? changedTypes.map((c) => world.query(OnChanged(c)))
        : null,
      mounted: new Map(),
      pendingCreate: new Map(),
      pendingDestroy: new Map(),
      failed: new Set(),
      retryQueries: null,
      filtered: findKind(node, WHERE_KIND) !== null,
      unsubAdd: () => {},
      unsubRemove: () => {},
    }
    state.unsubAdd = q.onAdd((e) => {
      state.pendingDestroy.delete(e.id)
      state.pendingCreate.set(e.id, e)
    })
    state.unsubRemove = q.onRemove((e) => {
      state.pendingCreate.delete(e.id)
      state.failed.delete(e.id)
      state.pendingDestroy.set(e.id, e)
    })
    for (const e of q.entities) state.pendingCreate.set(e.id, e)
    states.push(state)
  }

  const n = (mountCount.get(world) ?? 0) + 1
  mountCount.set(world, n)
  const rendererPlugin = {
    name: n === 1 ? '@domecs/dom/renderer' : `@domecs/dom/renderer#${n}`,
    install() {
      return ok({
        onRender() {
          // O-53: every view commits even if a callback throws; the first
          // error is rethrown once the frame's DOM is consistent.
          const errors: unknown[] = []
          for (const state of states) commit(state, errors)
          if (errors.length > 0) throw errors[0]
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
      const errors: unknown[] = []
      for (const state of states) {
        state.unsubAdd()
        state.unsubRemove()
        state.query.dispose()
        for (const q of state.changedQueries ?? []) q.dispose()
        if (state.retryQueries !== state.changedQueries) {
          for (const q of state.retryQueries ?? []) q.dispose()
        }
        for (const [, rec] of state.mounted) unmount(state, rec, errors)
        state.mounted.clear()
        state.pendingCreate.clear()
        state.pendingDestroy.clear()
        state.failed.clear()
      }
      const set = mountedSlots.get(world)
      if (set) for (const k of Object.keys(opts.slots)) set.delete(k)
      if (errors.length > 0) throw errors[0]
    },
  })
}

const TEMPORAL_KINDS: ReadonlySet<QueryNode['kind']> = new Set([
  'added',
  'removed',
  'changed',
  'changedResource',
])
const WHERE_KIND: ReadonlySet<QueryNode['kind']> = new Set(['where'])

function findKind(node: QueryNode, kinds: ReadonlySet<QueryNode['kind']>): string | null {
  if (kinds.has(node.kind)) return node.kind
  if (node.kind === 'not') return findKind(node.child, kinds)
  if (node.kind === 'and' || node.kind === 'or') {
    for (const c of node.children) {
      const hit = findKind(c, kinds)
      if (hit) return hit
    }
  }
  return null
}

/**
 * O-52: bring a `Where` view's pending maps in line with the filtered
 * membership — create for entities that match now (including ones that
 * started matching through a field change), destroy for mounted entities
 * that no longer match.
 */
function reconcileFiltered(state: ViewState): void {
  const members = new Map<Entity, EntityView>()
  for (const view of state.query.entities) members.set(view.id, view)
  for (const id of state.pendingCreate.keys()) {
    if (!members.has(id)) state.pendingCreate.delete(id)
  }
  for (const id of state.failed) {
    if (!members.has(id)) state.failed.delete(id)
  }
  for (const [id, view] of members) {
    if (!state.mounted.has(id) && !state.pendingCreate.has(id) && !state.failed.has(id)) {
      state.pendingCreate.set(id, view)
    }
  }
  for (const [id, rec] of state.mounted) {
    if (!members.has(id) && !state.pendingDestroy.has(id)) state.pendingDestroy.set(id, rec.view)
  }
}

/**
 * Run one view callback. O-53: a throw is collected rather than propagated,
 * so one bad callback cannot leave the pending maps half-processed and jam
 * every later commit. Returns whether the callback completed.
 */
function guard(errors: unknown[], fn: () => void): boolean {
  try {
    fn()
    return true
  } catch (e) {
    errors.push(e)
    return false
  }
}

function unmount(state: ViewState, rec: MountedRecord, errors: unknown[]): void {
  if (state.def.destroy) guard(errors, () => state.def.destroy!(rec.el, rec.view))
  rec.el.remove()
}

function mount(state: ViewState, id: Entity, view: EntityView, errors: unknown[]): boolean {
  let el: HTMLElement | undefined
  if (!guard(errors, () => { el = state.def.create(view) })) {
    state.failed.add(id)
    ensureRetryQueries(state)
    return false
  }
  state.failed.delete(id)
  state.slotEl.appendChild(el!)
  state.mounted.set(id, { el: el!, view })
  return true
}

/**
 * Commit one view. O-53: the pending maps are taken over before any callback
 * runs, and each callback is isolated by {@link guard}, so a throwing
 * `create`/`update`/`destroy` affects only its own entity: a failed destroy
 * still removes the node, a failed update leaves it mounted, and a failed
 * create leaves the entity unmounted until it is next marked changed.
 */
function commit(state: ViewState, errors: unknown[]): void {
  if (state.filtered) reconcileFiltered(state)
  const pendingDestroy = state.pendingDestroy
  const pendingCreate = state.pendingCreate
  state.pendingDestroy = new Map()
  state.pendingCreate = new Map()
  for (const id of pendingDestroy.keys()) {
    const rec = state.mounted.get(id)
    if (rec) {
      state.mounted.delete(id)
      unmount(state, rec, errors)
    }
  }

  // O-16: an entity removed and re-added within one commit window (e.g. a
  // same-tick remove-all/re-add projection) arrives here with its node still
  // mounted — onAdd cancelled the pending destroy. The double-create guard
  // must not silently drop it: the node's content predates the re-add and the
  // OnChanged gate never fires for it (a re-add is an Added mark, not a
  // Changed mark). Repaint it in the update phase below, or rebuild the node
  // outright when create() is the only painter.
  let readded: Set<Entity> | null = null
  let created: Set<Entity> | null = null
  for (const [id, view] of pendingCreate) {
    const existing = state.mounted.get(id)
    if (existing) {
      if (state.def.update) {
        existing.view = view
        ;(readded ??= new Set()).add(id)
      } else {
        state.mounted.delete(id)
        unmount(state, existing, errors)
        mount(state, id, view, errors)
      }
      continue
    }
    // A callback earlier in this commit may have despawned it. O-55 (D2):
    // create sees the entity as it is now, not as it was when it matched.
    const current = state.world.getView(id)
    if (!current) continue
    if (!mount(state, id, current, errors)) continue
    // O-2 first paint: under change-gated modes (auto/explicit), a newly
    // mounted entity has no OnChanged mark, so the gated update phase would
    // never run for it. Track created ids and merge them into the update
    // phase below — the paint then uses a FRESH commit-time view (components
    // added later in the same window are visible, unlike the onAdd-time
    // `view` captured here) and an entity that was also marked changed this
    // window still gets exactly one update() per commit. Skip when
    // changedQueries is null (legacy / create-only): the full-update path
    // already paints every mounted entity this commit.
    if (state.def.update && state.changedQueries !== null) {
      ;(created ??= new Set()).add(id)
    }
  }

  const update = state.def.update
  const changed = update && state.mounted.size > 0 ? collectChanged(state.changedQueries) : null
  // O-53: retry a failed create once the entity is marked changed — the
  // change may be what fixes it.
  if (state.failed.size > 0 && state.retryQueries) {
    const marked = state.retryQueries === state.changedQueries && changed
      ? changed
      : collectChanged(state.retryQueries)!
    for (const id of Array.from(state.failed).sort(ascending)) {
      const view = marked.get(id)
      if (!view) continue
      if (mount(state, id, view, errors) && update && changed) (created ??= new Set()).add(id)
    }
  }

  if (update && state.mounted.size > 0) {
    if (!changed) {
      for (const view of state.query.entities) {
        const rec = state.mounted.get(view.id)
        if (!rec) continue
        rec.view = view
        guard(errors, () => update(rec.el, view))
      }
    } else if (changed.size > 0 || readded !== null || created !== null) {
      // O-54: visit only the entities to repaint, in id order, rather than
      // every member of the view.
      const ids = new Set<Entity>(changed.keys())
      for (const id of readded ?? []) ids.add(id)
      for (const id of created ?? []) ids.add(id)
      for (const id of Array.from(ids).sort(ascending)) {
        const rec = state.mounted.get(id)
        if (!rec) continue
        const view = changed.get(id) ?? state.world.getView(id)
        if (!view) continue // despawned during this commit
        rec.view = view
        guard(errors, () => update(rec.el, view))
      }
    }
  }
}

function ascending(a: Entity, b: Entity): number {
  return a - b
}

/**
 * O-53: start watching for the changes that retry a failed create. Reading
 * the new queries once opens their windows now, so only marks made after
 * the failure trigger a retry.
 */
function ensureRetryQueries(state: ViewState): void {
  if (state.retryQueries) return
  if (state.changedQueries) {
    state.retryQueries = state.changedQueries
    return
  }
  const types = state.def.changedOn?.mode === 'explicit'
    ? state.def.changedOn.types
    : Array.from(collectHasComponents(normalizeQuery(state.def.query)).values())
  state.retryQueries = types.map((c) => state.world.query(OnChanged(c)))
  collectChanged(state.retryQueries)
}

/** Entities marked changed on a redraw trigger, with their current views. */
function collectChanged(changedQueries: QueryResult[] | null): Map<Entity, EntityView> | null {
  if (!changedQueries) return null
  const out = new Map<Entity, EntityView>()
  for (const q of changedQueries) {
    for (const e of q.entities) out.set(e.id, e)
  }
  return out
}

/**
 * Resolve the set of components this view should treat as redraw triggers.
 *
 * - `changedOn` omitted / `{ mode: 'auto' }`: derive from the positive
 *   `Has(T)` and `Where(T, …)` leaves of the view's query. P-3, O-55.
 * - `{ mode: 'legacy' }`: return `[]` — callers map an empty array to
 *   `changedQueries: null`, which causes `commit` to update every mounted
 *   entity every tick (legacy "redraw everything" behaviour).
 * - `{ mode: 'explicit', types }`: return `types` directly.
 *
 * Returns null when a view with `update` would have no trigger (O-55 D5):
 * an empty explicit list, or an auto query with no positive leaf — either
 * used to fall back to redrawing every tick without saying so.
 */
function resolveChangedTypes(def: ViewDef): ReadonlyArray<ComponentType<unknown>> | null {
  if (def.changedOn?.mode === 'explicit') {
    return def.changedOn.types.length > 0 || !def.update ? def.changedOn.types : null
  }
  if (def.changedOn?.mode === 'legacy') return []
  if (!def.update) return []
  const leaves = positiveLeafTypes(normalizeQuery(def.query))
  return leaves.length > 0 ? leaves : null
}

/** The component types of the `Has`/`Where` leaves not under a `Not`. */
function positiveLeafTypes(node: QueryNode): ComponentType<unknown>[] {
  const out = collectHasComponents(node)
  const visit = (n: QueryNode, negated: boolean): void => {
    if (n.kind === 'where' && !negated) out.set(n.type.name, n.type)
    else if (n.kind === 'not') visit(n.child, !negated)
    else if (n.kind === 'and' || n.kind === 'or') for (const c of n.children) visit(c, negated)
  }
  visit(node, false)
  return Array.from(out.values())
}
