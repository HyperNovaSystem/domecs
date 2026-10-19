import { describe, expect, it } from 'vitest'
import { parseExpression, MAX_EXPRESSION_DEPTH, type AstNode } from '../src/parser.js'
import { FUNCTION_ARITY, FUNCTION_NAMES, SPECIAL_FORMS, walkComponentRefs, walkFieldRefs } from '../src/ast.js'
import * as rules from '../src/index.js'

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

// Spec §5.2 (G1, O-82), plan E10.2: grammar for selectors, aggregates, math
// and `??`. Every new form carries the position of the token it starts at.

function err1(source: string): { position: number; message: string } {
  const result = parseExpression(source)
  if (!('errors' in result)) throw new Error(`expected ${source} to fail, got ${JSON.stringify(result.ast)}`)
  expect(result.errors).toHaveLength(1)
  return result.errors[0]!
}

describe('E10.2 grammar: new primaries', () => {
  it('tick is a bare identifier', () => {
    expect(ok('tick')).toEqual({ kind: 'identifier', name: 'tick', pos: 0 })
    expect(ok('1 + tick')).toMatchObject({ right: { kind: 'identifier', name: 'tick', pos: 4 } })
  })

  it('self.C.f and self.id', () => {
    expect(ok('self.Pos.x')).toEqual({
      kind: 'member',
      target: { kind: 'self', pos: 0 },
      component: 'Pos',
      field: 'x',
      pos: 0,
    })
    expect(ok(' self.id')).toEqual({ kind: 'entityId', target: { kind: 'self', pos: 1 }, pos: 1 })
  })

  it('first(S).C.f, nearest(S).C.f, nearest(S, d).id, entity(n).C.f', () => {
    expect(ok('first(Player).Pos.x')).toEqual({
      kind: 'member',
      target: { kind: 'select', op: 'first', set: 'Player', pos: 0 },
      component: 'Pos',
      field: 'x',
      pos: 0,
    })
    expect(ok('2 * nearest(Enemy).Health.hp')).toMatchObject({
      right: {
        kind: 'member',
        target: { kind: 'select', op: 'nearest', set: 'Enemy', pos: 4 },
        component: 'Health',
        field: 'hp',
        pos: 4,
      },
    })
    expect(ok('nearest(Enemy, Sight.range * 2).id')).toEqual({
      kind: 'entityId',
      target: {
        kind: 'select',
        op: 'nearest',
        set: 'Enemy',
        maxDistance: {
          kind: 'binary',
          op: '*',
          left: { kind: 'field', component: 'Sight', field: 'range', pos: 15 },
          right: { kind: 'number', value: 2, pos: 29 },
          pos: 27,
        },
        pos: 0,
      },
      pos: 0,
    })
    expect(ok('entity(Target.id).Pos.y')).toEqual({
      kind: 'member',
      target: { kind: 'entityById', id: { kind: 'field', component: 'Target', field: 'id', pos: 7 }, pos: 0 },
      component: 'Pos',
      field: 'y',
      pos: 0,
    })
  })

  it('has(C) and has(e, C)', () => {
    expect(ok('has(Shield)')).toEqual({ kind: 'has', target: { kind: 'self', pos: 0 }, component: 'Shield', pos: 0 })
    expect(ok('has(first(Player), Shield)')).toEqual({
      kind: 'has',
      target: { kind: 'select', op: 'first', set: 'Player', pos: 4 },
      component: 'Shield',
      pos: 0,
    })
    expect(ok('has(self, Shield)')).toMatchObject({ kind: 'has', target: { kind: 'self', pos: 4 } })
  })

  it('count, exists, sum, avg, minOf, maxOf', () => {
    expect(ok('count(Enemy)')).toEqual({ kind: 'aggregate', op: 'count', set: 'Enemy', pos: 0 })
    expect(ok('exists(Enemy)')).toEqual({ kind: 'aggregate', op: 'exists', set: 'Enemy', pos: 0 })
    for (const op of ['sum', 'avg', 'minOf', 'maxOf'] as const) {
      expect(ok(`${op}(Enemy, Health.hp)`)).toEqual({
        kind: 'aggregate',
        op,
        set: 'Enemy',
        component: 'Health',
        field: 'hp',
        pos: 0,
      })
    }
  })

  it('countWithin(S, r) and countWithin(S, r, e)', () => {
    expect(ok('countWithin(Enemy, 5)')).toEqual({
      kind: 'countWithin',
      set: 'Enemy',
      radius: { kind: 'number', value: 5, pos: 19 },
      pos: 0,
    })
    expect(ok('countWithin(Enemy, 5, first(Player))')).toEqual({
      kind: 'countWithin',
      set: 'Enemy',
      radius: { kind: 'number', value: 5, pos: 19 },
      centre: { kind: 'select', op: 'first', set: 'Player', pos: 22 },
      pos: 0,
    })
  })

  it('distanceTo(e)', () => {
    expect(ok('distanceTo(nearest(Enemy))')).toEqual({
      kind: 'distanceTo',
      target: { kind: 'select', op: 'nearest', set: 'Enemy', pos: 11 },
      pos: 0,
    })
  })

  it('new math functions with fixed arities', () => {
    expect(FUNCTION_NAMES).toEqual([
      'min', 'max', 'clamp', 'abs', 'sin', 'cos', 'floor', 'random',
      'sqrt', 'pow', 'atan2', 'hypot', 'sign', 'round', 'ceil', 'lerp', 'distance',
    ])
    expect(FUNCTION_ARITY).toMatchObject({
      sqrt: 1, sign: 1, round: 1, ceil: 1, pow: 2, atan2: 2, hypot: 2, lerp: 3, distance: 4,
    })
    expect(ok('lerp(0, 10, 0.5)')).toMatchObject({ kind: 'call', name: 'lerp', pos: 0 })
    expect(ok('distance(1, 2, 3, 4)')).toMatchObject({ kind: 'call', name: 'distance', args: [{}, {}, {}, {}] })
  })

  it('SPECIAL_FORMS describes every special form', () => {
    expect(Object.keys(SPECIAL_FORMS).sort()).toEqual(
      ['avg', 'count', 'countWithin', 'distanceTo', 'entity', 'exists', 'first', 'has', 'maxOf', 'minOf', 'nearest', 'sum',
        // 2.2 §5.4 input reads
        'key', 'pressed', 'released', 'mod'].sort(),
    )
    expect(SPECIAL_FORMS.key).toEqual({ args: ['expr'], optional: 0 })
    expect(SPECIAL_FORMS.countWithin).toEqual({ args: ['set', 'expr', 'entity'], optional: 1 })
    expect(SPECIAL_FORMS.sum).toEqual({ args: ['set', 'memberField'], optional: 0 })
    expect(SPECIAL_FORMS.has).toEqual({ args: ['entity', 'set'], optional: 1 })
  })

  it('the package entry exports the new AST helpers', () => {
    expect(typeof rules.walkComponentRefs).toBe('function')
    expect(rules.SPECIAL_FORMS).toBe(SPECIAL_FORMS)
  })
})

describe('E10.2 grammar: names that are not selectors', () => {
  it('first.x, nearest.x, entity.x, count.x, has.x stay Component.field', () => {
    for (const name of ['first', 'nearest', 'entity', 'count', 'has', 'sum', 'distanceTo']) {
      expect(ok(`${name}.x`)).toEqual({ kind: 'field', component: name, field: 'x', pos: 0 })
    }
  })

  it('a set named like a selector keyword is just a name', () => {
    expect(ok('count(entity)')).toEqual({ kind: 'aggregate', op: 'count', set: 'entity', pos: 0 })
    expect(ok('has(first)')).toMatchObject({ kind: 'has', component: 'first', target: { kind: 'self' } })
  })
})

describe('E10.2 grammar: errors', () => {
  it('arity errors for functions and special forms, at the name', () => {
    expect(err1('sqrt(1, 2)')).toEqual({ position: 0, message: 'Function "sqrt" expects 1 argument, got 2' })
    expect(err1('1 + pow(2)')).toEqual({ position: 4, message: 'Function "pow" expects 2 arguments, got 1' })
    expect(err1('lerp(1, 2)').position).toBe(0)
    expect(err1('distance(1, 2, 3)').position).toBe(0)
    expect(err1('count()').position).toBe(6)
    expect(err1('count(A, B)').position).toBe(7)
    expect(err1('sum(A)').position).toBe(5)
    expect(err1('sum(A, 1)').position).toBe(7)
    expect(err1('distanceTo()').position).toBe(11)
    expect(err1('nearest(A, 1, 2).id').position).toBe(12)
    expect(err1('first().id').position).toBe(6)
    expect(err1('entity().id').position).toBe(7)
    expect(err1('countWithin(A)').position).toBe(13)
    expect(err1('has()').position).toBe(4)
  })

  it('an entity used as a value says "use .id"', () => {
    for (const [src, pos] of [['first(Player)', 0], ['1 + self', 4], ['nearest(E) == 3', 0], ['entity(3)', 0]] as const) {
      const e = err1(src)
      expect(e.position).toBe(pos)
      expect(e.message).toMatch(/use \.id/)
    }
    expect(err1('distanceTo(Player)').message).toMatch(/entity/)
    expect(err1('self.Pos')).toMatchObject({ position: 0, message: expect.stringMatching(/reserved word.*self\.Component\.field/) })
    expect(err1('first(P).Pos').position).toBe(12)
  })

  it('reserved words: self, tick, other, event, pointer', () => {
    for (const word of ['self', 'tick', 'other', 'event', 'pointer']) {
      const e = err1(`1 + ${word}.hp`)
      expect(e.position, word).toBe(4)
      expect(e.message, word).toMatch(/reserved word/)
    }
    expect(err1('count(tick)')).toMatchObject({ position: 6, message: expect.stringMatching(/reserved word/) })
    expect(err1('has(self, event)')).toMatchObject({ position: 10, message: expect.stringMatching(/reserved word/) })
    expect(err1('sum(E, other.x)')).toMatchObject({ position: 7, message: expect.stringMatching(/reserved word/) })
    expect(err1('first(P).pointer.x')).toMatchObject({ position: 9, message: expect.stringMatching(/reserved word/) })
    expect(err1('other')).toMatchObject({ position: 0, message: expect.stringMatching(/reserved word/) })
  })

  it('id is reserved after an entity', () => {
    expect(err1('first(P).id.x')).toMatchObject({ position: 9, message: expect.stringMatching(/reserved/) })
    // Not after a plain component name.
    expect(ok('id.x')).toEqual({ kind: 'field', component: 'id', field: 'x', pos: 0 })
  })
})

describe('E10.2 grammar: ?? precedence', () => {
  it('binds looser than || and tighter than ?:', () => {
    expect(ok('A.a ?? B.b || C.c')).toMatchObject({
      kind: 'nullish',
      left: { kind: 'field', component: 'A' },
      right: { kind: 'logical', op: '||' },
      pos: 4,
    })
    expect(ok('A.a ? B.b : C.c ?? 1')).toMatchObject({
      kind: 'ternary',
      else: { kind: 'nullish', left: { kind: 'field', component: 'C' }, right: { kind: 'number', value: 1 } },
    })
    expect(ok('A.a ?? 0 ? 1 : 2')).toMatchObject({ kind: 'ternary', cond: { kind: 'nullish' } })
  })

  it('is left-associative', () => {
    expect(ok('A.a ?? B.b ?? 3')).toMatchObject({
      kind: 'nullish',
      left: { kind: 'nullish', left: { component: 'A' }, right: { component: 'B' }, pos: 4 },
      right: { kind: 'number', value: 3 },
      pos: 11,
    })
  })

  it('a single ? is still the ternary', () => {
    expect(ok('1 ? 2 : 3')).toMatchObject({ kind: 'ternary' })
  })
})

describe('E10.2 grammar: O-66 limits hold for the new nodes', () => {
  it('nesting through entity(...) selectors is bounded', () => {
    let src = '1'
    for (let i = 0; i < MAX_EXPRESSION_DEPTH; i++) src = `entity(${src}).id`
    const e = err1(src)
    expect(e.message).toMatch(/nests deeper/)
  })

  it('a long ?? chain is bounded like other operator chains', () => {
    const src = Array.from({ length: MAX_EXPRESSION_DEPTH + 5 }, () => 'A.a').join(' ?? ')
    expect(err1(src).message).toMatch(/nests deeper/)
  })

  it('a moderately nested cross-entity expression still parses', () => {
    let src = '1'
    for (let i = 0; i < 20; i++) src = `entity(${src}).id`
    expect(ok(src).kind).toBe('entityId')
  })
})

describe('E10.2 walkers', () => {
  const src =
    'Pos.x + self.Pos.y + first(Player).Pos.x + sum(Enemy, Health.hp) + count(Tag) ' +
    '+ (has(first(Ally), Shield) ? 1 : 0) + countWithin(Foe, Range.r, entity(Target.id)) ' +
    '+ (nearest(Coin, Sight.d).Value.v ?? 0)'

  it('walkComponentRefs visits members, sets and has targets in source order', () => {
    const seen: Array<[string, string | null, number, string]> = []
    walkComponentRefs(ok(src), (c, f, pos, role) => seen.push([c, f, pos, role]))
    expect(seen).toEqual([
      ['Pos', 'x', 0, 'self'],
      ['Pos', 'y', 8, 'self'],
      ['Player', null, 21, 'set'],
      ['Pos', 'x', 21, 'member'],
      ['Enemy', null, 43, 'set'],
      ['Health', 'hp', 43, 'member'],
      ['Tag', null, 67, 'set'],
      ['Ally', null, 85, 'set'],
      ['Shield', null, 81, 'set'],
      ['Foe', null, 117, 'set'],
      ['Range', 'r', 134, 'self'],
      ['Target', 'id', 150, 'self'],
      ['Coin', null, 165, 'set'],
      ['Sight', 'd', 179, 'self'],
      ['Value', 'v', 165, 'member'],
    ])
    for (const [c, , pos, role] of seen) {
      if (role === 'self' && !src.startsWith('self', pos)) expect(src.startsWith(c, pos)).toBe(true)
    }
  })

  it('walkFieldRefs still visits only the evaluated entity\'s own fields', () => {
    const seen: Array<[string, string, number]> = []
    walkFieldRefs(ok(src), (c, f, pos) => seen.push([c, f, pos]))
    expect(seen).toEqual([
      ['Pos', 'x', 0],
      ['Pos', 'y', 8],
      ['Range', 'r', 134],
      ['Target', 'id', 150],
      ['Sight', 'd', 179],
    ])
  })

  // Studio finding (2026-10-19): the package entry exported walkComponentRefs
  // but not walkFieldRefs, so studio mirrored the self-field walk itself.
  it('the package entry exports walkFieldRefs, the same function as ast.ts', () => {
    expect(rules.walkFieldRefs).toBe(walkFieldRefs)
    const seen: Array<[string, string, number]> = []
    rules.walkFieldRefs(ok('first(P).Pos.x + Pos.y'), (c, f, pos) => seen.push([c, f, pos]))
    expect(seen).toEqual([['Pos', 'y', 17]])
  })
})
