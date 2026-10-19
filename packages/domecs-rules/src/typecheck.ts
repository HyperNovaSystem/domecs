import { MODIFIER_NAMES, type AstNode, type EntityNode } from './ast.js'

/** What an expression is known to produce before it runs. */
export type StaticKind = 'number' | 'string' | 'boolean' | 'unknown'

/**
 * O-68 (R4): infer `node`'s result kind from its literals and operators,
 * and report the type errors that are certain before the rule runs — a
 * string or boolean literal (or an operator producing one) where
 * arithmetic, a comparison or a function needs a number. Field values are
 * `'unknown'`: a component's defaults do not fix a field's kind. Errors in
 * code that may not run — the right side of `&&`/`||`/`??`, a ternary
 * branch — are not reported, so this only rejects what fails on every
 * evaluation.
 *
 * 2.2 (§5.2): `has` and `exists` are boolean; `count`, `countWithin`,
 * `distanceTo`, `e.id`, `tick` and the aggregates are numbers; member reads
 * are `'unknown'`. An entity is never a value: the parser already rejects
 * one outside a member base, selector argument or `has` target ("use .id").
 * Input reads (§5.4) are boolean (`key`, `pressed`, `released`, `mod`) or
 * number (`pointer.*`); their argument must be a string, and a literal
 * `mod` name must be one of ctrl, alt, shift, meta.
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
    case 'identifier': // dt, time, tick
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
    case 'nullish': {
      const a = infer(node.left, report, certain)
      const b = infer(node.right, report, false)
      return a === b ? a : 'unknown'
    }
    case 'member':
      entity(node.target)
      return 'unknown'
    case 'entityId':
    case 'distanceTo':
      entity(node.target)
      return 'number'
    case 'has':
      entity(node.target)
      return 'boolean'
    case 'aggregate':
      return node.op === 'exists' ? 'boolean' : 'number'
    case 'countWithin':
      numeric(node.radius, 'countWithin()')
      if (node.centre) entity(node.centre)
      return 'number'
    case 'input': {
      const kind = infer(node.arg, report, certain)
      if (certain && kind !== 'string' && kind !== 'unknown') {
        report(node.arg.pos, `Expected a string for ${node.op}(), got ${kind}`)
      } else if (certain && node.op === 'mod' && node.arg.kind === 'string' && !MODIFIER_NAMES.has(node.arg.value)) {
        report(node.arg.pos, `mod() takes "ctrl", "alt", "shift" or "meta", got ${JSON.stringify(node.arg.value)}`)
      }
      return 'boolean'
    }
    case 'pointer':
      return 'number'
  }

  function entity(target: EntityNode): void {
    if (target.kind === 'select' && target.maxDistance) numeric(target.maxDistance, 'nearest()')
    if (target.kind === 'entityById') numeric(target.id, 'entity()')
  }
}
