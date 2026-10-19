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
  // 2.2 (§5.2). Adding names widens FunctionName: keep a default branch
  // when switching on it.
  'sqrt',
  'pow',
  'atan2',
  'hypot',
  'sign',
  'round',
  'ceil',
  'lerp',
  'distance',
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
  sqrt: 1,
  pow: 2,
  atan2: 2,
  hypot: 2,
  sign: 1,
  round: 1,
  ceil: 1,
  lerp: 3,
  distance: 4,
}

/**
 * The special forms (2.2, §5.2, §5.4): calls that are not plain numeric
 * functions, because their arguments are not all number expressions.
 * `args` lists each argument's role — `'set'` (a component
 * name: the entities holding it), `'entity'` (`self`, `first(S)`,
 * `nearest(S[, d])` or `entity(n)`), `'expr'`, or `'memberField'` (a
 * `Component.field` read on each member). `optional` counts the arguments
 * that may be left out: trailing ones, except `has`, whose optional
 * argument is the leading entity (`has(C)` is `has(self, C)`).
 * `first`, `nearest` and `entity` are selectors: they produce an entity,
 * which is only usable as `.Component.field`, `.id`, or an entity argument.
 * `key`, `pressed`, `released` and `mod` read the world's input (§5.4).
 */
export const SPECIAL_FORMS: Readonly<
  Record<string, { readonly args: ReadonlyArray<'set' | 'entity' | 'expr' | 'memberField'>; readonly optional: number }>
> = Object.freeze({
  first: Object.freeze({ args: Object.freeze(['set'] as const), optional: 0 }),
  nearest: Object.freeze({ args: Object.freeze(['set', 'expr'] as const), optional: 1 }),
  entity: Object.freeze({ args: Object.freeze(['expr'] as const), optional: 0 }),
  has: Object.freeze({ args: Object.freeze(['entity', 'set'] as const), optional: 1 }),
  count: Object.freeze({ args: Object.freeze(['set'] as const), optional: 0 }),
  exists: Object.freeze({ args: Object.freeze(['set'] as const), optional: 0 }),
  countWithin: Object.freeze({ args: Object.freeze(['set', 'expr', 'entity'] as const), optional: 1 }),
  sum: Object.freeze({ args: Object.freeze(['set', 'memberField'] as const), optional: 0 }),
  avg: Object.freeze({ args: Object.freeze(['set', 'memberField'] as const), optional: 0 }),
  minOf: Object.freeze({ args: Object.freeze(['set', 'memberField'] as const), optional: 0 }),
  maxOf: Object.freeze({ args: Object.freeze(['set', 'memberField'] as const), optional: 0 }),
  distanceTo: Object.freeze({ args: Object.freeze(['entity'] as const), optional: 0 }),
  // 2.2 (§5.4): input reads. The argument is an expression producing a
  // string (a key name, or 'ctrl' | 'alt' | 'shift' | 'meta' for `mod`).
  key: Object.freeze({ args: Object.freeze(['expr'] as const), optional: 0 }),
  pressed: Object.freeze({ args: Object.freeze(['expr'] as const), optional: 0 }),
  released: Object.freeze({ args: Object.freeze(['expr'] as const), optional: 0 }),
  mod: Object.freeze({ args: Object.freeze(['expr'] as const), optional: 0 }),
})

/**
 * Names the parser reserves (2.2, §5.2, ED-9): `self`, `tick` and (§5.4)
 * `pointer` (`pointer.x`), plus `other` and `event` for later minors. A
 * component with one of these names cannot be referenced in an expression.
 * After an entity, `id` is reserved too (`e.id` is the entity id).
 */
export const RESERVED_WORDS: ReadonlySet<string> = new Set(['self', 'tick', 'other', 'event', 'pointer'])

/** What a selector or `self` refers to (2.2). */
export type EntityNode =
  | { kind: 'self'; pos: number }
  | { kind: 'select'; op: 'first' | 'nearest'; set: string; maxDistance?: AstNode; pos: number }
  | { kind: 'entityById'; id: AstNode; pos: number }

export type AggregateOp = 'count' | 'exists' | 'sum' | 'avg' | 'minOf' | 'maxOf'

/** An input read (2.2, §5.4): held key, key edge, or modifier. */
export type InputOp = 'key' | 'pressed' | 'released' | 'mod'

/** The modifier names `mod(n)` accepts (2.2, §5.4). */
export type ModifierName = 'ctrl' | 'alt' | 'shift' | 'meta'
export const MODIFIER_NAMES: ReadonlySet<string> = new Set<ModifierName>(['ctrl', 'alt', 'shift', 'meta'])

/** The pointer fields a rule can read (2.2, §5.4). */
export type PointerField = 'x' | 'y' | 'buttons' | 'wheel'

export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '<' | '<=' | '>' | '>=' | '==' | '!='
export type LogicalOp = '&&' | '||'
export type UnaryOp = '!' | '-'

export type AstNode =
  | { kind: 'number'; value: number; pos: number }
  | { kind: 'string'; value: string; pos: number }
  | { kind: 'boolean'; value: boolean; pos: number }
  /** Bare `dt` / `time` / `tick` (2.2) — NOT a component reference. */
  | { kind: 'identifier'; name: 'dt' | 'time' | 'tick'; pos: number }
  /** Dotted `Component.field` reference. */
  | { kind: 'field'; component: string; field: string; pos: number }
  | { kind: 'unary'; op: UnaryOp; operand: AstNode; pos: number }
  | { kind: 'binary'; op: BinaryOp; left: AstNode; right: AstNode; pos: number }
  | { kind: 'logical'; op: LogicalOp; left: AstNode; right: AstNode; pos: number }
  | { kind: 'ternary'; cond: AstNode; then: AstNode; else: AstNode; pos: number }
  | { kind: 'call'; name: FunctionName; args: AstNode[]; pos: number }
  // 2.2 (§5.2): cross-entity reads, aggregates and `??`.
  /** `e.Component.field`; `self.C.f` reads the evaluated entity like `C.f`. */
  | { kind: 'member'; target: EntityNode; component: string; field: string; pos: number }
  /** `e.id`: the entity id as a number. */
  | { kind: 'entityId'; target: EntityNode; pos: number }
  /** `has(C)` / `has(e, C)` (the target defaults to self). */
  | { kind: 'has'; target: EntityNode; component: string; pos: number }
  /** `count(S)`, `exists(S)`, `sum|avg|minOf|maxOf(S, C.f)`. */
  | { kind: 'aggregate'; op: AggregateOp; set: string; component?: string; field?: string; pos: number }
  /** `countWithin(S, r[, e])` (the centre defaults to self). */
  | { kind: 'countWithin'; set: string; radius: AstNode; centre?: EntityNode; pos: number }
  /** `distanceTo(e)`. */
  | { kind: 'distanceTo'; target: EntityNode; pos: number }
  /** `a ?? b`: `b` when evaluating `a` yields no value. */
  | { kind: 'nullish'; left: AstNode; right: AstNode; pos: number }
  // 2.2 (§5.4): input reads.
  /** `key(n)` (held), `pressed(n)` / `released(n)` (edges this tick), `mod(n)`. */
  | { kind: 'input'; op: InputOp; arg: AstNode; pos: number }
  /** `pointer.x`, `pointer.y`, `pointer.buttons`, `pointer.wheel`. */
  | { kind: 'pointer'; field: PointerField; pos: number }

/** The expression children of an entity node, in source order. */
function entityChildren(target: EntityNode): AstNode[] {
  if (target.kind === 'select') return target.maxDistance ? [target.maxDistance] : []
  if (target.kind === 'entityById') return [target.id]
  return []
}

/**
 * Walk every read of the evaluated entity's own fields reachable from
 * `node`, in left-to-right order: `Component.field` and (2.2) `self.C.f`,
 * including inside the expression arguments of the 2.2 forms. Reads of
 * other entities (`first(S).C.f`), sets and `has` targets are not visited;
 * {@link walkComponentRefs} visits every component name. Used by
 * `compileRule` (rules.ts).
 */
export function walkFieldRefs(
  node: AstNode,
  visit: (component: string, field: string, pos: number) => void,
): void {
  walkComponentRefs(node, (component, field, pos, role) => {
    if (role === 'self' && field !== null) visit(component, field, pos)
  })
}

/**
 * Walk every component name reachable from `node`, in left-to-right source
 * order (2.2, §5.2):
 * - `'self'`: a read of the evaluated entity's field (`C.f`, `self.C.f`);
 * - `'member'`: a read of another entity's field (`first(S).C.f`, `e.C.f`)
 *   or an aggregate's per-member field (`sum(S, C.f)`);
 * - `'set'` (`field` null): a set (`count(S)`, `first(S)`, …) or a `has`
 *   target component.
 *
 * `pos` is the node's position: the component token for `C.f`, the start of
 * the entity for `e.C.f`, and the form's name token for sets, aggregates and
 * `has`. Component renames and `compileRule` resolution use this walker.
 */
export function walkComponentRefs(
  node: AstNode,
  visit: (component: string, field: string | null, pos: number, role: 'self' | 'member' | 'set') => void,
): void {
  const entity = (target: EntityNode): void => {
    if (target.kind === 'select') visit(target.set, null, target.pos, 'set')
    for (const child of entityChildren(target)) walkComponentRefs(child, visit)
  }
  switch (node.kind) {
    case 'field':
      visit(node.component, node.field, node.pos, 'self')
      return
    case 'member':
      entity(node.target)
      visit(node.component, node.field, node.pos, node.target.kind === 'self' ? 'self' : 'member')
      return
    case 'entityId':
    case 'distanceTo':
      entity(node.target)
      return
    case 'has':
      entity(node.target)
      visit(node.component, null, node.pos, 'set')
      return
    case 'aggregate':
      visit(node.set, null, node.pos, 'set')
      if (node.component !== undefined && node.field !== undefined) {
        visit(node.component, node.field, node.pos, 'member')
      }
      return
    case 'countWithin':
      visit(node.set, null, node.pos, 'set')
      walkComponentRefs(node.radius, visit)
      if (node.centre) entity(node.centre)
      return
    case 'unary':
      walkComponentRefs(node.operand, visit)
      return
    case 'binary':
    case 'logical':
    case 'nullish':
      walkComponentRefs(node.left, visit)
      walkComponentRefs(node.right, visit)
      return
    case 'ternary':
      walkComponentRefs(node.cond, visit)
      walkComponentRefs(node.then, visit)
      walkComponentRefs(node.else, visit)
      return
    case 'call':
      for (const arg of node.args) walkComponentRefs(arg, visit)
      return
    case 'input':
      walkComponentRefs(node.arg, visit)
      return
    case 'number':
    case 'string':
    case 'boolean':
    case 'identifier':
    case 'pointer':
      return
  }
}

/** Every direct child of `node` (expressions and entity nodes), for depth walks. */
export function childNodes(node: AstNode | EntityNode): Array<AstNode | EntityNode> {
  switch (node.kind) {
    case 'unary':
      return [node.operand]
    case 'binary':
    case 'logical':
    case 'nullish':
      return [node.left, node.right]
    case 'ternary':
      return [node.cond, node.then, node.else]
    case 'call':
      return node.args
    case 'input':
      return [node.arg]
    case 'member':
    case 'entityId':
    case 'has':
    case 'distanceTo':
      return [node.target]
    case 'countWithin':
      return node.centre ? [node.radius, node.centre] : [node.radius]
    case 'select':
      return node.maxDistance ? [node.maxDistance] : []
    case 'entityById':
      return [node.id]
    default:
      return []
  }
}
