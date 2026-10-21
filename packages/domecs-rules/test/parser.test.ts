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
      componentPos: 5,
    })
    expect(ok(' self.id')).toEqual({ kind: 'entityId', target: { kind: 'self', pos: 1 }, pos: 1 })
  })

  it('first(S).C.f, nearest(S).C.f, nearest(S, d).id, entity(n).C.f', () => {
    expect(ok('first(Player).Pos.x')).toEqual({
      kind: 'member',
      target: { kind: 'select', op: 'first', set: 'Player', pos: 0, setPos: 6 },
      component: 'Pos',
      field: 'x',
      pos: 0,
      componentPos: 14,
    })
    expect(ok('2 * nearest(Enemy).Health.hp')).toMatchObject({
      right: {
        kind: 'member',
        target: { kind: 'select', op: 'nearest', set: 'Enemy', pos: 4, setPos: 12 },
        component: 'Health',
        field: 'hp',
        pos: 4,
        componentPos: 19,
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
        setPos: 8,
      },
      pos: 0,
    })
    expect(ok('entity(Target.id).Pos.y')).toEqual({
      kind: 'member',
      target: { kind: 'entityById', id: { kind: 'field', component: 'Target', field: 'id', pos: 7 }, pos: 0 },
      component: 'Pos',
      field: 'y',
      pos: 0,
      componentPos: 18,
    })
  })

  it('has(C) and has(e, C)', () => {
    expect(ok('has(Shield)')).toEqual({
      kind: 'has',
      target: { kind: 'self', pos: 0 },
      component: 'Shield',
      pos: 0,
      componentPos: 4,
    })
    expect(ok('has(first(Player), Shield)')).toEqual({
      kind: 'has',
      target: { kind: 'select', op: 'first', set: 'Player', pos: 4, setPos: 10 },
      component: 'Shield',
      pos: 0,
      componentPos: 19,
    })
    expect(ok('has(self, Shield)')).toMatchObject({ kind: 'has', target: { kind: 'self', pos: 4 } })
  })

  it('count, exists, sum, avg, minOf, maxOf', () => {
    expect(ok('count(Enemy)')).toEqual({ kind: 'aggregate', op: 'count', set: 'Enemy', pos: 0, setPos: 6 })
    expect(ok('exists(Enemy)')).toEqual({ kind: 'aggregate', op: 'exists', set: 'Enemy', pos: 0, setPos: 7 })
    for (const op of ['sum', 'avg', 'minOf', 'maxOf'] as const) {
      expect(ok(`${op}(Enemy, Health.hp)`)).toEqual({
        kind: 'aggregate',
        op,
        set: 'Enemy',
        component: 'Health',
        field: 'hp',
        pos: 0,
        setPos: op.length + 1,
        componentPos: op.length + 8,
      })
    }
  })

  it('countWithin(S, r) and countWithin(S, r, e)', () => {
    expect(ok('countWithin(Enemy, 5)')).toEqual({
      kind: 'countWithin',
      set: 'Enemy',
      radius: { kind: 'number', value: 5, pos: 19 },
      pos: 0,
      setPos: 12,
    })
    expect(ok('countWithin(Enemy, 5, first(Player))')).toEqual({
      kind: 'countWithin',
      set: 'Enemy',
      radius: { kind: 'number', value: 5, pos: 19 },
      centre: { kind: 'select', op: 'first', set: 'Player', pos: 22, setPos: 28 },
      pos: 0,
      setPos: 12,
    })
  })

  it('distanceTo(e)', () => {
    expect(ok('distanceTo(nearest(Enemy))')).toEqual({
      kind: 'distanceTo',
      target: { kind: 'select', op: 'nearest', set: 'Enemy', pos: 11, setPos: 19 },
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
    expect(ok('count(entity)')).toEqual({ kind: 'aggregate', op: 'count', set: 'entity', pos: 0, setPos: 6 })
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
    // 2.3 (§6.1): `event.f` is a payload read, so `event.hp` parses; the
    // others still reject `word.hp`.
    for (const word of ['self', 'tick', 'other', 'pointer']) {
      const e = err1(`1 + ${word}.hp`)
      expect(e.position, word).toBe(4)
      expect(e.message, word).toMatch(/reserved word/)
    }
    expect(err1('count(tick)')).toMatchObject({ position: 6, message: expect.stringMatching(/reserved word/) })
    expect(err1('has(self, event)')).toMatchObject({ position: 10, message: expect.stringMatching(/reserved word/) })
    expect(err1('sum(E, other.x)')).toMatchObject({ position: 7, message: expect.stringMatching(/reserved word/) })
    expect(err1('sum(E, event.x)')).toMatchObject({ position: 7, message: expect.stringMatching(/reserved word/) })
    expect(err1('first(P).pointer.x')).toMatchObject({ position: 9, message: expect.stringMatching(/reserved word/) })
    expect(err1('first(P).event.x')).toMatchObject({ position: 9, message: expect.stringMatching(/reserved word/) })
    expect(err1('other')).toMatchObject({ position: 0, message: expect.stringMatching(/use \.id/) })
    expect(err1('event')).toMatchObject({ position: 0, message: expect.stringMatching(/reserved word.*event\.field/) })
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

  // E-fix2 verify: the positions are AST node positions, not always the
  // component token. A renaming tool that splices at `pos` must find the
  // name token from there; the docs say so.
  it('walker positions are node positions: `self` for self.C.f, the entity or form start otherwise', () => {
    const src = 'self.Pos.x + Pos.y + first(P).Pos.x + sum(S, Hp.hp) + has(first(P), Q)'
    const own: Array<[string, string, number]> = []
    walkFieldRefs(ok(src), (c, f, pos) => own.push([c, f, pos]))
    expect(own).toEqual([['Pos', 'x', 0], ['Pos', 'y', 13]])
    expect(src.startsWith('self.Pos', 0)).toBe(true)
    expect(src.startsWith('Pos.y', 13)).toBe(true)
    const all: Array<[string, string | null, number, string]> = []
    walkComponentRefs(ok(src), (c, f, pos, role) => all.push([c, f, pos, role]))
    const at = (pos: number): string => src.slice(pos).match(/^[A-Za-z_]+/)![0]
    expect(all.map(([c, f, pos, role]) => `${role}:${c}${f ? '.' + f : ''}@${at(pos)}`)).toEqual([
      'self:Pos.x@self',
      'self:Pos.y@Pos',
      'set:P@first',
      'member:Pos.x@first',
      'set:S@sum',
      'member:Hp.hp@sum',
      'set:P@first',
      'set:Q@has',
    ])
  })
})

describe('E14.1 grammar: event.f and other (§6.1)', () => {
  it('event.f is a payload read', () => {
    expect(ok('event.dx')).toEqual({ kind: 'event', field: 'dx', pos: 0 })
    expect(ok('Pos.x + event.dx')).toMatchObject({ kind: 'binary', right: { kind: 'event', field: 'dx', pos: 8 } })
    expect(ok('event.target ?? -1')).toMatchObject({ kind: 'nullish', left: { kind: 'event', field: 'target' } })
  })

  it('other is an entity: other.C.f, other.id, has(other, C), distanceTo(other), countWithin centre', () => {
    expect(ok('other.Hp.hp')).toEqual({
      kind: 'member',
      target: { kind: 'other', pos: 0 },
      component: 'Hp',
      field: 'hp',
      pos: 0,
      componentPos: 6,
    })
    expect(ok('other.id')).toEqual({ kind: 'entityId', target: { kind: 'other', pos: 0 }, pos: 0 })
    expect(ok('has(other, Hp)')).toMatchObject({ kind: 'has', target: { kind: 'other', pos: 4 }, component: 'Hp' })
    expect(ok('distanceTo(other)')).toMatchObject({ kind: 'distanceTo', target: { kind: 'other', pos: 11 } })
    expect(ok('countWithin(E, 3, other)')).toMatchObject({ kind: 'countWithin', centre: { kind: 'other', pos: 18 } })
  })

  it('errors keep their positions', () => {
    expect(err1('1 + event')).toMatchObject({ position: 4, message: expect.stringMatching(/event\.field/) })
    expect(err1('event.')).toMatchObject({ position: 6 })
    expect(err1('event.a.b')).toMatchObject({ position: 7 })
    expect(err1('other.hp')).toMatchObject({ position: 0, message: expect.stringMatching(/other\.Component\.field/) })
    expect(err1('other.Hp.id.x')).toMatchObject({ position: 11 })
  })

  it('walkers: event.f visits nothing; other.C.f is a member read', () => {
    const src = 'event.dx + other.Hp.hp + Pos.x'
    const all: Array<[string, string | null, number, string]> = []
    walkComponentRefs(ok(src), (c, f, pos, role) => all.push([c, f, pos, role]))
    expect(all).toEqual([
      ['Hp', 'hp', 11, 'member'],
      ['Pos', 'x', 25, 'self'],
    ])
    const own: Array<[string, string, number]> = []
    walkFieldRefs(ok(src), (c, f, pos) => own.push([c, f, pos]))
    expect(own).toEqual([['Pos', 'x', 25]])
  })
})

// Orchestrator decision (f), 2026-10-19: the walkers gain an additive name
// position (the visit callback's last argument) for the component token on
// every form, so a renaming tool (studio) splices exactly. `pos` is
// unchanged (the node position).
describe('walker name positions (decision f)', () => {
  type Visit = string
  const visits = (src: string): Visit[] => {
    const out: Visit[] = []
    walkComponentRefs(ok(src), (c, f, _pos, role, namePos) => out.push(`${role}:${c}${f ? '.' + f : ''}@${namePos}`))
    return out
  }
  const spelledAtNamePos = (src: string): void => {
    let n = 0
    walkComponentRefs(ok(src), (c, _f, _pos, _role, namePos) => {
      n++
      expect(src.slice(namePos, namePos + c.length)).toBe(c)
      expect(/[A-Za-z0-9_]/.test(src[namePos + c.length] ?? '')).toBe(false)
      expect(/[A-Za-z0-9_]/.test(src[namePos - 1] ?? '')).toBe(false)
    })
    expect(n).toBeGreaterThan(0)
  }

  it('C.f: the component token (same as pos)', () => {
    expect(visits('1 + Pos.x')).toEqual(['self:Pos.x@4'])
  })

  it('self.C.f and other.C.f: the token after the dot', () => {
    expect(visits('self.Pos.x')).toEqual(['self:Pos.x@5'])
    expect(visits('other.Hp.hp')).toEqual(['member:Hp.hp@6'])
  })

  it('first(S).C.f, nearest(S[, d]).C.f, entity(n).C.f: the set and the component tokens', () => {
    expect(visits('first(P).Pos.x')).toEqual(['set:P@6', 'member:Pos.x@9'])
    expect(visits('nearest(Coin).Pos.y')).toEqual(['set:Coin@8', 'member:Pos.y@14'])
    expect(visits('nearest(Coin, Sight.d).Pos.y')).toEqual(['set:Coin@8', 'self:Sight.d@14', 'member:Pos.y@23'])
    expect(visits('entity(Target.id).Hp.hp')).toEqual(['self:Target.id@7', 'member:Hp.hp@18'])
  })

  it('e.id and distanceTo(e): the selector set', () => {
    expect(visits('first(P).id')).toEqual(['set:P@6'])
    expect(visits('distanceTo(nearest(Foe))')).toEqual(['set:Foe@19'])
  })

  it('has(C), has(self, C), has(other, C), has(e, C): the target component', () => {
    expect(visits('has(Shield)')).toEqual(['set:Shield@4'])
    expect(visits('has(self, Shield)')).toEqual(['set:Shield@10'])
    expect(visits('has(other, Shield)')).toEqual(['set:Shield@11'])
    expect(visits('has(first(P), Shield)')).toEqual(['set:P@10', 'set:Shield@14'])
  })

  it('count(S), exists(S), countWithin(S, r[, e]): the set', () => {
    expect(visits('count(Foe)')).toEqual(['set:Foe@6'])
    expect(visits('exists(Foe)')).toEqual(['set:Foe@7'])
    expect(visits('countWithin(Foe, Range.r)')).toEqual(['set:Foe@12', 'self:Range.r@17'])
    expect(visits('countWithin(Foe, 3, first(P))')).toEqual(['set:Foe@12', 'set:P@26'])
  })

  it('sum|avg|minOf|maxOf(S, C.f): the set and the member component', () => {
    expect(visits('sum(Foe, Hp.hp)')).toEqual(['set:Foe@4', 'member:Hp.hp@9'])
    expect(visits('avg(Foe, Hp.hp)')).toEqual(['set:Foe@4', 'member:Hp.hp@9'])
    expect(visits('minOf(Foe, Hp.hp)')).toEqual(['set:Foe@6', 'member:Hp.hp@11'])
    expect(visits('maxOf(Foe, Hp.hp)')).toEqual(['set:Foe@6', 'member:Hp.hp@11'])
  })

  it('every visit of a mixed, oddly spaced expression names its token exactly', () => {
    const src =
      '  self . Pos . x + has( first(  P ) ,  Q ) + sum(  S ,  Hp . hp ) + other .  Hp . hp' +
      ' + countWithin(  Foe , Range . r ,  nearest( Coin ,  Sight . d ) ) + entity( Target . id ) . Pos . y' +
      ' + has(  Shield ) + count( Foe ) + distanceTo( first( P ) ) + Pos . x ?? maxOf( S , Pos . x )'
    spelledAtNamePos(src)
    expect(visits(src).length).toBe(18)
  })

  it('splicing a new name at every name position renames exactly', () => {
    const src = 'self.Pos.x + first(Pos).Pos.y + has(first(Pos), Pos) + sum(Pos, Pos.x) + countWithin(Pos, 1) + Pos.y'
    const at: number[] = []
    walkComponentRefs(ok(src), (c, _f, _pos, _role, namePos) => {
      if (c === 'Pos') at.push(namePos)
    })
    let out = src
    for (const p of [...at].sort((a, b) => b - a)) out = out.slice(0, p) + 'Place' + out.slice(p + 'Pos'.length)
    expect(out).toBe(
      'self.Place.x + first(Place).Place.y + has(first(Place), Place) + sum(Place, Place.x) + countWithin(Place, 1) + Place.y',
    )
    const names: string[] = []
    walkComponentRefs(ok(out), (c) => names.push(c))
    expect(names.every((c) => c === 'Place')).toBe(true)
    expect(names.length).toBe(at.length)
  })

  it('walkFieldRefs passes the name position too (self.C.f: after `self.`)', () => {
    const src = 'self.Pos.x + Pos.y + first(P).Pos.x'
    const own: Array<[string, string, number, number]> = []
    walkFieldRefs(ok(src), (c, f, pos, namePos) => own.push([c, f, pos, namePos]))
    expect(own).toEqual([
      ['Pos', 'x', 0, 5],
      ['Pos', 'y', 13, 13],
    ])
    expect(rules.walkFieldRefs).toBe(walkFieldRefs)
    expect(rules.walkComponentRefs).toBe(walkComponentRefs)
  })

  it('the parser records the name positions on the AST nodes', () => {
    expect(ok('self.Pos.x')).toMatchObject({ kind: 'member', pos: 0, componentPos: 5 })
    expect(ok('first(P).id')).toMatchObject({ target: { kind: 'select', pos: 0, setPos: 6 } })
    expect(ok('has(first(P), Q)')).toMatchObject({ kind: 'has', pos: 0, componentPos: 14 })
    expect(ok('sum(S, Hp.hp)')).toMatchObject({ kind: 'aggregate', pos: 0, setPos: 4, componentPos: 7 })
    expect(ok('countWithin(S, 1)')).toMatchObject({ kind: 'countWithin', pos: 0, setPos: 12 })
  })

  it('a hand-built node without name positions falls back to pos', () => {
    const node: AstNode = {
      kind: 'aggregate',
      op: 'sum',
      set: 'S',
      component: 'Hp',
      field: 'hp',
      pos: 3,
    }
    const seen: number[] = []
    walkComponentRefs(node, (_c, _f, _pos, _role, namePos) => seen.push(namePos))
    expect(seen).toEqual([3, 3])
  })
})
