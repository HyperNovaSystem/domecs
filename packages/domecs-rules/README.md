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

Rules run as systems named `rule:<name>`. `RuleDef.priority` (default 0)
places them among other systems; rules of equal priority run in the order of
the `defs` array last passed to `update()`. A def with an unknown `schedule`
or a non-finite `priority` is a compile error, and a def repeating an earlier
def's name is not installed and is reported under that name. Number literals
too large for a double and unknown string escapes (`\q`) are parse errors.

`dt` for a `fixed` rule is the fixed step, but `time` is the frame's elapsed
time, the same in every fixed sub-step of a frame. `sin`/`cos` use
`Math.sin`/`Math.cos`, which are not bit-identical across JS engines (SPEC
§8): avoid them in rules that must replay identically elsewhere.

Expressions are compiled once to closures, and a rule skips write staging
when no action reads a field an earlier action wrote. A simple rule over 5k
entities costs about 2.5× a hand-written system.
