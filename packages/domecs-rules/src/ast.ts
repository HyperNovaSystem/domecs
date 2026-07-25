/**
 * AST for the rules expression grammar (see doc comment on
 * {@link import('./parser.js').parseExpression} for the exact grammar).
 *
 * Every node carries `pos`: the character offset (0-based, into the source
 * string that was parsed) of the token the node starts at. Used to report
 * accurate positions for component-resolution errors raised later by
 * `compileRule` against a successfully-parsed AST (see rules.ts).
 */

export const FUNCTION_NAMES = [
  'min',
  'max',
  'clamp',
  'abs',
  'sin',
  'cos',
  'floor',
  'random',
] as const
export type FunctionName = (typeof FUNCTION_NAMES)[number]

/** Expected argument count for each whitelisted function. */
export const FUNCTION_ARITY: Readonly<Record<FunctionName, number>> = {
  min: 2,
  max: 2,
  clamp: 3,
  abs: 1,
  sin: 1,
  cos: 1,
  floor: 1,
  random: 0,
}

export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '<' | '<=' | '>' | '>=' | '==' | '!='
export type LogicalOp = '&&' | '||'
export type UnaryOp = '!' | '-'

export type AstNode =
  | { kind: 'number'; value: number; pos: number }
  | { kind: 'string'; value: string; pos: number }
  | { kind: 'boolean'; value: boolean; pos: number }
  /** Bare `dt` / `time` — NOT a component reference. */
  | { kind: 'identifier'; name: 'dt' | 'time'; pos: number }
  /** Dotted `Component.field` reference. */
  | { kind: 'field'; component: string; field: string; pos: number }
  | { kind: 'unary'; op: UnaryOp; operand: AstNode; pos: number }
  | { kind: 'binary'; op: BinaryOp; left: AstNode; right: AstNode; pos: number }
  | { kind: 'logical'; op: LogicalOp; left: AstNode; right: AstNode; pos: number }
  | { kind: 'ternary'; cond: AstNode; then: AstNode; else: AstNode; pos: number }
  | { kind: 'call'; name: FunctionName; args: AstNode[]; pos: number }

/**
 * Walk every `field` (Component.field) leaf reachable from `node`, in
 * left-to-right order. Used by `compileRule` (rules.ts) to resolve every
 * component name referenced inside a parsed expression.
 */
export function walkFieldRefs(
  node: AstNode,
  visit: (component: string, field: string, pos: number) => void,
): void {
  switch (node.kind) {
    case 'field':
      visit(node.component, node.field, node.pos)
      return
    case 'unary':
      walkFieldRefs(node.operand, visit)
      return
    case 'binary':
    case 'logical':
      walkFieldRefs(node.left, visit)
      walkFieldRefs(node.right, visit)
      return
    case 'ternary':
      walkFieldRefs(node.cond, visit)
      walkFieldRefs(node.then, visit)
      walkFieldRefs(node.else, visit)
      return
    case 'call':
      for (const arg of node.args) walkFieldRefs(arg, visit)
      return
    case 'number':
    case 'string':
    case 'boolean':
    case 'identifier':
      return
  }
}
