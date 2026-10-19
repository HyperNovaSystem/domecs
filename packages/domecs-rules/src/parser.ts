import {
  childNodes,
  FUNCTION_ARITY,
  FUNCTION_NAMES,
  RESERVED_WORDS,
  type AggregateOp,
  type AstNode,
  type BinaryOp,
  type EntityNode,
  type FunctionName,
  type InputOp,
  type PointerField,
} from './ast.js'
import { LexError, tokenize, type Token } from './lexer.js'

/**
 * Rules expression grammar (exactly this, nothing more; `(+)` marks the
 * 2.2 additions, spec §5.2):
 *
 *   expr       := ternary
 *   ternary    := nullish ( '?' ternary ':' ternary )?        // right-assoc
 *   nullish    := logicOr ( '??' logicOr )*                    (+) left-assoc
 *   logicOr    := logicAnd ( '||' logicAnd )*
 *   logicAnd   := equality ( '&&' equality )*
 *   equality   := relational ( ('==' | '!=') relational )*
 *   relational := additive ( ('<' | '<=' | '>' | '>=') additive )*
 *   additive   := multiplicative ( ('+' | '-') multiplicative )*
 *   multiplicative := unary ( ('*' | '/' | '%') unary )*
 *   unary      := ('!' | '-') unary | primary
 *   primary    := number | string | 'true' | 'false'
 *               | 'dt' | 'time' | 'tick'                       (+) tick
 *               | IDENT '.' IDENT                              // Component.field
 *               | entity '.' IDENT '.' IDENT                   (+) another entity's field
 *               | entity '.' 'id'                              (+) entity id
 *               | 'pointer' '.' ('x' | 'y' | 'buttons' | 'wheel')  (+) §5.4
 *               | call
 *               | '(' expr ')'
 *   entity     := 'self' | 'first' '(' SET ')'                 (+)
 *               | 'nearest' '(' SET ( ',' expr )? ')'          (+) optional max distance
 *               | 'entity' '(' expr ')'                        (+) by numeric id
 *   call       := FUNC '(' args? ')'                           // whitelisted call
 *               | 'has' '(' ( entity ',' )? SET ')'            (+)
 *               | ('count' | 'exists') '(' SET ')'             (+)
 *               | 'countWithin' '(' SET ',' expr ( ',' entity )? ')'   (+)
 *               | ('sum' | 'avg' | 'minOf' | 'maxOf') '(' SET ',' IDENT '.' IDENT ')'  (+)
 *               | 'distanceTo' '(' entity ')'                  (+)
 *               | ('key' | 'pressed' | 'released' | 'mod') '(' expr ')'  (+) §5.4, arg: a string
 *   args       := expr ( ',' expr )*
 *   SET        := IDENT                                        (+) a component name: its holders
 *
 * Function calls are restricted to exactly: min(a,b) max(a,b) clamp(v,lo,hi)
 * abs(v) sin(v) cos(v) floor(v) random(), and from 2.2 sqrt(v) pow(a,b)
 * atan2(y,x) hypot(a,b) sign(v) round(v) ceil(v) lerp(a,b,t)
 * distance(x1,y1,x2,y2). Wrong arity or an unknown function name is a
 * ParseError, not a runtime error — the whitelist and arg counts are
 * enforced at parse time.
 *
 * Reserved words (2.2): `self`, `tick`, `other`, `event`, `pointer` cannot
 * name a component in an expression, and `id` cannot after an entity. Only
 * `first(`, `nearest(` and `entity(` start a selector: `first.x` is still
 * `Component.field`. An entity is not a value: use `.id` or
 * `.Component.field`. Input reads (2.2, §5.4): `key(n)`, `pressed(n)`,
 * `released(n)`, `mod(n)` and `pointer.x|y|buttons|wheel`; `key`,
 * `pressed`, `released` and `mod` start an input read only before `(`.
 */

/**
 * O-66: limits that keep rule data from overflowing the stack. The parser,
 * `walkFieldRefs` and the evaluator all recurse over the AST, so its depth
 * is bounded — nesting through parentheses, unary operators and ternaries,
 * and long operator chains, which build a left-nested tree as deep as the
 * chain is long. Exceeding either limit is a ParseError.
 */
export const MAX_EXPRESSION_LENGTH = 16_384
export const MAX_EXPRESSION_DEPTH = 128

export interface ParseError {
  position: number
  message: string
}

class ParseFailure extends Error {
  constructor(
    public position: number,
    message: string,
  ) {
    super(message)
    this.name = 'ParseFailure'
  }
}

const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  '??': 0,
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
}
const LOGICAL_OPS = new Set(['&&', '||'])

const FUNCTION_NAME_SET = new Set<string>(FUNCTION_NAMES)
const SELECTORS = new Set(['first', 'nearest', 'entity'])
const INPUT_OPS = new Set<string>(['key', 'pressed', 'released', 'mod'])
const POINTER_FIELDS = new Set<string>(['x', 'y', 'buttons', 'wheel'])

function reserved(name: string): string {
  return `"${name}" is a reserved word: it cannot name a component in an expression`
}

class Parser {
  private tokens: Token[]
  private index = 0
  /** Current recursion depth through parseTernary/parseUnary (O-66). */
  private depth = 0

  constructor(source: string) {
    this.tokens = tokenize(source)
  }

  private peek(): Token {
    return this.tokens[this.index]!
  }

  private advance(): Token {
    const t = this.tokens[this.index]!
    if (this.index < this.tokens.length - 1) this.index++
    return t
  }

  private expectPunct(value: string): Token {
    const t = this.peek()
    if (t.type === 'punct' && t.value === value) {
      return this.advance()
    }
    if (t.type === 'eof') {
      throw new ParseFailure(t.pos, `Unexpected end of input, expected "${value}"`)
    }
    throw new ParseFailure(t.pos, `Unexpected token "${t.value}", expected "${value}"`)
  }

  parseProgram(): AstNode {
    const node = this.parseTernary()
    const t = this.peek()
    if (t.type !== 'eof') {
      throw new ParseFailure(t.pos, `Unexpected token "${t.value}"`)
    }
    return node
  }

  // Recursion guard only: a parenthesis and a unary operator each cost a
  // level here, so allow twice the AST limit and let deepestNode() apply
  // the exact one.
  private enter(pos: number): void {
    if (++this.depth > 2 * MAX_EXPRESSION_DEPTH) {
      throw new ParseFailure(pos, `Expression nests deeper than ${MAX_EXPRESSION_DEPTH} levels`)
    }
  }

  private parseTernary(): AstNode {
    this.enter(this.peek().pos)
    try {
      return this.parseTernaryInner()
    } finally {
      this.depth--
    }
  }

  private parseTernaryInner(): AstNode {
    const cond = this.parseBinary(0)
    const t = this.peek()
    if (t.type === 'punct' && t.value === '?') {
      const pos = t.pos
      this.advance()
      const thenExpr = this.parseTernary()
      this.expectPunct(':')
      const elseExpr = this.parseTernary()
      return { kind: 'ternary', cond, then: thenExpr, else: elseExpr, pos }
    }
    return cond
  }

  // Precedence-climbing binary-operator parse. minPrec is the lowest
  // precedence level this call is willing to consume.
  private parseBinary(minPrec: number): AstNode {
    let left = this.parseUnary()
    for (;;) {
      const t = this.peek()
      if (t.type !== 'punct') break
      const prec = BINARY_PRECEDENCE[t.value]
      if (prec === undefined || prec < minPrec) break
      const op = t.value
      const pos = t.pos
      this.advance()
      const right = this.parseBinary(prec + 1)
      left =
        op === '??'
          ? { kind: 'nullish', left, right, pos }
          : LOGICAL_OPS.has(op)
            ? { kind: 'logical', op: op as '&&' | '||', left, right, pos }
            : { kind: 'binary', op: op as BinaryOp, left, right, pos }
    }
    return left
  }

  private parseUnary(): AstNode {
    const t = this.peek()
    if (t.type === 'punct' && (t.value === '!' || t.value === '-')) {
      const pos = t.pos
      this.advance()
      this.enter(pos)
      try {
        const operand = this.parseUnary()
        return { kind: 'unary', op: t.value, operand, pos }
      } finally {
        this.depth--
      }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): AstNode {
    const t = this.peek()

    if (t.type === 'number') {
      this.advance()
      return { kind: 'number', value: Number(t.value), pos: t.pos }
    }

    if (t.type === 'string') {
      this.advance()
      return { kind: 'string', value: t.value, pos: t.pos }
    }

    if (t.type === 'punct' && t.value === '(') {
      this.advance()
      const inner = this.parseTernary()
      this.expectPunct(')')
      return inner
    }

    if (t.type === 'identifier') {
      if (t.value === 'true' || t.value === 'false') {
        this.advance()
        return { kind: 'boolean', value: t.value === 'true', pos: t.pos }
      }

      const next = this.tokens[this.index + 1]
      const nextIs = (value: string): boolean => next !== undefined && next.type === 'punct' && next.value === value

      if (t.value === 'tick' && nextIs('.')) throw new ParseFailure(t.pos, reserved('tick'))
      if (t.value === 'dt' || t.value === 'time' || t.value === 'tick') {
        this.advance()
        return { kind: 'identifier', name: t.value, pos: t.pos }
      }

      // Entity reads: self.C.f, self.id, first(S).C.f, nearest(S).id, entity(n).C.f
      if (t.value === 'self' || (SELECTORS.has(t.value) && nextIs('('))) {
        return this.parseEntityAccess(this.parseEntity())
      }
      if (t.value === 'pointer') return this.parsePointer()
      if (RESERVED_WORDS.has(t.value)) throw new ParseFailure(t.pos, reserved(t.value))

      // Component.field
      if (nextIs('.')) {
        this.advance() // component name
        this.advance() // '.'
        const fieldTok = this.expectIdentifier('a field name')
        return { kind: 'field', component: t.value, field: fieldTok.value, pos: t.pos }
      }

      // Function call or special form
      if (nextIs('(')) {
        return this.parseCall()
      }

      throw new ParseFailure(
        t.pos,
        `Unknown identifier "${t.value}" (expected "dt", "time", "tick", "Component.field" or an entity read)`,
      )
    }

    if (t.type === 'eof') {
      throw new ParseFailure(t.pos, 'Unexpected end of input, expected an expression')
    }

    throw new ParseFailure(t.pos, `Unexpected token "${t.value}"`)
  }

  /** 'pointer' '.' ('x' | 'y' | 'buttons' | 'wheel') (§5.4) */
  private parsePointer(): AstNode {
    const t = this.advance() // 'pointer'
    const dot = this.peek()
    if (!(dot.type === 'punct' && dot.value === '.')) {
      throw new ParseFailure(
        t.pos,
        `"pointer" is not a value: read pointer.x, pointer.y, pointer.buttons or pointer.wheel (${reserved('pointer')})`,
      )
    }
    this.advance() // '.'
    const field = this.expectIdentifier('a pointer field (x, y, buttons or wheel)')
    if (!POINTER_FIELDS.has(field.value)) {
      throw new ParseFailure(
        t.pos,
        `"pointer.${field.value}": pointer has only x, y, buttons and wheel (${reserved('pointer')})`,
      )
    }
    return { kind: 'pointer', field: field.value as PointerField, pos: t.pos }
  }

  private expectIdentifier(what: string): Token {
    const t = this.peek()
    if (t.type !== 'identifier') {
      if (t.type === 'eof') throw new ParseFailure(t.pos, `Unexpected end of input, expected ${what}`)
      throw new ParseFailure(t.pos, `Unexpected token "${t.value}", expected ${what}`)
    }
    return this.advance()
  }

  /** A component name used as a set or a component: not a reserved word. */
  private parseComponentName(what: string): string {
    const t = this.expectIdentifier(what)
    if (RESERVED_WORDS.has(t.value)) throw new ParseFailure(t.pos, reserved(t.value))
    return t.value
  }

  /** entity := 'self' | first(SET) | nearest(SET[, expr]) | entity(expr) */
  private parseEntity(): EntityNode {
    const t = this.peek()
    const next = this.tokens[this.index + 1]
    if (t.type === 'identifier' && t.value === 'self') {
      this.advance()
      return { kind: 'self', pos: t.pos }
    }
    if (t.type === 'identifier' && SELECTORS.has(t.value) && next?.type === 'punct' && next.value === '(') {
      this.advance()
      this.advance() // '('
      if (t.value === 'entity') {
        const id = this.parseTernary()
        this.expectPunct(')')
        return { kind: 'entityById', id, pos: t.pos }
      }
      const set = this.parseComponentName('a component name')
      if (t.value === 'first') {
        this.expectPunct(')')
        return { kind: 'select', op: 'first', set, pos: t.pos }
      }
      let maxDistance: AstNode | undefined
      if (this.peek().type === 'punct' && this.peek().value === ',') {
        this.advance()
        maxDistance = this.parseTernary()
      }
      this.expectPunct(')')
      return maxDistance
        ? { kind: 'select', op: 'nearest', set, maxDistance, pos: t.pos }
        : { kind: 'select', op: 'nearest', set, pos: t.pos }
    }
    throw new ParseFailure(
      t.pos,
      t.type === 'eof'
        ? 'Unexpected end of input, expected an entity (self, first(S), nearest(S[, d]) or entity(n))'
        : `Expected an entity (self, first(S), nearest(S[, d]) or entity(n)), got "${t.value}"`,
    )
  }

  /** entity '.' 'id' | entity '.' IDENT '.' IDENT */
  private parseEntityAccess(target: EntityNode): AstNode {
    const dot = this.peek()
    if (!(dot.type === 'punct' && dot.value === '.')) {
      throw new ParseFailure(target.pos, 'An entity is not a value (use .id, or .Component.field)')
    }
    this.advance()
    const name = this.expectIdentifier('a component name or "id"')
    const after = this.peek()
    const dotNext = after.type === 'punct' && after.value === '.'
    if (name.value === 'id') {
      if (dotNext) throw new ParseFailure(name.pos, '"id" is reserved after an entity (e.id is the entity id)')
      return { kind: 'entityId', target, pos: target.pos }
    }
    if (target.kind === 'self' && !dotNext) {
      // `self.hp` reads like a component named "self"; say why it is not one.
      throw new ParseFailure(
        target.pos,
        `${reserved('self')}; write self.Component.field to read this entity (self.${name.value}.field)`,
      )
    }
    if (RESERVED_WORDS.has(name.value)) throw new ParseFailure(name.pos, reserved(name.value))
    if (!dotNext) {
      throw new ParseFailure(
        after.pos,
        after.type === 'eof'
          ? `Unexpected end of input, expected "." and a field name after "${name.value}"`
          : `Unexpected token "${after.value}", expected "." and a field name after "${name.value}"`,
      )
    }
    this.advance() // '.'
    const field = this.expectIdentifier('a field name')
    return { kind: 'member', target, component: name.value, field: field.value, pos: target.pos }
  }

  private parseCall(): AstNode {
    const nameTok = this.advance() // identifier
    const pos = nameTok.pos
    const name = nameTok.value

    switch (name) {
      case 'has': {
        this.expectPunct('(')
        const t = this.peek()
        const next = this.tokens[this.index + 1]
        let target: EntityNode
        if (t.type === 'identifier' && t.value !== 'self' && next?.type === 'punct' && next.value === ')') {
          target = { kind: 'self', pos }
        } else {
          target = this.parseEntity()
          this.expectPunct(',')
        }
        const component = this.parseComponentName('a component name')
        this.expectPunct(')')
        return { kind: 'has', target, component, pos }
      }
      case 'count':
      case 'exists': {
        this.expectPunct('(')
        const set = this.parseComponentName('a component name')
        this.expectPunct(')')
        return { kind: 'aggregate', op: name, set, pos }
      }
      case 'sum':
      case 'avg':
      case 'minOf':
      case 'maxOf': {
        this.expectPunct('(')
        const set = this.parseComponentName('a component name')
        this.expectPunct(',')
        const component = this.parseComponentName('"Component.field"')
        const dot = this.peek()
        if (!(dot.type === 'punct' && dot.value === '.')) this.expectPunct('.')
        this.advance()
        const field = this.expectIdentifier('a field name')
        this.expectPunct(')')
        return { kind: 'aggregate', op: name as AggregateOp, set, component, field: field.value, pos }
      }
      case 'countWithin': {
        this.expectPunct('(')
        const set = this.parseComponentName('a component name')
        this.expectPunct(',')
        const radius = this.parseTernary()
        let centre: EntityNode | undefined
        if (this.peek().type === 'punct' && this.peek().value === ',') {
          this.advance()
          centre = this.parseEntity()
        }
        this.expectPunct(')')
        return centre ? { kind: 'countWithin', set, radius, centre, pos } : { kind: 'countWithin', set, radius, pos }
      }
      case 'distanceTo': {
        this.expectPunct('(')
        const target = this.parseEntity()
        this.expectPunct(')')
        return { kind: 'distanceTo', target, pos }
      }
      default:
        break
    }

    this.expectPunct('(')
    const args: AstNode[] = []
    if (!(this.peek().type === 'punct' && this.peek().value === ')')) {
      args.push(this.parseTernary())
      while (this.peek().type === 'punct' && this.peek().value === ',') {
        this.advance()
        args.push(this.parseTernary())
      }
    }
    this.expectPunct(')')

    if (INPUT_OPS.has(name)) {
      if (args.length !== 1) throw new ParseFailure(pos, `Function "${name}" expects 1 argument, got ${args.length}`)
      return { kind: 'input', op: name as InputOp, arg: args[0]!, pos }
    }
    if (!FUNCTION_NAME_SET.has(name)) {
      throw new ParseFailure(pos, `Unknown function "${name}"`)
    }
    const fn = name as FunctionName
    const expected = FUNCTION_ARITY[fn]
    if (args.length !== expected) {
      throw new ParseFailure(
        pos,
        `Function "${fn}" expects ${expected} argument${expected === 1 ? '' : 's'}, got ${args.length}`,
      )
    }
    return { kind: 'call', name: fn, args, pos }
  }
}

/**
 * Parse a single expression. Never throws: a syntax error is always
 * reported as a {@link ParseError} with an accurate character `position`
 * (0-based offset into `source`), not an exception.
 */
export function parseExpression(source: string): { ast: AstNode } | { errors: ParseError[] } {
  if (source.length > MAX_EXPRESSION_LENGTH) {
    return {
      errors: [{ position: MAX_EXPRESSION_LENGTH, message: `Expression is longer than ${MAX_EXPRESSION_LENGTH} characters` }],
    }
  }
  try {
    const parser = new Parser(source)
    const ast = parser.parseProgram()
    const deep = deepestNode(ast)
    if (deep) {
      return {
        errors: [{ position: deep.pos, message: `Expression nests deeper than ${MAX_EXPRESSION_DEPTH} levels` }],
      }
    }
    return { ast }
  } catch (e) {
    if (e instanceof ParseFailure) {
      return { errors: [{ position: e.position, message: e.message }] }
    }
    if (e instanceof LexError) {
      return { errors: [{ position: e.position, message: e.message }] }
    }
    throw e
  }
}

export type { AstNode } from './ast.js'

/**
 * The first node found below {@link MAX_EXPRESSION_DEPTH}, or null. Walks with
 * an explicit stack: long operator chains build trees deeper than the
 * parser's own recursion, which is what the limit protects later passes from.
 */
function deepestNode(root: AstNode): AstNode | EntityNode | null {
  const stack: Array<[AstNode | EntityNode, number]> = [[root, 1]]
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!
    if (depth > MAX_EXPRESSION_DEPTH) return node
    for (const child of childNodes(node)) stack.push([child, depth + 1])
  }
  return null
}
