import type { Entity, EntityView, World } from 'domecs'
import { Changed } from 'domecs'
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
        `domecs-dom: slot "${slotName}" already mounted on this world (SPEC §5.6 — slot mounting is exclusive)`,
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
        `domecs-dom: view targets slot "${def.slot}" which was not registered in mountDOM({ slots })`,
      )
    }
    const q = world.query(def.query)
    const state: ViewState = {
      def,
      slotEl,
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
    name: '__domecs-dom-renderer',
    install() {
      return {
        onRender() {
          for (const state of states) commit(world, state)
        },
      }
    },
  }
  const unuse = world.use(rendererPlugin)

  return {
    teardown() {
      unuse()
      for (const state of states) {
        state.unsubAdd()
        state.unsubRemove()
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

function commit(world: World, state: ViewState): void {
  for (const [id, view] of state.pendingDestroy) {
    const rec = state.mounted.get(id)
    if (rec) {
      state.def.destroy?.(rec.el, view)
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
    const changed = collectChanged(world, state.def.changedOn)
    if (!changed) {
      const q = world.query(state.def.query)
      const byId = new Map<Entity, EntityView>()
      for (const v of q.entities) byId.set(v.id, v)
      for (const [id, rec] of state.mounted) {
        const view = byId.get(id) ?? rec.view
        rec.view = view
        state.def.update(rec.el, view)
      }
    } else if (changed.size > 0) {
      const q = world.query(state.def.query)
      const byId = new Map<Entity, EntityView>()
      for (const v of q.entities) byId.set(v.id, v)
      for (const id of changed) {
        const rec = state.mounted.get(id)
        if (!rec) continue
        const view = byId.get(id) ?? rec.view
        rec.view = view
        state.def.update(rec.el, view)
      }
    }
  }
}

function collectChanged(
  world: World,
  changedOn: ReadonlyArray<import('domecs').ComponentType<unknown>> | undefined,
): Set<Entity> | null {
  if (!changedOn || changedOn.length === 0) return null
  const out = new Set<Entity>()
  for (const c of changedOn) {
    for (const e of world.query(Changed(c)).entities) out.add(e.id)
  }
  return out
}
