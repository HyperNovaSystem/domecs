import type { AstNode } from './ast.js'

/** What an expression is known to produce before it runs. */
export type StaticKind = 'number' | 'string' | 'boolean' | 'unknown'

/**
 * O-68 (R4): infer `node`'s result kind from its literals and operators,
 * and report the type errors that are certain before the rule runs — a
 * string or boolean literal (or an operator producing one) where
 * arithmetic, a comparison or a function needs a number. Field values are
 * `'unknown'`: a component's defaults do not fix a field's kind. Errors in
 * code that may not run — the right side of `&&`/`||`, a ternary branch —
 * are not reported, so this only rejects what fails on every evaluation.
 */
export function inferKind(node: AstNode, report: (pos: number, message: string) => void): StaticKind {
  return infer(node, report, true)
}

function infer(
  node: AstNode,
  report: (pos: number, message: string) => void,
  certain: boolean,
): StaticKind {
  const numeric = (child: AstNode, context: string): void => {
    const kind = infer(child, report, certain)
    if (certain && kind !== 'number' && kind !== 'unknown') {
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
      return 'unknown'
    case 'unary':
      if (node.op === '!') {
        infer(node.operand, report, certain)
        return 'boolean'
      }
      numeric(node.operand, 'unary "-"')
      return 'number'
    case 'logical':
      infer(node.left, report, certain)
      infer(node.right, report, false)
      return 'boolean'
    case 'ternary': {
      infer(node.cond, report, certain)
      const a = infer(node.then, report, false)
      const b = infer(node.else, report, false)
      return a === b ? a : 'unknown'
    }
    case 'binary':
      if (node.op === '==' || node.op === '!=') {
        infer(node.left, report, certain)
        infer(node.right, report, certain)
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
    default:
      return 'unknown'
  }
}
