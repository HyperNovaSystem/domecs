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
documented behavior around missing fields (skip-this-entity) and determinism
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

Runtime errors still skip the entity silently; reporting them as faults is
tracked as O-68 in `plan/FINDINGS.md`.
