import { FUNCTION_ARITY, FUNCTION_NAMES, type AstNode, type BinaryOp, type FunctionName } from './ast.js'
import { LexError, tokenize, type Token } from './lexer.js'

/**
 * Rules expression grammar (exactly this, nothing more):
 *
 *   expr       := ternary
 *   ternary    := logicOr ( '?' ternary ':' ternary )?        // right-assoc
 *   logicOr    := logicAnd ( '||' logicAnd )*
 *   logicAnd   := equality ( '&&' equality )*
 *   equality   := relational ( ('==' | '!=') relational )*
 *   relational := additive ( ('<' | '<=' | '>' | '>=') additive )*
 *   additive   := multiplicative ( ('+' | '-') multiplicative )*
 *   multiplicative := unary ( ('*' | '/' | '%') unary )*
 *   unary      := ('!' | '-') unary | primary
 *   primary    := number | string | 'true' | 'false'
 *               | 'dt' | 'time'
 *               | IDENT '.' IDENT                              // Component.field
 *               | IDENT '(' args? ')'                          // whitelisted call
 *               | '(' expr ')'
 *   args       := expr ( ',' expr )*
 *
 * Function calls are restricted to exactly: min(a,b) max(a,b) clamp(v,lo,hi)
 * abs(v) sin(v) cos(v) floor(v) random(). Wrong arity or an unknown function
 * name is a ParseError, not a runtime error — the whitelist and arg counts
 * are enforced at parse time.
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
    const cond = this.parseBinary(1)
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
      left = LOGICAL_OPS.has(op)
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

      if (t.value === 'dt' || t.value === 'time') {
        this.advance()
        return { kind: 'identifier', name: t.value, pos: t.pos }
      }

      // Component.field
      const next = this.tokens[this.index + 1]
      if (next && next.type === 'punct' && next.value === '.') {
        this.advance() // component name
        this.advance() // '.'
        const fieldTok = this.peek()
        if (fieldTok.type !== 'identifier') {
          if (fieldTok.type === 'eof') {
            throw new ParseFailure(fieldTok.pos, 'Unexpected end of input, expected a field name')
          }
          throw new ParseFailure(fieldTok.pos, `Unexpected token "${fieldTok.value}", expected a field name`)
        }
        this.advance()
        return { kind: 'field', component: t.value, field: fieldTok.value, pos: t.pos }
      }

      // Function call
      if (next && next.type === 'punct' && next.value === '(') {
        return this.parseCall()
      }

      throw new ParseFailure(
        t.pos,
        `Unknown identifier "${t.value}" (expected "dt", "time", or "Component.field")`,
      )
    }

    if (t.type === 'eof') {
      throw new ParseFailure(t.pos, 'Unexpected end of input, expected an expression')
    }

    throw new ParseFailure(t.pos, `Unexpected token "${t.value}"`)
  }

  private parseCall(): AstNode {
    const nameTok = this.advance() // identifier
    const pos = nameTok.pos
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

    if (!FUNCTION_NAME_SET.has(nameTok.value)) {
      throw new ParseFailure(pos, `Unknown function "${nameTok.value}"`)
    }
    const name = nameTok.value as FunctionName
    const expected = FUNCTION_ARITY[name]
    if (args.length !== expected) {
      throw new ParseFailure(
        pos,
        `Function "${name}" expects ${expected} argument${expected === 1 ? '' : 's'}, got ${args.length}`,
      )
    }
    return { kind: 'call', name, args, pos }
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
function deepestNode(root: AstNode): AstNode | null {
  const stack: Array<[AstNode, number]> = [[root, 1]]
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!
    if (depth > MAX_EXPRESSION_DEPTH) return node
    switch (node.kind) {
      case 'unary':
        stack.push([node.operand, depth + 1])
        break
      case 'binary':
      case 'logical':
        stack.push([node.left, depth + 1], [node.right, depth + 1])
        break
      case 'ternary':
        stack.push([node.cond, depth + 1], [node.then, depth + 1], [node.else, depth + 1])
        break
      case 'call':
        for (const a of node.args) stack.push([a, depth + 1])
        break
      default:
        break
    }
  }
  return null
}
