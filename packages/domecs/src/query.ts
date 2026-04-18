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

export interface EntityView {
  readonly id: Entity
  readonly [componentName: string]: unknown
}

export interface QueryResult {
  readonly entities: EntityView[]
  readonly size: number
  onAdd(fn: (e: EntityView) => void): () => void
  onRemove(fn: (e: EntityView) => void): () => void
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
