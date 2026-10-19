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
`Math.random`; see "Randomness" below for per-rule streams).

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
| Unknown component in `without[i]` (2.2) | `{ without: i }` |
| `when` parse, resolve or type error (and, 2.2, a spatial form without the `spatial` option) | `'when'` |
| Malformed `actions[i].set`, unknown target component, forbidden field | `{ action: i, part: 'set' }` |
| Any error inside `actions[i].expr` | `{ action: i, part: 'expr' }` |
| Repeated rule name (from `update()`) | `'name'` |

The union widens in minors (`'rng'` in 2.1, `{ without: i }` in 2.2), so
keep a default branch when you switch on it:

```ts
function widgetFor(e: RuleError): string {
  const f = e.field
  if (typeof f === 'string') return f
  if (f && 'query' in f) return `query[${f.query}]`
  if (f && 'without' in f) return `without[${f.without}]`
  if (f && 'action' in f) return `actions[${f.action}].${f.part}`
  return 'rule' // a part this version does not know yet
}
```

Rules run as systems named `rule:<name>`. `RuleDef.priority` (default 0)
places them among other systems; rules of equal priority run in the order of
the `defs` array last passed to `update()` (see "Ordering" below). A def with an unknown `schedule`
a non-finite `priority` or an unknown `rng` is a compile error, and a def repeating an earlier
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

## Language

The grammar, lowest precedence first (2.2 additions marked; SPEC Appendix A
is the normative reference):

```
expr       := nullish ( '?' expr ':' expr )?
nullish    := or ( '??' or )*                       2.2: b when a has no value
or / and / equality / relational / additive / multiplicative / unary  (as before)
primary    := number | string | true | false | dt | time | tick (2.2)
            | Component.field                       the evaluated entity's field
            | entity '.' Component '.' field        2.2: another entity's field
            | entity '.' 'id'                       2.2: its id (a number)
            | pointer.x | pointer.y | pointer.buttons | pointer.wheel   2.2: input
            | call | '(' expr ')'
entity     := self | first(S) | nearest(S[, maxDistance]) | entity(n)      2.2
call       := min max clamp abs sin cos floor random
            | sqrt pow atan2 hypot sign round ceil lerp distance           2.2
            | has([e,] C) | count(S) | exists(S) | countWithin(S, r[, e])  2.2
            | sum|avg|minOf|maxOf(S, C.f) | distanceTo(e)                   2.2
            | key(n) | pressed(n) | released(n) | mod(n)                    2.2: input
```

`S` is a component name standing for its holders (a set); use a tag
component for "enemies". Number literals are plain decimals (no exponent).

**Reserved words (2.2).** `self`, `tick`, `other`, `event` and `pointer`
cannot name a component in an expression (a "reserved word" parse error at
the name), and `id` cannot after an entity. Only `first(`, `nearest(` and
`entity(` start a selector, so `first.x` is still `Component.field`. An
entity is not a value: `first(Player)` alone is a parse error ("use .id").
`key`, `pressed`, `released` and `mod` are not reserved: only a call
(`key(`) reads input.

## Cross-entity reads (2.2)

```ts
const chase: RuleDef = {
  name: 'chase', schedule: 'fixed', query: ['Pos', 'Vel'], without: ['Player'],
  actions: [
    { set: 'Vel.x', expr: '(first(Player).Pos.x - Pos.x) * 0.1' },
    { set: 'Vel.y', expr: '(nearest(Coin, 50).Pos.y - Pos.y) * 0.1 ?? 0' },
  ],
}
installRules(world, [chase], resolve, { spatial: { component: 'Pos' } })
```

- **Selectors.** `first(S)` is the lowest-id member other than the evaluated
  entity; `nearest(S[, d])` minimizes squared distance from its position
  (ties → lowest id; itself excluded; within `d` if given); `entity(n)` is
  the alive entity with integer id `n`. `self` is the evaluated entity.
- **Reads.** `e.C.f` reads an own property (missing component or field: no
  value); `e.id` is the id; `self.C.f` is `C.f`. `has([e,] C)` is a boolean.
- **Aggregates** include the evaluated entity: `count(S)`, `exists(S)`,
  `sum/avg/minOf/maxOf(S, C.f)` (members without the field are skipped; a
  non-number value faults the entity; `sum` of nothing is 0, `avg`/`minOf`/
  `maxOf` of nothing have no value). `countWithin(S, r[, e])` counts members
  within `r` of `e` (default the evaluated entity), excluding `e`.
- **Distance.** `distanceTo(e)` is `sqrt(dx² + dy²)` between the two
  positions; `distance(x1, y1, x2, y2)` the same over four numbers.
- **Positions** come from `InstallRulesOptions.spatial` (`{ component, x?,
  y?, cellSize? }`, fields default `x`/`y`, cell size 32 — performance
  only). `nearest`, `countWithin` and `distanceTo` without it are compile
  errors on the part that uses them. Selection uses a grid built from the
  positions at the start of each rule run; `distanceTo` reads live
  positions. An entity whose position fields are missing or not finite
  numbers has no position.
- **No value and `??`.** A missing field, an empty selector, a dead
  `entity(n)`, an empty `avg`/`minOf`/`maxOf` or a missing position is "no
  value". `a ?? b` evaluates `b` on no value only; type errors propagate.
  Uncaught, no value is the usual `rule_eval_failed` fault on the entity.
- **Read timing.** Reads are live. Entities run in ascending id and each
  commits before the next, so entity *k* sees the writes lower ids made in
  the same run (Gauss–Seidel), as its own-field reads always did. Rules
  never write other entities.
- **`without`.** `RuleDef.without: ['Player']` excludes holders
  (`And(...Has(query), ...Not(Has(without)))`); an unknown name is a
  `RuleError` on `{ without: i }`.
- Every component name in an expression (reads, sets, `has` targets,
  aggregate fields) must resolve, and member fields get the
  `__proto__`/`constructor`/`prototype` check. `walkComponentRefs(ast,
  visit)` visits them all (role `'self'`, `'member'` or `'set'`), for tools
  that rename components; `walkFieldRefs` still visits only the evaluated
  entity's own fields.

**Cost model.** Member lists are computed once per rule run per set
(ascending id). A set aggregate whose field's component the rule does not
write (and every `count`/`exists`) is computed once per run and reused for
each entity; otherwise once per entity. Spatial sets build one grid per run
(O(n)); each `nearest`/`countWithin` is then a grid query. At 1000 entities
a `nearest(Player)` rule costs about 1.7× a self-only rule and a memoized
`sum(Enemy, Hp.hp)` about the same as a self-only rule (`bench/run.mjs
--workload rules`; targets 3× and 1.2×). Avoid unmemoized aggregates in
large rules: they are O(members) per entity.

## World expressions (2.2)

`compileWorldExpression(source, resolve, options?)` compiles an expression
with no evaluated entity: a metric, probe or outcome measured over a whole
world.

```ts
const near = compileWorldExpression('countWithin(Enemy, 40, first(Player))', resolve, {
  spatial: { component: 'Pos' },
})
if (near.expression) {
  const r = near.expression.evaluate(world) // Result<number | string | boolean, RuleFault>
  if (r.ok) console.log(r.value)
}
```

- **Same grammar, minus the entity.** Bare `Component.field`, `self`,
  `has(C)` without an entity, `countWithin(S, r)` without a centre,
  `distanceTo(e)` and `nearest(S)` (both measure from the evaluated entity),
  `dt`, `random()`, and the input reads (`key`, `pressed`, `released`,
  `mod`, `pointer.*`) are compile errors at their position. Read through
  `first(S)` or `entity(n)` instead: `first(Player).Hp.hp`,
  `has(first(Player), Shield)`, `countWithin(Enemy, 40, first(Player))`.
- **`random()` is rejected** because drawing would advance the world's RNG:
  measuring a world must never change its future.
- **Values.** `time` is `world.time.elapsed`, `tick` is `world.time.tick`.
  Aggregates, selectors, math and `??` mean what they mean in a rule.
  `countWithin` needs the `spatial` option, as in `installRules`, and
  excludes its centre.
- **Read-only.** `evaluate(world)` reads with `listEntities` and
  `getComponent` (no change windows, no RNG), builds member lists and grids
  per call, and never registers a component type no entity holds;
  `hashSnapshot(world.snapshot({}), { includeChanges: true })` and
  `describe().componentCounts` are unchanged by any number of calls. A
  snapshot restored into a fresh world (types not yet registered) measures
  the same as its source. Compile once, evaluate against any world; the
  expression keeps no reference to a world after `evaluate` returns.
- **Errors are data.** Compile errors are `RuleError`s with `rule: '<expr>'`
  and a `position` in `source`, in source order. A no-value read without
  `??`, a type error, a non-finite number (`1 / 0`, `0 / 0`: guard with
  `count(S) > 0 ? … : 0`) or other non-primitive result, or a world holding a
  different component type under a referenced name is
  `err({ kind: 'rule_eval_failed', rule: '<expr>', message })`. Neither
  call throws for bad input.

## Input (2.2)

Rules read the world's input (`world.input`, the `InputSnapshot` that
`setInput` or the `@domecs/input` plugin installed for the tick), so a
player can be controlled by data alone:

```ts
const steer: RuleDef = {
  name: 'steer', schedule: 'tick', query: ['Player', 'Vel'],
  actions: [
    { set: 'Vel.x', expr: '(key("ArrowRight") ? 1 : 0) - (key("ArrowLeft") ? 1 : 0)' },
    { set: 'Player.jumps', expr: 'Player.jumps + (pressed("Space") ? 1 : 0)' },
  ],
}
```

- **Held state.** `key(n)` is `input.keys.has(n)`; `mod(n)` reads
  `input.mods` for `n` one of `'ctrl'`, `'alt'`, `'shift'`, `'meta'`.
- **Edges.** `pressed(n)` / `released(n)` read `input.keyDelta`: true for
  the one render tick in which the key went down / up.
- **Pointer.** `pointer.x`, `pointer.y`, `pointer.buttons` (DOM bitmask)
  and `pointer.wheel` (accumulated this tick) are numbers. `pointer` is a
  reserved word; any other field is a parse error.
- **Names.** Key names are what `InputSnapshot.keys` carries: the
  `KeyboardEvent.code` values the `@domecs/input` plugin records
  (`'KeyW'`, `'ArrowUp'`, `'Space'`; see its README). The argument is any
  expression producing a string, so bindings can live in a component:
  `key(Bind.up)`. A non-string argument, or a `mod` name other than the
  four, is a type error (a compile error when certain, else a
  `rule_eval_failed` fault on the entity).
- **Fixed rules.** `pressed`, `released` and `pointer.wheel` in a `fixed`
  rule are compile errors on the part that uses them: edges and the wheel
  last one render tick, so a fixed step (zero, one or several per frame)
  can miss them or see them twice (AGENTS.md rule 4). Held reads, `mod` and
  the pointer position are fine there.
- **Not in world expressions.** A metric must not depend on input: every
  input form is a compile error in `compileWorldExpression`.
- **Determinism.** Input is whatever was installed before the step. A host
  that records the input it applies (with `setInput` before each step)
  reproduces the run, on a fork restored from a snapshot too. A headless
  world without an input plugin reads an empty snapshot: no key held,
  pointer at 0. An installed snapshot stays until the next `setInput`
  (the `@domecs/input` plugin installs one every tick): headless, a
  `pressed("Space")` edge reads true on every step until you replace it.
  Input is not in the snapshot and `restore` does not clear it, so install
  input before every step after a restore (or `bridge.reset()`). A
  malformed snapshot (an array where a `Set` belongs, a missing part) is a
  `rule_eval_failed` fault on the entity, not a throw from the step.

## Timing and functions

`dt` for a `fixed` rule is the fixed step, but `time` is the frame's elapsed
time, the same in every fixed sub-step of a frame. `tick` (2.2) is
`world.time.tick`.

Every function is bit-reproducible: a rule computes the same bits in Node,
Electron and every browser. `sin`/`cos` evaluate with `dmath` from
`@domecs/core` (a musl libm port, < 1 ulp; since 2.1 — 2.0 used
`Math.sin`/`Math.cos`, which differ by up to 1 ulp between engines, so 2.1
results can differ from 2.0 by that much once), and from 2.2 so do `atan2`,
`hypot` and `pow` (`pow`'s special values are ECMAScript `**`'s). `min`,
`max`, `clamp`, `abs`, `floor`, `sqrt`, `sign`, `round`, `ceil`, `lerp(a, b,
t)` (`a + (b - a) * t`) and `distance` are exact, and `random()` draws from
the world's seeded RNG (SPEC §8). Arities are fixed: one argument for `sqrt
sign round ceil`, two for `pow atan2 hypot`, three for `lerp`, four for
`distance`.

`FUNCTION_NAMES` is a const tuple, so each minor that adds a function widens
`FunctionName` (2.2 added nine). Give exhaustive switches over it a default
branch:

```ts
function label(name: FunctionName): string {
  switch (name) {
    case 'min': return 'smaller of'
    case 'max': return 'larger of'
    // …
    default: return name // a function this version does not know yet
  }
}
```

## Randomness

By default every rule's `random()` draws the world's one shared stream, so
adding, removing or editing a random-drawing rule changes what every other
rule draws (an A/B comparison of one rule reshuffles all the others). Since
2.1, a rule can draw its own stream (SPEC §2.8):

```ts
installRules(world, defs, resolve, { rng: 'own' })          // every rule
const def: RuleDef = { name: 'jitter', rng: 'shared', ... }  // per-rule override
```

- `InstallRulesOptions.rng` (`'shared'` default | `'own'`) sets the mode of
  every rule; `RuleDef.rng` overrides it for one rule. An unknown
  `RuleDef.rng` is a `RuleError` on `field: 'rng'`; an unknown install
  option throws.
- An own stream is keyed `rule:<name>` and derived from the world's root
  seed (`deriveStream`), so it does not depend on when the rule was
  installed. `update()` removes and re-registers every rule; the stream
  survives that (it is kept by key), so a live world and a fresh fork stay
  equal. Renaming a rule starts a new stream.
- The streams travel in the snapshot (`rngStreams`, v3). A world restoring a
  snapshot that lacks a rule's stream (an A/B arm that adds the rule)
  derives it from the snapshot's `rngRoot`. Reseed with
  `{ ...snap, seed: s, rngRoot: s, rngStreams: undefined }`.
- A rule's own draws still depend on how many entities it visits (one stream
  per rule, not per entity). `world.describe().systems[i].rng` reports the
  mode.

Expressions are compiled once to closures, and a rule skips write staging
when no action reads a field an earlier action wrote. A simple rule over 5k
entities costs about 2.5× a hand-written system.
