import {
  And,
  Has,
  Or,
  createSpatialGrid,
  defineEvent,
  definePlugin,
  defineResource,
  type ComponentType,
  type Entity,
  type EventType,
  type Plugin,
  type ResourceType,
} from '@domecs/core'

/** The phase of a {@link Contact}: it started, continues, or stopped this run. */
export type ContactPhase = 'begin' | 'stay' | 'end'

/** Payload of a {@link Contact} event. */
export interface ContactPayload {
  /** The entity carrying the pair's first tag (the lower id for a same-tag pair). */
  readonly a: Entity
  /** The entity carrying the pair's second tag. */
  readonly b: Entity
  readonly phase: ContactPhase
}

/**
 * Emitted by {@link installContacts} when two colliders start (`'begin'`),
 * keep (`'stay'`, opt-in) or stop (`'end'`) overlapping. Declares a schema,
 * so rules can read `event.a`, `event.b` and `event.phase`; `installContacts`
 * registers it, so `on: 'Contact'` resolves through `world.lookupEvent`.
 * Delivered the tick after the contacts system ran (bus semantics).
 */
export const Contact: EventType<ContactPayload> = defineEvent<ContactPayload>('Contact', {
  schema: {
    fields: {
      a: { kind: 'number', description: "Entity id carrying the pair's first tag" },
      b: { kind: 'number', description: "Entity id carrying the pair's second tag" },
      phase: { kind: 'enum', options: ['begin', 'stay', 'end'], description: 'begin, stay (opt-in) or end' },
    },
  },
  description:
    'Two colliders from installContacts started (begin), keep (stay) or stopped (end) overlapping; a carries the first tag of the pair',
})

/** Value of {@link ContactState}. */
export interface ContactStateValue {
  /** The overlapping pairs as of the last run, sorted by (a, b), without duplicates. */
  pairs: Array<[Entity, Entity]>
}

/**
 * The overlapping pairs the contacts system saw on its last run, sorted by
 * (a, b). An ordinary (snapshotted) resource, so a restored world continues
 * `begin`/`end` exactly where the source left off. Written by the contacts
 * system only; treat it as read-only.
 */
export const ContactState: ResourceType<ContactStateValue, 'ContactState'> = defineResource<
  ContactStateValue,
  'ContactState'
>('ContactState', { default: () => ({ pairs: [] }) })

/** Options for {@link installContacts}. */
export interface ContactsOptions {
  /** The position component and its coordinate fields (default `'x'` / `'y'`). */
  readonly position: { readonly component: ComponentType<any>; readonly x?: string; readonly y?: string }
  /**
   * Radius per entity: a fixed number (finite, ≥ 0) or a component field,
   * read live each run. With a field, an entity lacking the component, or
   * whose value is not a finite number ≥ 0, is not a collider.
   */
  readonly radius: number | { readonly component: ComponentType<any>; readonly field: string }
  /** Tag pairs to test (at least one), e.g. `[[Player, Enemy], [Player, Pickup]]`. */
  readonly pairs: ReadonlyArray<readonly [ComponentType<any>, ComponentType<any>]>
  /** Emit `'stay'` each run while a pair overlaps (default false). */
  readonly stay?: boolean
  /** Default `'fixed'` (runs per fixed step; `stepOnce` never runs it). */
  readonly schedule?: 'fixed' | 'tick'
  /** Default 150: the contacts band (SPEC §3), after transform composition at 100. */
  readonly priority?: number
  /** Grid cell size, a performance setting only. Default 2 × a fixed radius (> 0), else 64. */
  readonly cellSize?: number
  /** Plugin and system name. Default `'domecs-scene:contacts'`. */
  readonly name?: string
}

const DEFAULT_NAME = 'domecs-scene:contacts'
const DEFAULT_PRIORITY = 150
const DEFAULT_CELL_SIZE = 64
/** One contacts plugin per world: both share {@link ContactState}. */
const CAPABILITY = 'domecs-scene:contacts'

interface Collider {
  readonly id: Entity
  x: number
  y: number
  r: number
  seen: number
  /** The view `held` was read from. */
  view: object | undefined
  /** held[t]: whether the entity holds tag t. */
  readonly held: Uint8Array
}

/**
 * Whether `value` looks like a `defineComponent` type. Core's own guard is
 * internal; a component type is an object with a string `name` and a
 * `create` function. Catches the likely mistake of passing a component's
 * name (rules name components by string), which would otherwise install a
 * plugin that never detects anything.
 */
const isComponentLike = (value: unknown): value is ComponentType<any> =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as { name?: unknown }).name === 'string' &&
  typeof (value as { create?: unknown }).create === 'function'

const isFieldName = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const byPair = (s: readonly [Entity, Entity], t: readonly [Entity, Entity]): number => s[0] - t[0] || s[1] - t[1]

const isPair = (p: unknown): p is readonly [Entity, Entity] =>
  Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number'

/**
 * The last run's pairs from {@link ContactState}, as a sorted set the diff
 * can merge against. The plugin always writes it canonical (sorted by
 * (a, b), no duplicates), which is checked in O(n) and used as is. A value
 * from elsewhere (a hand-edited save, an agent's `setResource`) is read as a
 * set: entries that are not two numbers are dropped, the rest sorted and
 * de-duplicated into a copy, and `canonical` is false so the run writes the
 * state back. A `pairs` that is not an array reads as empty.
 */
function readPairs(state: ContactStateValue | undefined): {
  readonly pairs: ReadonlyArray<readonly [Entity, Entity]>
  readonly canonical: boolean
} {
  const raw: unknown = state?.pairs
  if (!Array.isArray(raw)) return { pairs: [], canonical: true }
  let canonical = true
  for (let i = 0; i < raw.length; i++) {
    const p: unknown = raw[i]
    if (!isPair(p) || (i > 0 && byPair(raw[i - 1] as readonly [Entity, Entity], p) >= 0)) {
      canonical = false
      break
    }
  }
  if (canonical) return { pairs: raw as Array<readonly [Entity, Entity]>, canonical }
  const out = raw.filter(isPair).sort(byPair)
  let w = 0
  for (let i = 0; i < out.length; i++) {
    if (w > 0 && byPair(out[w - 1]!, out[i]!) === 0) continue
    out[w++] = out[i]!
  }
  out.length = w
  return { pairs: out, canonical }
}

/**
 * Plugin factory: overlap events for rules (spec §6.2). Each run of its
 * system (`schedule`, default `'fixed'`, at `priority` 150) indexes every
 * entity that holds the position component, at least one tag of `pairs` and
 * a valid radius in a spatial grid, finds the pairs with
 * `dx * dx + dy * dy <= (ra + rb) * (ra + rb)`, and diffs them against
 * {@link ContactState}.
 *
 * A pair `[a, b]` means `a` holds the pair's first tag and `b` its second;
 * for a same-tag pair `a < b`. An entity holding both tags of a pair can
 * appear on either side (both directions are pairs); a pair found through
 * two tag pairs counts once. Events are emitted as `end`, then `begin`, then
 * (with `stay`) `stay`, each sorted by (a, b), and rules see them the next
 * tick (`on: 'Contact', self: 'event.a', other: 'event.b'`). A despawned
 * entity, or one that lost its tag, radius or a finite position, ends its
 * pairs once on the next run. Results never depend on `cellSize`.
 *
 * Installs {@link Contact} and {@link ContactState} with `world.register`
 * (install fails when another type holds either name). One contacts plugin
 * per world: a second `use` throws (capability `domecs-scene:contacts`).
 * Throws `RangeError`/`TypeError` here for invalid options. Disposing removes
 * the system; `ContactState` keeps its last value.
 */
export function installContacts(options: ContactsOptions): Plugin {
  const name = options.name ?? DEFAULT_NAME
  if (!isFieldName(name)) {
    throw new TypeError(`installContacts: name must be a non-empty string (got ${JSON.stringify(name)})`)
  }
  const position = options.position
  if (!position || typeof position !== 'object' || !isComponentLike(position.component)) {
    throw new TypeError('installContacts: position.component must be a component type (from defineComponent), not a name')
  }
  const fx = position.x ?? 'x'
  const fy = position.y ?? 'y'
  if (!isFieldName(fx) || !isFieldName(fy)) {
    throw new TypeError('installContacts: position.x and position.y must be non-empty field names')
  }
  const radius = options.radius
  let fixedRadius: number | undefined
  let radiusComponent: ComponentType<any> | undefined
  let radiusField = ''
  if (typeof radius === 'number') {
    if (!(Number.isFinite(radius) && radius >= 0)) {
      throw new RangeError(`installContacts: radius must be a finite number >= 0 (got ${String(radius)})`)
    }
    fixedRadius = radius
  } else if (radius && typeof radius === 'object' && isComponentLike(radius.component) && isFieldName(radius.field)) {
    radiusComponent = radius.component
    radiusField = radius.field
  } else {
    throw new TypeError('installContacts: radius must be a number or { component, field } (a component type and a non-empty field name)')
  }
  const pairs = options.pairs
  if (
    !Array.isArray(pairs) ||
    pairs.length === 0 ||
    pairs.some((p) => !Array.isArray(p) || p.length !== 2 || !isComponentLike(p[0]) || !isComponentLike(p[1]))
  ) {
    throw new TypeError(
      'installContacts: pairs must be a non-empty array of [TagA, TagB] component-type pairs (from defineComponent), not names',
    )
  }
  const schedule = options.schedule ?? 'fixed'
  if (schedule !== 'fixed' && schedule !== 'tick') {
    throw new TypeError(`installContacts: schedule must be 'fixed' or 'tick' (got ${JSON.stringify(schedule)})`)
  }
  const priority = options.priority ?? DEFAULT_PRIORITY
  if (typeof priority !== 'number' || !Number.isFinite(priority)) {
    throw new RangeError(`installContacts: priority must be a finite number (got ${String(priority)})`)
  }
  const cellSize =
    options.cellSize ?? (fixedRadius !== undefined && fixedRadius > 0 ? 2 * fixedRadius : DEFAULT_CELL_SIZE)
  if (typeof cellSize !== 'number' || !(Number.isFinite(cellSize) && cellSize > 0)) {
    throw new RangeError(`installContacts: cellSize must be a finite number > 0 (got ${String(cellSize)})`)
  }
  if (options.stay !== undefined && typeof options.stay !== 'boolean') {
    throw new TypeError(`installContacts: stay must be a boolean (got ${JSON.stringify(options.stay)})`)
  }
  const stay = options.stay === true

  // Distinct tags, and each pair as indices into them.
  const tags: ComponentType<any>[] = []
  const tagIndex = (t: ComponentType<any>): number => {
    let i = tags.indexOf(t)
    if (i < 0) i = tags.push(t) - 1
    return i
  }
  const tagPairs = pairs.map(([A, B]) => [tagIndex(A), tagIndex(B)] as const)
  const T = tags.length

  return definePlugin({
    name,
    provides: [CAPABILITY],
    install(world) {
      const registered = world.register(Contact, ContactState)
      if (!registered.ok) {
        throw new Error(
          `installContacts: the ${registered.error.registry} name "${registered.error.name}" is held by another type`,
        )
      }
      const grid = createSpatialGrid(cellSize)
      const positionName = position.component.name
      const radiusName = radiusComponent?.name
      const tagNames = tags.map((t) => t.name)
      // The system's query visits exactly the candidates: position (and the
      // radius component) plus any tag. A view carries every component the
      // entity holds, so tag membership is read from it.
      const anyTag = T === 1 ? Has(tags[0]!) : Or(...tags.map((t) => Has(t)))
      const query =
        radiusComponent && radiusComponent !== position.component
          ? And(Has(position.component), Has(radiusComponent), anyTag)
          : And(Has(position.component), anyTag)
      /** Colliders by id, kept across runs; `seen` is the last run that saw it. */
      const colliders = new Map<Entity, Collider>()
      let run = 0
      const members: Collider[][] = tags.map(() => [])
      const maxRadius: number[] = tags.map(() => 0)
      /** Per anchor tag, this run's checks as flat triples (other tag, anchor is first, same tag). */
      const groups: number[][] = tags.map(() => [])

      const handle = world.system(name, { schedule, priority, query }, (ctx) => {
        // 1. Colliders. Insertion order never changes grid results (§2.12),
        // so the query's order does not matter here.
        run++
        let seen = 0
        for (let t = 0; t < T; t++) {
          members[t]!.length = 0
          maxRadius[t] = 0
        }
        for (const view of ctx.entities) {
          const v = view as Record<string, unknown>
          const pos = v[positionName] as Record<string, unknown> | undefined
          const x = pos?.[fx]
          const y = pos?.[fy]
          const r = radiusName === undefined ? fixedRadius : (v[radiusName] as Record<string, unknown> | undefined)?.[radiusField]
          if (
            typeof x !== 'number' || typeof y !== 'number' || typeof r !== 'number' ||
            !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r) || r < 0
          ) {
            continue // not a collider; dropped below if it was one
          }
          const id = view.id
          let c = colliders.get(id)
          if (c === undefined) {
            c = { id, x, y, r, seen: run, view: undefined, held: new Uint8Array(T) }
            colliders.set(id, c)
          } else {
            c.x = x
            c.y = y
            c.r = r
            c.seen = run
          }
          // Core hands out one view object per entity until its archetype
          // changes, so the same view means the same tags.
          if (c.view !== view) {
            c.view = view
            for (let t = 0; t < T; t++) c.held[t] = v[tagNames[t]!] !== undefined ? 1 : 0
          }
          for (let t = 0; t < T; t++) {
            if (c.held[t] === 0) continue
            members[t]!.push(c)
            if (r > maxRadius[t]!) maxRadius[t] = r
          }
          grid.set(id, x, y)
          seen++
        }
        if (colliders.size > seen) {
          for (const [id, c] of colliders) {
            if (c.seen === run) continue
            colliders.delete(id)
            grid.delete(id)
          }
        }

        // 2. Overlapping pairs. Each tag pair is searched from its smaller
        // side (the anchors); pairs sharing an anchor tag share one
        // `within(anchor, r + the largest radius among the other tags)`
        // query. That is a superset (rounding is monotonic) computing dx, dy
        // as the exact check below does, and which side anchors never
        // changes the result: the check is symmetric.
        const current: Array<[Entity, Entity]> = []
        for (const group of groups) group.length = 0
        for (const [ta, tb] of tagPairs) {
          const fromA = members[ta]!.length <= members[tb]!.length
          groups[fromA ? ta : tb]!.push(fromA ? tb : ta, fromA ? 1 : 0, ta === tb ? 1 : 0)
        }
        for (let anchorTag = 0; anchorTag < T; anchorTag++) {
          const group = groups[anchorTag]!
          if (group.length === 0) continue
          let reachOther = 0
          for (let g = 0; g < group.length; g += 3) reachOther = Math.max(reachOther, maxRadius[group[g]!]!)
          for (const a of members[anchorTag]!) {
            const anchor = a.id
            for (const id of grid.within(a.x, a.y, a.r + reachOther)) {
              if (id === anchor) continue
              const o = colliders.get(id)!
              const dx = o.x - a.x
              const dy = o.y - a.y
              const reach = a.r + o.r
              if (!(dx * dx + dy * dy <= reach * reach)) continue
              for (let g = 0; g < group.length; g += 3) {
                if (!o.held[group[g]!]) continue
                if (group[g + 2] === 1 && !(anchor < id)) continue
                current.push(group[g + 1] === 1 ? [anchor, id] : [id, anchor])
              }
            }
          }
        }
        current.sort(byPair)
        // A pair found through two tag pairs counts once.
        let w = 0
        for (let i = 0; i < current.length; i++) {
          if (w > 0 && byPair(current[w - 1]!, current[i]!) === 0) continue
          current[w++] = current[i]!
        }
        current.length = w

        // 3. Diff against the last run's pairs (sorted by the same order).
        const { pairs: prev, canonical } = readPairs(world.getResource(ContactState))
        const ends: Array<readonly [Entity, Entity]> = []
        const begins: Array<[Entity, Entity]> = []
        const stays: Array<[Entity, Entity]> = []
        let i = 0
        let k = 0
        while (i < prev.length || k < current.length) {
          const c = i < prev.length && k < current.length ? byPair(prev[i]!, current[k]!) : i < prev.length ? -1 : 1
          if (c < 0) ends.push(prev[i++]!)
          else if (c > 0) begins.push(current[k++]!)
          else {
            stays.push(current[k++]!)
            i++
          }
        }
        for (const [a, b] of ends) ctx.events.emit(Contact, { a, b, phase: 'end' })
        for (const [a, b] of begins) ctx.events.emit(Contact, { a, b, phase: 'begin' })
        if (stay) for (const [a, b] of stays) ctx.events.emit(Contact, { a, b, phase: 'stay' })
        if (ends.length > 0 || begins.length > 0 || !canonical) world.setResource(ContactState, { pairs: current })
      })

      return {
        teardown() {
          handle.remove()
          grid.clear()
          colliders.clear()
        },
      }
    },
  })
}
