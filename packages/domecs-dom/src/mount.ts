import type { ComponentType, Entity, EntityView, QueryNode, QueryResult, ResourceType, World } from '@domecs/core'
import {
  And,
  OnAdded,
  OnChanged,
  OnChangedResource,
  OnRemoved,
  Or,
  collectHasComponents,
  normalizeQuery,
  ok,
  err,
  type Result,
} from '@domecs/core'
import { ENTITY_ATTRIBUTE, entityOf } from './entity.js'
import { forgetPaint, paint } from './paint.js'
import type { PanelDef, ViewDef } from './view.js'

export interface MountOptions {
  readonly slots: Readonly<Record<string, HTMLElement>>
  readonly views: ReadonlyArray<ViewDef<any>>
  /**
   * Panels (H-7): markup derived from the world, patched into a slot of
   * their own. See {@link PanelDef}.
   */
  readonly panels?: ReadonlyArray<PanelDef>
  /**
   * Stamp every mounted element with `data-entity="<id>"` so `entityOf` and
   * `MountHandle.on` can route DOM events back to entities (H-9). Default
   * `true`.
   */
  readonly stamp?: boolean
}

/** One view's work since mount (P-4, O-5), from {@link MountHandle.stats}. */
export interface ViewStats {
  readonly view: ViewDef<any>
  readonly slot: string
  /** Elements mounted now. */
  readonly mounted: number
  readonly creates: number
  readonly updates: number
  readonly destroys: number
  /** Wall-clock milliseconds the view's last commit took. */
  readonly lastCommitMs: number
}

/** One panel's work since mount (P-4). */
export interface PanelStats {
  readonly slot: string
  readonly renders: number
  /** Renders whose markup differed, so the DOM was written. */
  readonly paints: number
  readonly lastCommitMs: number
}

export interface MountHandle {
  teardown(): void
  /**
   * What each view and panel of this mount has done since it was mounted
   * (P-4, O-5): creates, updates and destroys per view, renders and paints
   * per panel, and how long the last commit took — to find the view that is
   * half the frame.
   */
  stats(): { readonly views: ViewStats[]; readonly panels: PanelStats[] }
  /**
   * The element `view` (one of this mount's views) has mounted for `entity`,
   * or `undefined` — for a selection outline, a tooltip, a measurement
   * (H-8). An element waiting for its parent (`ViewDef.parent`) is mounted
   * but not in the page.
   */
  elementOf(view: ViewDef<any>, entity: Entity): HTMLElement | undefined
  /**
   * Listen for `type` on a slot and call `fn` with the entity whose mounted
   * element the event happened in — the innermost, for nested views — and
   * the event (H-9). Events outside this mount's elements are ignored.
   * Returns a function that stops listening; teardown stops them all. Throws
   * for a slot this mount was not given.
   */
  on<K extends keyof HTMLElementEventMap>(
    slot: string,
    type: K,
    fn: (entity: Entity, event: HTMLElementEventMap[K]) => void,
  ): () => void
}

/**
 * Discriminated union of all expected failure modes for {@link mountDOM}.
 *
 * - `slot_already_mounted`: the named slot is already claimed by a prior
 *   `mountDOM` call on the same world (SPEC §5.6 — slot mounting is exclusive).
 * - `unregistered_slot`: a view or panel targets a slot name that was not
 *   supplied in `opts.slots`.
 * - `plugin_install_failed`: the internal renderer plugin could not be
 *   installed (e.g. `mountDOM` called twice on the same world after teardown
 *   has not fully cleaned up, or a programmer-error duplicate plugin name).
 * - `invalid_view_query`: a view's query contains a temporal node
 *   (`OnAdded`/`OnRemoved`/`OnChanged`/`OnChangedResource`). View membership
 *   is a standing set; use `changedOn` for change-gated redraws (O-52).
 * - `invalid_changed_on`: a view with `update` has no redraw trigger —
 *   `{ mode: 'explicit', types: [] }` without resources, or `auto` over a
 *   query with no positive `Has`/`Where` leaf. Use `{ mode: 'legacy' }` to
 *   redraw every tick on purpose (O-55).
 * - `invalid_parent`: a view's `parent.view` is not one of this mount's
 *   views, or parents form a cycle (H-8).
 * - `invalid_panel`: a panel shares its slot with a view or another panel
 *   (H-7).
 */
export type MountError =
  | { readonly kind: 'slot_already_mounted'; readonly slot: string }
  | { readonly kind: 'unregistered_slot'; readonly slot: string }
  | { readonly kind: 'plugin_install_failed'; readonly reason: string }
  | { readonly kind: 'invalid_view_query'; readonly slot: string; readonly reason: string }
  | { readonly kind: 'invalid_changed_on'; readonly slot: string; readonly reason: string }
  | { readonly kind: 'invalid_parent'; readonly slot: string; readonly reason: string }
  | { readonly kind: 'invalid_panel'; readonly slot: string; readonly reason: string }

const mountedSlots = new WeakMap<World, Set<string>>()
// O-55 (D7): each mountDOM installs its own renderer plugin, so a world can
// take several mounts on distinct slots (SPEC §5.6).
const mountCount = new WeakMap<World, number>()

interface MountedRecord {
  el: HTMLElement
  view: EntityView
  /** Where `el` is attached: the slot or a parent's mount point; null while waiting for its parent (H-8). */
  container: HTMLElement | null
  /** The parent entity it is nested under (H-8); null in the slot. */
  parent: Entity | null
}

interface ViewState {
  world: World
  def: ViewDef
  slotEl: HTMLElement
  query: QueryResult
  /** The view's query as a node, for intersecting its redraw gate with it (H-10). */
  node: QueryNode
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
  /** H-8: the view this one nests in, resolved from `def.parent`. */
  parentState: ViewState | null
  /** H-8: the views nested in this one. */
  children: ViewState[]
  /** H-8: this view's mounted entities by the parent entity they are nested under. */
  byParent: Map<Entity, Set<Entity>>
  /** H-8: mounted entities waiting for their parent's element. */
  orphans: Set<Entity>
  /** H-10: a node was created, updated or attached this commit, so the order may have changed. */
  touched: boolean
  /** P-4: work counts and the last commit's duration. */
  readonly counts: { creates: number; updates: number; destroys: number; lastCommitMs: number }
  stamp: boolean
  unsubAdd: () => void
  unsubRemove: () => void
}

interface PanelState {
  def: PanelDef
  slotEl: HTMLElement
  /** OnAdded/OnChanged/OnRemoved of the listed types; null with no gate (every commit). */
  gate: QueryResult[] | null
  /** A listed resource changed, a restore happened, or nothing was painted yet. */
  dirty: boolean
  unsub: Array<() => void>
  /** P-4. */
  readonly counts: { renders: number; paints: number; lastCommitMs: number }
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
 * - `err({ kind: 'invalid_parent' | 'invalid_panel', … })` — see {@link MountError}.
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

  const stamp = opts.stamp !== false
  const states: ViewState[] = []
  const panels: PanelState[] = []
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
    for (const panel of panels) disposePanel(panel)
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
            ? 'changedOn { mode: "explicit" } needs at least one type or resource'
            : 'the view has update but its query has no Has/Where leaf to redraw on; pass changedOn explicitly, or { mode: "legacy" } to redraw every tick',
      })
    }
    const q = world.query(def.query)
    const resources = def.changedOn && def.changedOn.mode !== 'legacy' ? def.changedOn.resources ?? [] : []
    // H-10: the gate is the view's own query intersected with each trigger,
    // so a mark on an entity outside the view is never collected; H-7: a
    // resource trigger yields every member when the resource changed.
    const gate = [
      ...changedTypes.map((c) => world.query(And(node, OnChanged(c)))),
      ...resources.map((r) => world.query(And(node, OnChangedResource(r)))),
    ]
    const state: ViewState = {
      world,
      def,
      slotEl,
      query: q,
      node,
      changedQueries: gate.length > 0 ? gate : null,
      mounted: new Map(),
      pendingCreate: new Map(),
      pendingDestroy: new Map(),
      failed: new Set(),
      retryQueries: null,
      filtered: findKind(node, WHERE_KIND) !== null,
      parentState: null,
      children: [],
      byParent: new Map(),
      orphans: new Set(),
      touched: false,
      counts: { creates: 0, updates: 0, destroys: 0, lastCommitMs: 0 },
      stamp,
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

  // H-8: link each nested view to its parent's state; parents commit first.
  for (const state of states) {
    const link = state.def.parent
    if (link === undefined) continue
    const parent = states.find((s) => s.def === link.view)
    if (parent === undefined) {
      rollback()
      return err({ kind: 'invalid_parent', slot: state.def.slot, reason: 'parent.view is not one of the views given to this mountDOM' })
    }
    state.parentState = parent
    parent.children.push(state)
  }
  const ordered: ViewState[] = []
  const visiting = new Set<ViewState>()
  const visit = (s: ViewState): boolean => {
    if (ordered.includes(s)) return true
    if (visiting.has(s)) return false
    visiting.add(s)
    if (s.parentState !== null && !visit(s.parentState)) return false
    visiting.delete(s)
    ordered.push(s)
    return true
  }
  for (const s of states) {
    if (!visit(s)) {
      rollback()
      return err({ kind: 'invalid_parent', slot: s.def.slot, reason: 'view parents form a cycle' })
    }
  }

  // H-7: panels, each in a slot of its own.
  const viewSlots = new Set(states.map((s) => s.def.slot))
  for (const def of opts.panels ?? []) {
    const slotEl = opts.slots[def.slot]
    if (!slotEl) {
      rollback()
      return err({ kind: 'unregistered_slot', slot: def.slot })
    }
    if (viewSlots.has(def.slot) || panels.some((p) => p.def.slot === def.slot)) {
      rollback()
      return err({ kind: 'invalid_panel', slot: def.slot, reason: 'a panel needs a slot of its own: another view or panel uses it' })
    }
    const types = def.changedOn?.types ?? []
    const panel: PanelState = {
      def,
      slotEl,
      gate: def.changedOn === undefined ? null : types.map((t) => world.query(Or(OnAdded(t), OnChanged(t), OnRemoved(t)))),
      dirty: true,
      unsub: [],
      counts: { renders: 0, paints: 0, lastCommitMs: 0 },
    }
    const watched = new Set<ResourceType<any>>(def.changedOn?.resources ?? [])
    if (watched.size > 0) {
      panel.unsub.push(world.signals.resourceChanged.subscribe((type) => {
        if (watched.has(type)) panel.dirty = true
      }))
    }
    panel.unsub.push(world.signals.restored.subscribe(() => {
      panel.dirty = true
    }))
    panels.push(panel)
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
          for (const state of ordered) commit(state, errors)
          for (const panel of panels) commitPanel(world, panel, errors)
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
  const listeners = new Set<() => void>()

  return ok({
    teardown() {
      unuse()
      for (const off of [...listeners]) off()
      const errors: unknown[] = []
      // Children first: a parent's element would take theirs with it.
      for (const state of [...ordered].reverse()) {
        state.unsubAdd()
        state.unsubRemove()
        state.query.dispose()
        for (const q of state.changedQueries ?? []) q.dispose()
        if (state.retryQueries !== state.changedQueries) {
          for (const q of state.retryQueries ?? []) q.dispose()
        }
        for (const [id, rec] of state.mounted) unmount(state, id, rec, errors)
        state.mounted.clear()
        state.pendingCreate.clear()
        state.pendingDestroy.clear()
        state.failed.clear()
        state.orphans.clear()
        state.byParent.clear()
      }
      for (const panel of panels) {
        disposePanel(panel)
        // paint must not think the cleared slot still holds what it wrote (PR #30 review).
        forgetPaint(panel.slotEl)
        panel.slotEl.replaceChildren()
      }
      const set = mountedSlots.get(world)
      if (set) for (const k of Object.keys(opts.slots)) set.delete(k)
      if (errors.length > 0) throw errors[0]
    },

    stats() {
      return {
        views: states.map((s) => ({
          view: s.def,
          slot: s.def.slot,
          mounted: s.mounted.size,
          creates: s.counts.creates,
          updates: s.counts.updates,
          destroys: s.counts.destroys,
          lastCommitMs: s.counts.lastCommitMs,
        })),
        panels: panels.map((p) => ({
          slot: p.def.slot,
          renders: p.counts.renders,
          paints: p.counts.paints,
          lastCommitMs: p.counts.lastCommitMs,
        })),
      }
    },

    elementOf(view, entity) {
      return states.find((s) => s.def === view)?.mounted.get(entity)?.el
    },

    on(slot, type, fn) {
      const slotEl = opts.slots[slot]
      if (!slotEl) throw new Error(`@domecs/dom: on(): this mount has no slot "${slot}"`)
      const listener = (ev: Event): void => {
        const id = entityOf(ev.target)
        if (id === undefined) return
        const host = (ev.target as Node).nodeType === 1
          ? (ev.target as Element).closest(`[${ENTITY_ATTRIBUTE}]`)
          : (ev.target as Node).parentElement?.closest(`[${ENTITY_ATTRIBUTE}]`)
        if (!host || !slotEl.contains(host)) return
        // Only this mount's elements: not user content that happens to carry the attribute.
        if (!states.some((s) => s.mounted.get(id)?.el === host)) return
        fn(id, ev as HTMLElementEventMap[typeof type])
      }
      slotEl.addEventListener(type, listener)
      const off = (): void => {
        if (!listeners.delete(off)) return
        slotEl.removeEventListener(type, listener)
      }
      listeners.add(off)
      return off
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

function unmount(state: ViewState, id: Entity, rec: MountedRecord, errors: unknown[]): void {
  // H-8: the elements nested in this one would go with it: take them out
  // first, still mounted, to wait for a parent element.
  for (const child of state.children) {
    const kids = child.byParent.get(id)
    if (kids === undefined) continue
    for (const kid of kids) {
      const krec = child.mounted.get(kid)
      if (krec === undefined) continue
      krec.el.remove()
      krec.container = null
      child.orphans.add(kid)
    }
  }
  if (state.def.destroy) guard(errors, () => state.def.destroy!(rec.el, rec.view))
  rec.el.remove()
  state.counts.destroys++
  if (rec.parent !== null) state.byParent.get(rec.parent)?.delete(id)
  state.orphans.delete(id)
}

/** H-8: the container `view`'s element belongs in, and its parent entity; container null = wait. */
function resolveContainer(
  state: ViewState,
  view: EntityView,
  errors: unknown[],
): { container: HTMLElement | null; parent: Entity | null } {
  const link = state.def.parent
  if (link === undefined || state.parentState === null) return { container: state.slotEl, parent: null }
  let p: Entity | null | undefined
  if (!guard(errors, () => { p = link.of(view) })) return { container: null, parent: null }
  if (p === null || p === undefined) return { container: state.slotEl, parent: null }
  const prec = state.parentState.mounted.get(p)
  if (prec === undefined) return { container: null, parent: p }
  const at = link.at !== undefined ? prec.el.querySelector<HTMLElement>(link.at) : null
  return { container: at ?? prec.el, parent: p }
}

/** H-8: put `rec.el` where it belongs now; true when it moved into a container. */
function place(state: ViewState, id: Entity, rec: MountedRecord, view: EntityView, errors: unknown[]): boolean {
  const { container, parent } = resolveContainer(state, view, errors)
  if (parent !== rec.parent) {
    if (rec.parent !== null) state.byParent.get(rec.parent)?.delete(id)
    if (parent !== null) {
      let set = state.byParent.get(parent)
      if (set === undefined) state.byParent.set(parent, (set = new Set()))
      set.add(id)
    }
    rec.parent = parent
  }
  if (container === null) {
    if (rec.container !== null) rec.el.remove()
    rec.container = null
    state.orphans.add(id)
    return false
  }
  state.orphans.delete(id)
  if (rec.container === container && rec.el.parentNode === container) return false
  container.appendChild(rec.el)
  rec.container = container
  return true
}

function mount(state: ViewState, id: Entity, view: EntityView, errors: unknown[]): boolean {
  let el: HTMLElement | undefined
  if (!guard(errors, () => { el = state.def.create(view) })) {
    state.failed.add(id)
    ensureRetryQueries(state)
    return false
  }
  state.failed.delete(id)
  if (state.stamp) el!.setAttribute(ENTITY_ATTRIBUTE, String(id))
  const rec: MountedRecord = { el: el!, view, container: null, parent: null }
  state.mounted.set(id, rec)
  place(state, id, rec, view, errors)
  state.touched = true
  state.counts.creates++
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
  const t0 = clockNow()
  try {
    commitView(state, errors)
  } finally {
    state.counts.lastCommitMs = clockNow() - t0
  }
}

function commitView(state: ViewState, errors: unknown[]): void {
  if (state.filtered) reconcileFiltered(state)
  const pendingDestroy = state.pendingDestroy
  const pendingCreate = state.pendingCreate
  state.pendingDestroy = new Map()
  state.pendingCreate = new Map()
  for (const id of pendingDestroy.keys()) {
    const rec = state.mounted.get(id)
    if (rec) {
      state.mounted.delete(id)
      unmount(state, id, rec, errors)
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
        unmount(state, id, existing, errors)
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

  const repaint = (id: Entity, rec: MountedRecord, view: EntityView): void => {
    rec.view = view
    guard(errors, () => update!(rec.el, view))
    state.counts.updates++
    state.touched = true
    // H-8: the update may have moved it to another parent.
    if (state.parentState !== null) place(state, id, rec, view, errors)
  }
  if (update && state.mounted.size > 0) {
    if (!changed) {
      for (const view of state.query.entities) {
        const rec = state.mounted.get(view.id)
        if (!rec) continue
        repaint(view.id, rec, view)
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
        repaint(id, rec, view)
      }
    }
  }

  // H-8: elements waiting for a parent element, which may exist now.
  if (state.orphans.size > 0) {
    for (const id of Array.from(state.orphans).sort(ascending)) {
      const rec = state.mounted.get(id)
      const view = rec ? state.world.getView(id) : undefined
      if (!rec || !view) {
        state.orphans.delete(id)
        continue
      }
      if (place(state, id, rec, view, errors)) state.touched = true
    }
  }

  if (state.def.order !== undefined && state.touched) reorder(state, errors)
  state.touched = false
}

/**
 * H-10: put the view's nodes in `order(entity)` order (ties by id) within
 * each container, moving only the nodes that are out of place relative to
 * the one before them.
 */
function reorder(state: ViewState, errors: unknown[]): void {
  const order = state.def.order!
  const keyed: Array<{ id: Entity; rec: MountedRecord; key: number }> = []
  for (const [id, rec] of state.mounted) {
    if (rec.container === null) continue
    let key = Infinity
    const view = state.world.getView(id) ?? rec.view
    guard(errors, () => {
      const k = order(view)
      key = typeof k === 'number' && !Number.isNaN(k) ? k : Infinity
    })
    keyed.push({ id, rec, key })
  }
  keyed.sort((a, b) => (a.key === b.key ? a.id - b.id : a.key < b.key ? -1 : 1))
  const last = new Map<HTMLElement, HTMLElement>()
  for (const { rec } of keyed) {
    const container = rec.container!
    const prev = last.get(container)
    if (prev !== undefined && prev.nextSibling !== rec.el) prev.after(rec.el)
    last.set(container, rec.el)
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
    : Array.from(collectHasComponents(state.node).values())
  state.retryQueries = types.map((c) => state.world.query(And(state.node, OnChanged(c))))
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

/** H-7: render a panel when its gate says so, and patch its slot. */
function commitPanel(world: World, panel: PanelState, errors: unknown[]): void {
  let due = panel.dirty || panel.gate === null
  // Read every gate query, so each one's window moves on.
  for (const q of panel.gate ?? []) if (q.entities.length > 0) due = true
  if (!due) return
  panel.dirty = false
  const t0 = clockNow()
  guard(errors, () => {
    const html = panel.def.render(world)
    panel.counts.renders++
    if (paint(panel.slotEl, html)) panel.counts.paints++
  })
  panel.counts.lastCommitMs = clockNow() - t0
}

/** P-4: the host's clock, for commit durations (diagnostics only). */
const clockNow: () => number =
  typeof globalThis.performance?.now === 'function' ? () => globalThis.performance.now() : () => Date.now()

function disposePanel(panel: PanelState): void {
  for (const q of panel.gate ?? []) q.dispose()
  for (const off of panel.unsub) off()
  panel.unsub = []
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
 * an empty explicit list with no resources, or an auto query with no
 * positive leaf — either used to fall back to redrawing every tick without
 * saying so.
 */
function resolveChangedTypes(def: ViewDef): ReadonlyArray<ComponentType<unknown>> | null {
  if (def.changedOn?.mode === 'explicit') {
    const hasTrigger = def.changedOn.types.length > 0 || (def.changedOn.resources?.length ?? 0) > 0
    return hasTrigger || !def.update ? def.changedOn.types : null
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
