# @domecs/rules

A small, safe, data-defined expression language and rule interpreter for
DOMECS (M6).

- `parseExpression` — a Pratt parser turning a tiny expression grammar into
  an `AstNode`. Never throws; syntax errors come back as `{ errors:
  ParseError[] }` with an accurate character `position`. Expressions longer
  than `MAX_EXPRESSION_LENGTH` (16384 characters) or nesting deeper than
  `MAX_EXPRESSION_DEPTH` (128 levels, counting long operator chains) are
  parse errors, so rule data cannot overflow the stack.
- `evaluate` — a pure, world-agnostic evaluator (`AstNode` + `EvalEnv` →
  `number | string | boolean`).
- `compileRule` / `installRules` — the world-facing layer that resolves a
  `RuleDef` (JSON-shaped: `query`, `when`, `actions`) against real
  `@domecs/core` component types and installs it as a `world.system(...)`.

See inline doc comments in `src/evaluator.ts` and `src/rules.ts` for the
documented behavior around missing fields (skip and fault the entity) and determinism
(`random()` is wired to the per-tick `ctx.rand.uniform()`, never
`Math.random`).

Writes are checked and atomic. For each entity, actions are evaluated in
order — a later action reads the value an earlier one set — against staged
writes, which are committed only when every action succeeded; if one fails, the entity is
skipped and nothing is written — including when an action's target component
is missing from the entity. A write must target an existing field of the same
kind (number, string or boolean; a field holding `null` or `undefined` takes
any of them), and numbers must be finite. Reads see
own fields only, and `__proto__`, `constructor` and `prototype` are rejected
as field names at compile time. A write that does not change the value does
not mark the component changed.

Errors are reported, not swallowed. Type errors that would fail on every
evaluation are compile errors: a string or boolean literal (or an operator
producing one) where arithmetic, a comparison or a function needs a number,
outside code that may not run (the right side of `&&`/`||`, ternary
branches). Field kinds are not checked at compile time — a component's
defaults do not fix them. At run time, a rule that cannot run on an entity —
a field it reads is missing, or a write is rejected — skips that entity and
attaches a fault to it: `Faulted` gets an entry with kind `rule_eval_failed`,
source `rule:<name>` and `detail: { rule, message }` (the `RuleFault` type).
Any other error is a bug and propagates out of the step.

Each `RuleError` (`{ rule, position, message, field }`) names the part of the
def it is about in `field` (a `RuleDefPath`), and `position` is an offset
within that part's string, or −1:

| Error | `field` |
|---|---|
| Unknown `schedule` | `'schedule'` |
| Non-finite `priority` | `'priority'` |
| Unknown component in `query[i]` | `{ query: i }` |
| `when` parse, resolve or type error | `'when'` |
| Malformed `actions[i].set`, unknown target component, forbidden field | `{ action: i, part: 'set' }` |
| Any error inside `actions[i].expr` | `{ action: i, part: 'expr' }` |
| Repeated rule name (from `update()`) | `'name'` |

The union widens in later minors (for example `'rng'` or `{ without: i }`),
so keep a default branch when you switch on it:

```ts
function widgetFor(e: RuleError): string {
  const f = e.field
  if (typeof f === 'string') return f
  if (f && 'query' in f) return `query[${f.query}]`
  if (f && 'action' in f) return `actions[${f.action}].${f.part}`
  return 'rule' // a part this version does not know yet
}
```

Rules run as systems named `rule:<name>`. `RuleDef.priority` (default 0)
places them among other systems; rules of equal priority run in the order of
the `defs` array last passed to `update()` (see "Ordering" below). A def with an unknown `schedule`
or a non-finite `priority` is a compile error, and a def repeating an earlier
def's name is not installed and is reported under that name. Number literals
too large for a double and unknown string escapes (`\q`) are parse errors.

## Ordering

Systems run by (priority, `order`, registration index), each ascending
(SPEC §3). `installRules(world, defs, resolve, options?)` picks how rules
fill the `order` slot:

- `{ order: 'registration' }` (the default, 2.0 behaviour): rules register
  with `order` 0 and tie-break by registration index. `update()` re-registers
  every rule, so after any `update()` — even a no-op one — the rules run
  after every equal-priority system registered before it, while a fresh world
  built from the same defs runs them first. A live world and a fresh build
  restored from its snapshot then diverge.
- `{ order: 'stable', orderBase? }`: rule *i* of the de-duplicated defs
  registers with `order: orderBase + i` (default base 1). Its position is a
  pure function of (priority, defs order): equal-priority systems left at
  `order` 0 run first, rules follow in defs order, and `update()` cannot move
  them. Reordering the defs reorders the runs; a rule added later sits at its
  defs index, not at the end. A def that fails to compile keeps its index, so
  fixing it does not shift the rules after it; a repeated name takes none.

```ts
const rules = installRules(world, defs, resolve, { order: 'stable' })
```

Use one stable handle per world, or give each its own `orderBase` range;
two handles with equal keys tie-break by registration index again. An
unknown `order` throws, as does an `orderBase` that is not finite or exceeds
±2^51 (beyond that `orderBase + i` is no longer exact and two rules could
share a key). Keep rule priorities in
the open band (−100, 100): commands and input at −100, derived transforms
such as `composeTransforms({ priority: 100 })` at 100 (bands table in SPEC
§3). `world.describe().systems` reports each rule system's `priority`,
`order`, `components` and `meta: { rule: name }` (maps the system back to its
rule). The default may flip to `'stable'` in 3.0.

## Timing and functions

`dt` for a `fixed` rule is the fixed step, but `time` is the frame's elapsed
time, the same in every fixed sub-step of a frame.

Every function is bit-reproducible: a rule computes the same bits in Node,
Electron and every browser. `sin`/`cos` evaluate with `dmath` from
`@domecs/core` (a musl libm port, < 1 ulp; since 2.1 — 2.0 used
`Math.sin`/`Math.cos`, which differ by up to 1 ulp between engines, so 2.1
results can differ from 2.0 by that much once). `min`, `max`, `clamp`, `abs`
and `floor` are exact, and `random()` draws from the world's seeded RNG
(SPEC §8).

Expressions are compiled once to closures, and a rule skips write staging
when no action reads a field an earlier action wrote. A simple rule over 5k
entities costs about 2.5× a hand-written system.
