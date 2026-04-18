import type { ComponentType, Entity } from './types.js'

export type QueryNode =
  | { kind: 'has'; type: ComponentType<unknown> }
  | { kind: 'not'; type: ComponentType<unknown> }
  | { kind: 'or'; children: QueryNode[] }
  | { kind: 'and'; children: QueryNode[] }
  | { kind: 'changed'; type: ComponentType<unknown> }
  | { kind: 'added'; type: ComponentType<unknown> }
  | { kind: 'removed'; type: ComponentType<unknown> }
  | {
      kind: 'where'
      type: ComponentType<unknown>
      predicate: (value: unknown) => boolean
    }

export type QueryShorthand = ReadonlyArray<ComponentType<unknown>> | QueryNode
export type QueryDef = QueryShorthand

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

export function Has<T>(type: ComponentType<T>): QueryNode {
  return { kind: 'has', type: type as ComponentType<unknown> }
}
export function Not<T>(type: ComponentType<T>): QueryNode {
  return { kind: 'not', type: type as ComponentType<unknown> }
}
export function Or(...children: QueryNode[]): QueryNode {
  return { kind: 'or', children }
}
export function And(...children: QueryNode[]): QueryNode {
  return { kind: 'and', children }
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
  return out
}
