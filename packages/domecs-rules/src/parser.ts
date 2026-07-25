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

  private parseTernary(): AstNode {
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
      const operand = this.parseUnary()
      return { kind: 'unary', op: t.value, operand, pos }
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
  try {
    const parser = new Parser(source)
    const ast = parser.parseProgram()
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
