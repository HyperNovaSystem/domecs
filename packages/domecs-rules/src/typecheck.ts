import type { AstNode } from './ast.js'

/** What an expression is known to produce before it runs. */
export type StaticKind = 'number' | 'string' | 'boolean' | 'unknown'

/**
 * O-68 (R4): infer `node`'s result kind and report the type errors that are
 * certain before the rule runs — a string or boolean where arithmetic, a
 * comparison or a function needs a number. `fieldKind` gives a field's kind
 * from its component's defaults, or `'unknown'`; unknown never errors, so
 * this only rejects what would fail on every entity.
 */
export function inferKind(
  node: AstNode,
  fieldKind: (component: string, field: string) => StaticKind,
  report: (pos: number, message: string) => void,
): StaticKind {
  const numeric = (child: AstNode, context: string): void => {
    const kind = inferKind(child, fieldKind, report)
    if (kind !== 'number' && kind !== 'unknown') {
      report(child.pos, `Expected a number for ${context}, got ${kind}`)
    }
  }
  switch (node.kind) {
    case 'number':
    case 'string':
    case 'boolean':
      return node.kind
    case 'identifier':
      return 'number'
    case 'field':
      return fieldKind(node.component, node.field)
    case 'unary':
      if (node.op === '!') {
        inferKind(node.operand, fieldKind, report)
        return 'boolean'
      }
      numeric(node.operand, 'unary "-"')
      return 'number'
    case 'logical':
      inferKind(node.left, fieldKind, report)
      inferKind(node.right, fieldKind, report)
      return 'boolean'
    case 'ternary': {
      inferKind(node.cond, fieldKind, report)
      const a = inferKind(node.then, fieldKind, report)
      const b = inferKind(node.else, fieldKind, report)
      return a === b ? a : 'unknown'
    }
    case 'binary':
      if (node.op === '==' || node.op === '!=') {
        inferKind(node.left, fieldKind, report)
        inferKind(node.right, fieldKind, report)
        return 'boolean'
      }
      numeric(node.left, `"${node.op}"`)
      numeric(node.right, `"${node.op}"`)
      return node.op === '<' || node.op === '<=' || node.op === '>' || node.op === '>='
        ? 'boolean'
        : 'number'
    case 'call':
      for (const arg of node.args) numeric(arg, `${node.name}()`)
      return 'number'
  }
}
