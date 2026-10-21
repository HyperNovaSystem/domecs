/**
 * AST for the rules expression grammar (see doc comment on
 * {@link import('./parser.js').parseExpression} for the exact grammar).
 *
 * Every node carries `pos`: the character offset (0-based, into the source
 * string that was parsed) of the token the node starts at. Used to report
 * accurate positions for component-resolution errors raised later by
 * `compileRule` against a successfully-parsed AST (see rules.ts). Nodes that
 * name a component after their start (2.3) also carry that name token's
 * position (`setPos`, `componentPos`), which the walkers report as `namePos`.
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
 * Names the parser reserves (2.2, §5.2, ED-9): `self`, `tick`, (§5.4)
 * `pointer` (`pointer.x`), and (2.3, §6.1) `other` (an event rule's bound
 * entity) and `event` (`event.f`, the triggering payload's field). A
 * component with one of these names cannot be referenced in an expression.
 * After an entity, `id` is reserved too (`e.id` is the entity id).
 */
export const RESERVED_WORDS: ReadonlySet<string> = new Set(['self', 'tick', 'other', 'event', 'pointer'])

/** What a selector, `self` or (2.3) `other` refers to (2.2). */
export type EntityNode =
  | { kind: 'self'; pos: number }
  /** 2.3 (§6.1): the entity an event rule's `other` binding gives. */
  | { kind: 'other'; pos: number }
  /**
   * `setPos` (2.3, decision (f)): the position of the set's name token.
   * The parser always sets it; a hand-built node without it reports `pos`.
   */
  | { kind: 'select'; op: 'first' | 'nearest'; set: string; maxDistance?: AstNode; pos: number; setPos?: number }
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
  /**
   * `e.Component.field`; `self.C.f` reads the evaluated entity like `C.f`.
   * `componentPos` (2.3): the component token's position (`pos` is the
   * entity's start).
   */
  | { kind: 'member'; target: EntityNode; component: string; field: string; pos: number; componentPos?: number }
  /** `e.id`: the entity id as a number. */
  | { kind: 'entityId'; target: EntityNode; pos: number }
  /** `has(C)` / `has(e, C)` (the target defaults to self). `componentPos` (2.3): `C`'s token. */
  | { kind: 'has'; target: EntityNode; component: string; pos: number; componentPos?: number }
  /**
   * `count(S)`, `exists(S)`, `sum|avg|minOf|maxOf(S, C.f)`. `setPos` and
   * `componentPos` (2.3): the `S` and `C` tokens.
   */
  | {
      kind: 'aggregate'
      op: AggregateOp
      set: string
      component?: string
      field?: string
      pos: number
      setPos?: number
      componentPos?: number
    }
  /** `countWithin(S, r[, e])` (the centre defaults to self). `setPos` (2.3): `S`'s token. */
  | { kind: 'countWithin'; set: string; radius: AstNode; centre?: EntityNode; pos: number; setPos?: number }
  /** `distanceTo(e)`. */
  | { kind: 'distanceTo'; target: EntityNode; pos: number }
  /** `a ?? b`: `b` when evaluating `a` yields no value. */
  | { kind: 'nullish'; left: AstNode; right: AstNode; pos: number }
  // 2.2 (§5.4): input reads.
  /** `key(n)` (held), `pressed(n)` / `released(n)` (edges this tick), `mod(n)`. */
  | { kind: 'input'; op: InputOp; arg: AstNode; pos: number }
  /** `pointer.x`, `pointer.y`, `pointer.buttons`, `pointer.wheel`. */
  | { kind: 'pointer'; field: PointerField; pos: number }
  // 2.3 (§6.1): event rules.
  /** `event.f`: the triggering event payload's field (event rules only). */
  | { kind: 'event'; field: string; pos: number }

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
 * {@link walkComponentRefs} visits every component name. Exported from the
 * package entry for tools that only need self-field positions (a 2.1-style
 * rename of the evaluated entity's own reads); a rename that must also
 * cover member reads, sets and `has` targets uses `walkComponentRefs`.
 * `pos` is the node position: the component token for `C.f`, but the
 * `self` token for `self.C.f`. `namePos` (2.3, additive) is always the
 * component token, so a rename splices the new name at `namePos`.
 */
export function walkFieldRefs(
  node: AstNode,
  visit: (component: string, field: string, pos: number, namePos: number) => void,
): void {
  walkComponentRefs(node, (component, field, pos, role, namePos) => {
    if (role === 'self' && field !== null) visit(component, field, pos, namePos)
  })
}

/**
 * Walk every component name reachable from `node`, in left-to-right source
 * order (2.2, §5.2):
 * - `'self'`: a read of the evaluated entity's field (`C.f`, `self.C.f`);
 * - `'member'`: a read of another entity's field (`first(S).C.f`, `e.C.f`,
 *   2.3 `other.C.f`) or an aggregate's per-member field (`sum(S, C.f)`);
 * - `'set'` (`field` null): a set (`count(S)`, `first(S)`, …) or a `has`
 *   target component.
 *
 * `pos` is the node's position: the component token for `C.f`, the start of
 * the entity for `e.C.f`, and the form's name token for sets, aggregates and
 * `has`. `namePos` (2.3, additive) is the position of the visited name's own
 * token on every form (`self.C.f`, `e.C.f`, `first(S)`, `has(e, C)`,
 * `sum(S, C.f)`, …), so a rename splices the new name at `namePos`; a
 * hand-built node without the name positions reports `pos` there.
 * Component renames and `compileRule` resolution use this walker.
 * Payload reads (`event.f`, 2.3) name no component and are not visited.
 */
export function walkComponentRefs(
  node: AstNode,
  visit: (
    component: string,
    field: string | null,
    pos: number,
    role: 'self' | 'member' | 'set',
    namePos: number,
  ) => void,
): void {
  const entity = (target: EntityNode): void => {
    if (target.kind === 'select') visit(target.set, null, target.pos, 'set', target.setPos ?? target.pos)
    for (const child of entityChildren(target)) walkComponentRefs(child, visit)
  }
  switch (node.kind) {
    case 'field':
      visit(node.component, node.field, node.pos, 'self', node.pos)
      return
    case 'member':
      entity(node.target)
      visit(
        node.component,
        node.field,
        node.pos,
        node.target.kind === 'self' ? 'self' : 'member',
        node.componentPos ?? node.pos,
      )
      return
    case 'entityId':
    case 'distanceTo':
      entity(node.target)
      return
    case 'has':
      entity(node.target)
      visit(node.component, null, node.pos, 'set', node.componentPos ?? node.pos)
      return
    case 'aggregate':
      visit(node.set, null, node.pos, 'set', node.setPos ?? node.pos)
      if (node.component !== undefined && node.field !== undefined) {
        visit(node.component, node.field, node.pos, 'member', node.componentPos ?? node.pos)
      }
      return
    case 'countWithin':
      visit(node.set, null, node.pos, 'set', node.setPos ?? node.pos)
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
    case 'event':
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
