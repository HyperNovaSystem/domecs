import type { ComponentType, Entity } from './types.js'

export type QueryNode =
  | { kind: 'has'; type: ComponentType<unknown> }
  | { kind: 'changed'; type: ComponentType<unknown> }
  | { kind: 'added'; type: ComponentType<unknown> }
  | { kind: 'removed'; type: ComponentType<unknown> }
  | {
      kind: 'where'
      type: ComponentType<unknown>
      predicate: (value: unknown) => boolean
    }
  | { kind: 'not'; child: QueryNode }
  | { kind: 'and'; children: QueryNode[] }
  | { kind: 'or'; children: QueryNode[] }

export type QueryShorthand = ReadonlyArray<ComponentType<unknown>> | QueryNode
export type QueryDef = QueryShorthand

/**
 * Argument accepted by predicate combinators (`Not` / `And` / `Or`):
 * either a `QueryNode` or a bare `ComponentType` (auto-wrapped as `Has(T)`).
 * SPEC §2.4.
 */
export type NodeOrComponent = QueryNode | ComponentType<unknown>

/**
 * Maps a `ComponentType<T, Name>` to the field `{ [Name]: T }`. Used to project
 * a tuple of component types into the typed body of an `EntityView` (D-2).
 *
 * Implementation note: we distribute over `T[number]` to build a union of
 * single-field records, then collapse that union into one record via
 * `UnionToIntersection`. A direct mapped type (`[K in T[number] as …]`) drops
 * the per-element link between `Name` and `Value` because TypeScript infers
 * the value position against the union as a whole — the resulting record's
 * fields all end up typed as the union of every value type.
 */
type UnionToIntersection<U> = (
  U extends unknown ? (x: U) => void : never
) extends (x: infer I) => void
  ? I
  : never

type ComponentTypeToField<C> = C extends ComponentType<infer V, infer N>
  ? Readonly<{ [P in N]: V }>
  : never

export type FieldsFromComponents<
  T extends ReadonlyArray<ComponentType<unknown, string>>,
> = UnionToIntersection<ComponentTypeToField<T[number]>>

/**
 * Live read-only entity view returned by queries and renderer hooks.
 *
 * When a query is built from the array shorthand
 * (`world.query([Position, Velocity])`), `Fields` is inferred so that
 * `view.Position` and `view.Velocity` are typed. For combinator forms
 * (`Has`/`And`/`Or`/…) where field inference is not currently wired up,
 * `Fields` defaults to `Record<string, unknown>` and callers can fall back
 * to `world.getComponent(view.id, T)` for typed access.
 */
export type EntityView<Fields = Record<string, unknown>> = Readonly<Fields> & {
  readonly id: Entity
}

export interface QueryResult<Fields = Record<string, unknown>> {
  readonly entities: ReadonlyArray<EntityView<Fields>>
  readonly size: number
  onAdd(fn: (e: EntityView<Fields>) => void): () => void
  onRemove(fn: (e: EntityView<Fields>) => void): () => void
  /**
   * Release this live query from the world's archetype indexes. After disposal,
   * `entities` is empty, `size` is 0, and add/remove subscriptions are cleared.
   */
  dispose(): void
}

export interface QueryHooks<Fields = Record<string, unknown>> {
  onAdd?: (e: EntityView<Fields>) => void
  onRemove?: (e: EntityView<Fields>) => void
  onChange?: (e: EntityView<Fields>) => void
}

function isQueryNode(arg: NodeOrComponent): arg is QueryNode {
  return typeof arg === 'object' && arg !== null && 'kind' in arg
}

function asNode(arg: NodeOrComponent): QueryNode {
  return isQueryNode(arg) ? arg : Has(arg)
}

export function Has<T>(type: ComponentType<T>): QueryNode {
  return { kind: 'has', type: type as ComponentType<unknown> }
}
export function Not(arg: NodeOrComponent): QueryNode {
  return { kind: 'not', child: asNode(arg) }
}
export function Or(...args: NodeOrComponent[]): QueryNode {
  return { kind: 'or', children: args.map(asNode) }
}
export function And(...args: NodeOrComponent[]): QueryNode {
  return { kind: 'and', children: args.map(asNode) }
}
export function Changed<T>(type: ComponentType<T>): QueryNode {
  return { kind: 'changed', type: type as ComponentType<unknown> }
}
export function Added<T>(type: ComponentType<T>): QueryNode {
  return { kind: 'added', type: type as ComponentType<unknown> }
}
export function Removed<T>(type: ComponentType<T>): QueryNode {
  return { kind: 'removed', type: type as ComponentType<unknown> }
}
export function Where<T>(
  type: ComponentType<T>,
  predicate: (value: T) => boolean,
): QueryNode {
  return {
    kind: 'where',
    type: type as ComponentType<unknown>,
    predicate: predicate as (value: unknown) => boolean,
  }
}

export function normalize(def: QueryDef): QueryNode {
  if (Array.isArray(def)) {
    const nodes = def.map((t) => Has(t as ComponentType<unknown>))
    return nodes.length === 1 ? nodes[0]! : And(...nodes)
  }
  return def as QueryNode
}

export function treeHas(
  node: QueryNode,
  kinds: ReadonlySet<QueryNode['kind']>,
): boolean {
  if (kinds.has(node.kind)) return true
  if (node.kind === 'or' || node.kind === 'and') {
    return node.children.some((c) => treeHas(c, kinds))
  }
  if (node.kind === 'not') return treeHas(node.child, kinds)
  return false
}

export function collectTypesByKind(
  node: QueryNode,
  kind: QueryNode['kind'],
  out: Set<string> = new Set(),
): Set<string> {
  if (node.kind === kind && 'type' in node) {
    out.add((node as Extract<QueryNode, { type: ComponentType<unknown> }>).type.name)
  }
  if (node.kind === 'or' || node.kind === 'and') {
    for (const c of node.children) collectTypesByKind(c, kind, out)
  }
  if (node.kind === 'not') collectTypesByKind(node.child, kind, out)
  return out
}

/**
 * Collect every `ComponentType` referenced by a `Has(T)` leaf anywhere in
 * the tree, returning the actual type objects (not just their names).
 *
 * Used by the DOM renderer to auto-derive `changedOn` from a view's query
 * when the caller omits it (P-3): "redraw when any component this view
 * structurally depends on changes." Negative branches (`Not(...)`) are
 * skipped — a `Not(Dead)` view doesn't want to redraw every time a `Dead`
 * tag flips elsewhere.
 */
export function collectHasComponents(
  node: QueryNode,
  out: Map<string, ComponentType<unknown>> = new Map(),
  inNot = false,
): Map<string, ComponentType<unknown>> {
  if (node.kind === 'has' && !inNot) {
    out.set(node.type.name, node.type)
  }
  if (node.kind === 'or' || node.kind === 'and') {
    for (const c of node.children) collectHasComponents(c, out, inNot)
  }
  if (node.kind === 'not') collectHasComponents(node.child, out, !inNot)
  return out
}
