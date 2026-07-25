/**
 * Tokenizer for the rules expression grammar. Internal to the parser —
 * `tokenize` throws a {@link LexError} on the first invalid character or
 * unterminated string; `parser.ts` catches it and turns it into a
 * `ParseError` (parsing never throws past the public `parseExpression` API).
 */

export type TokenType = 'number' | 'string' | 'identifier' | 'punct' | 'eof'

export interface Token {
  type: TokenType
  value: string
  pos: number
}

export class LexError extends Error {
  constructor(
    message: string,
    public position: number,
  ) {
    super(message)
    this.name = 'LexError'
  }
}

const MULTI_CHAR_PUNCT = ['<=', '>=', '==', '!=', '&&', '||']
const SINGLE_CHAR_PUNCT = new Set(['+', '-', '*', '/', '%', '<', '>', '!', '?', ':', '(', ')', ',', '.'])

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_'
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch)
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = source.length

  while (i < n) {
    const ch = source[i]!

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }

    if (isDigit(ch)) {
      const start = i
      while (i < n && isDigit(source[i]!)) i++
      if (source[i] === '.' && isDigit(source[i + 1] ?? '')) {
        i++
        while (i < n && isDigit(source[i]!)) i++
      }
      tokens.push({ type: 'number', value: source.slice(start, i), pos: start })
      continue
    }

    if (ch === '"' || ch === "'") {
      const quote = ch
      const start = i
      i++
      let value = ''
      let closed = false
      while (i < n) {
        const c = source[i]!
        if (c === quote) {
          i++
          closed = true
          break
        }
        if (c === '\\' && i + 1 < n) {
          const next = source[i + 1]!
          const escapes: Record<string, string> = {
            n: '\n',
            t: '\t',
            r: '\r',
            '\\': '\\',
            '"': '"',
            "'": "'",
          }
          value += escapes[next] ?? next
          i += 2
          continue
        }
        value += c
        i++
      }
      if (!closed) {
        throw new LexError('Unterminated string literal', start)
      }
      tokens.push({ type: 'string', value, pos: start })
      continue
    }

    if (isIdentStart(ch)) {
      const start = i
      while (i < n && isIdentPart(source[i]!)) i++
      tokens.push({ type: 'identifier', value: source.slice(start, i), pos: start })
      continue
    }

    const two = source.slice(i, i + 2)
    if (MULTI_CHAR_PUNCT.includes(two)) {
      tokens.push({ type: 'punct', value: two, pos: i })
      i += 2
      continue
    }

    if (SINGLE_CHAR_PUNCT.has(ch)) {
      tokens.push({ type: 'punct', value: ch, pos: i })
      i++
      continue
    }

    throw new LexError(`Unexpected character "${ch}"`, i)
  }

  tokens.push({ type: 'eof', value: '', pos: n })
  return tokens
}
