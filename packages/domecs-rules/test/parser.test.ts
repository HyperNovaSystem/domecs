import { describe, expect, it } from 'vitest'
import { parseExpression, type AstNode } from '../src/parser.js'

function ok(source: string): AstNode {
  const result = parseExpression(source)
  if ('errors' in result) {
    throw new Error(`expected ${source} to parse, got errors: ${JSON.stringify(result.errors)}`)
  }
  return result.ast
}

function errs(source: string): { position: number; message: string }[] {
  const result = parseExpression(source)
  if (!('errors' in result)) {
    throw new Error(`expected ${source} to fail, got ast: ${JSON.stringify(result.ast)}`)
  }
  return result.errors
}

describe('parseExpression — literals', () => {
  it('parses a number literal', () => {
    expect(ok('42')).toEqual({ kind: 'number', value: 42, pos: 0 })
  })

  it('parses a decimal number literal', () => {
    expect(ok('3.5')).toEqual({ kind: 'number', value: 3.5, pos: 0 })
  })

  it('parses a double-quoted string literal', () => {
    expect(ok('"hello"')).toEqual({ kind: 'string', value: 'hello', pos: 0 })
  })

  it('parses a single-quoted string literal', () => {
    expect(ok("'hello'")).toEqual({ kind: 'string', value: 'hello', pos: 0 })
  })

  it('parses boolean literals', () => {
    expect(ok('true')).toEqual({ kind: 'boolean', value: true, pos: 0 })
    expect(ok('false')).toEqual({ kind: 'boolean', value: false, pos: 0 })
  })

  it('parses the bare identifiers dt and time', () => {
    expect(ok('dt')).toEqual({ kind: 'identifier', name: 'dt', pos: 0 })
    expect(ok('time')).toEqual({ kind: 'identifier', name: 'time', pos: 0 })
  })

  it('parses a Component.field reference', () => {
    expect(ok('Health.hp')).toEqual({ kind: 'field', component: 'Health', field: 'hp', pos: 0 })
  })
})

describe('parseExpression — precedence', () => {
  it('binds * tighter than + (1 + 2 * 3)', () => {
    const ast = ok('1 + 2 * 3') as Extract<AstNode, { kind: 'binary' }>
    expect(ast.kind).toBe('binary')
    expect(ast.op).toBe('+')
    expect(ast.left).toEqual({ kind: 'number', value: 1, pos: 0 })
    expect(ast.right).toMatchObject({ kind: 'binary', op: '*' })
  })

  it('respects explicit grouping ((1+2)*3)', () => {
    const ast = ok('(1 + 2) * 3') as Extract<AstNode, { kind: 'binary' }>
    expect(ast.kind).toBe('binary')
    expect(ast.op).toBe('*')
    expect(ast.left).toMatchObject({ kind: 'binary', op: '+' })
    expect(ast.right).toEqual({ kind: 'number', value: 3, pos: 10 })
  })

  it('binary operators are left-associative (10 - 3 - 2 == 5)', () => {
    // (10 - 3) - 2
    const ast = ok('10 - 3 - 2') as Extract<AstNode, { kind: 'binary' }>
    expect(ast.op).toBe('-')
    expect(ast.left).toMatchObject({ kind: 'binary', op: '-' })
    expect(ast.right).toEqual({ kind: 'number', value: 2, pos: 9 })
  })

  it('comparison binds looser than additive (1 + 1 < 3)', () => {
    const ast = ok('1 + 1 < 3') as Extract<AstNode, { kind: 'binary' }>
    expect(ast.op).toBe('<')
    expect(ast.left).toMatchObject({ kind: 'binary', op: '+' })
  })

  it('&& binds tighter than ||', () => {
    const ast = ok('true || false && false') as Extract<AstNode, { kind: 'logical' }>
    expect(ast.op).toBe('||')
    expect(ast.right).toMatchObject({ kind: 'logical', op: '&&' })
  })

  it('equality binds looser than relational', () => {
    const ast = ok('1 < 2 == true') as Extract<AstNode, { kind: 'binary' }>
    expect(ast.op).toBe('==')
    expect(ast.left).toMatchObject({ kind: 'binary', op: '<' })
  })

  it('unary ! binds tighter than && (!a && b)', () => {
    const ast = ok('!true && false') as Extract<AstNode, { kind: 'logical' }>
    expect(ast.kind).toBe('logical')
    expect(ast.op).toBe('&&')
    expect(ast.left).toMatchObject({ kind: 'unary', op: '!' })
  })

  it('unary - binds tighter than * (-2 * 3 == -6)', () => {
    const ast = ok('-2 * 3') as Extract<AstNode, { kind: 'binary' }>
    expect(ast.kind).toBe('binary')
    expect(ast.op).toBe('*')
    expect(ast.left).toMatchObject({ kind: 'unary', op: '-' })
  })

  it('unary - binds tighter than + (-2 + 3 == 1, not -(2+3))', () => {
    const ast = ok('-2 + 3') as Extract<AstNode, { kind: 'binary' }>
    expect(ast.op).toBe('+')
    expect(ast.left).toMatchObject({ kind: 'unary', op: '-' })
    expect(ast.right).toEqual({ kind: 'number', value: 3, pos: 5 })
  })

  it('unary operators chain right-associatively (!!true)', () => {
    const ast = ok('!!true') as Extract<AstNode, { kind: 'unary' }>
    expect(ast.kind).toBe('unary')
    expect(ast.op).toBe('!')
    expect(ast.operand).toMatchObject({ kind: 'unary', op: '!' })
  })

  it('ternary is right-associative (a ? b : c ? d : e)', () => {
    const ast = ok('true ? 1 : false ? 2 : 3') as Extract<AstNode, { kind: 'ternary' }>
    expect(ast.kind).toBe('ternary')
    expect(ast.then).toEqual({ kind: 'number', value: 1, pos: 7 })
    expect(ast.else).toMatchObject({ kind: 'ternary' })
  })

  it('ternary binds looser than ||', () => {
    const ast = ok('true || false ? 1 : 2') as Extract<AstNode, { kind: 'ternary' }>
    expect(ast.kind).toBe('ternary')
    expect(ast.cond).toMatchObject({ kind: 'logical', op: '||' })
  })
})

describe('parseExpression — function calls', () => {
  it('parses min/max/clamp/abs/sin/cos/floor/random with correct arities', () => {
    expect(ok('min(1, 2)')).toMatchObject({ kind: 'call', name: 'min' })
    expect(ok('max(1, 2)')).toMatchObject({ kind: 'call', name: 'max' })
    expect(ok('clamp(1, 0, 10)')).toMatchObject({ kind: 'call', name: 'clamp' })
    expect(ok('abs(-1)')).toMatchObject({ kind: 'call', name: 'abs' })
    expect(ok('sin(0)')).toMatchObject({ kind: 'call', name: 'sin' })
    expect(ok('cos(0)')).toMatchObject({ kind: 'call', name: 'cos' })
    expect(ok('floor(1.5)')).toMatchObject({ kind: 'call', name: 'floor' })
    expect(ok('random()')).toEqual({ kind: 'call', name: 'random', args: [], pos: 0 })
  })

  it('parses nested calls and expression args', () => {
    const ast = ok('clamp(Health.hp + 1, 0, 100)') as Extract<AstNode, { kind: 'call' }>
    expect(ast.name).toBe('clamp')
    expect(ast.args).toHaveLength(3)
    expect(ast.args[0]).toMatchObject({ kind: 'binary', op: '+' })
  })
})

describe('parseExpression — error positions', () => {
  it('reports an unterminated expression at EOF position', () => {
    const errors = errs('1 + ')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.position).toBe(4)
  })

  it('reports an unknown function name at the call site', () => {
    const errors = errs('foo(1, 2)')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.position).toBe(0)
    expect(errors[0]!.message).toContain('foo')
  })

  it('reports wrong argument count at the call site (too few)', () => {
    const errors = errs('min(1)')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.position).toBe(0)
    expect(errors[0]!.message).toContain('min')
    expect(errors[0]!.message).toContain('2')
    expect(errors[0]!.message).toContain('1')
  })

  it('reports wrong argument count at the call site (too many)', () => {
    const errors = errs('abs(1, 2)')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.position).toBe(0)
  })

  it('reports an unknown bare identifier at its position', () => {
    const errors = errs('foo')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.position).toBe(0)
  })

  it('reports a missing field name after the dot', () => {
    const errors = errs('Health.')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.position).toBe(7)
  })

  it('reports an unterminated string literal at the opening quote', () => {
    const errors = errs('"abc')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.position).toBe(0)
  })

  it('reports an unclosed paren group', () => {
    const errors = errs('(1 + 2')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.position).toBe(6)
  })

  it('reports a stray trailing token', () => {
    const errors = errs('1 2')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.position).toBe(2)
  })

  it('reports an unexpected character', () => {
    const errors = errs('1 @ 2')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.position).toBe(2)
  })
})
