// file: ast.d.ts
/**
 * AST for the rules expression grammar (see doc comment on
 * {@link import('./parser.js').parseExpression} for the exact grammar).
 *
 * Every node carries `pos`: the character offset (0-based, into the source
 * string that was parsed) of the token the node starts at. Used to report
 * accurate positions for component-resolution errors raised later by
 * `compileRule` against a successfully-parsed AST (see rules.ts).
 */
export declare const FUNCTION_NAMES: readonly ["min", "max", "clamp", "abs", "sin", "cos", "floor", "random"];
export type FunctionName = (typeof FUNCTION_NAMES)[number];
/** Expected argument count for each whitelisted function. */
export declare const FUNCTION_ARITY: Readonly<Record<FunctionName, number>>;
export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '<' | '<=' | '>' | '>=' | '==' | '!=';
export type LogicalOp = '&&' | '||';
export type UnaryOp = '!' | '-';
export type AstNode = {
    kind: 'number';
    value: number;
    pos: number;
} | {
    kind: 'string';
    value: string;
    pos: number;
} | {
    kind: 'boolean';
    value: boolean;
    pos: number;
}
/** Bare `dt` / `time` — NOT a component reference. */
 | {
    kind: 'identifier';
    name: 'dt' | 'time';
    pos: number;
}
/** Dotted `Component.field` reference. */
 | {
    kind: 'field';
    component: string;
    field: string;
    pos: number;
} | {
    kind: 'unary';
    op: UnaryOp;
    operand: AstNode;
    pos: number;
} | {
    kind: 'binary';
    op: BinaryOp;
    left: AstNode;
    right: AstNode;
    pos: number;
} | {
    kind: 'logical';
    op: LogicalOp;
    left: AstNode;
    right: AstNode;
    pos: number;
} | {
    kind: 'ternary';
    cond: AstNode;
    then: AstNode;
    else: AstNode;
    pos: number;
} | {
    kind: 'call';
    name: FunctionName;
    args: AstNode[];
    pos: number;
};
/**
 * Walk every `field` (Component.field) leaf reachable from `node`, in
 * left-to-right order. Used by `compileRule` (rules.ts) to resolve every
 * component name referenced inside a parsed expression.
 */
export declare function walkFieldRefs(node: AstNode, visit: (component: string, field: string, pos: number) => void): void;

// file: build-id.d.ts
/**
 * Build identity (ED-15). `'dev'` in source and in a plain workspace build;
 * `scripts/pack-for-studio.mjs` rewrites the built `dist/build-id.js` to
 * `'<version>+g<sha>[-dirty]'` before packing, and a published build
 * carries the plain version. Hosts stamp it next to their runtime identity
 * so two packs of the same version stay distinguishable.
 */
export declare const BUILD_ID: string;

// file: evaluator.d.ts
import type { AstNode } from './ast.js';
/**
 * Everything `evaluate` needs, without touching a `World` — the AST /
 * parser / evaluator stay pure and world-agnostic (the only "@domecs/core"
 * import is the pure `dmath` namespace, so `sin()`/`cos()` are
 * bit-reproducible across engines; O-75). The world-facing wiring
 * (resolving `Component.field` against a real `World`) lives in rules.ts.
 */
export interface EvalEnv {
    /**
     * Resolve a `Component.field` reference. Return `undefined` when the
     * component is not registered/known, when the entity currently being
     * evaluated does not have that component, or when the component instance
     * has no such field. `evaluate` treats any of those uniformly: it throws
     * a {@link RuleEvalError} (see the class doc for how rules.ts handles it).
     */
    resolveField(component: string, field: string): number | string | boolean | undefined;
    /** Current tick delta-time in seconds (schedule-dependent — see rules.ts). */
    dt: number;
    /** Current elapsed simulation time in seconds. */
    time: number;
    /** Deterministic RNG hook for the `random()` builtin. */
    rand: {
        uniform(): number;
    };
}
/**
 * Thrown by `evaluate` when it cannot produce a value — for
 * an unresolvable `Component.field` reference (missing component or missing
 * field on the entity being evaluated), and for a value of the wrong type
 * reaching an operator/function that requires a specific type (e.g. `+` on
 * a boolean). rules.ts also throws it for a write it rejects (O-67: missing
 * target component or field, a kind mismatch, a non-finite number).
 *
 * **Documented contract (per M6 spec):** this is a per-entity-per-tick
 * condition, not a systemic one. `evaluate` itself does not know about
 * entities or ticks — it just throws. The caller (`installRules` in
 * rules.ts) catches `RuleEvalError` **per entity**, skips that entity for
 * the tick, reports it as a `rule_eval_failed` fault on the entity (O-68),
 * and continues with the next entity in the query. One bad entity must
 * never stop the rest of the query from being processed that tick. Any
 * other error is a bug and propagates.
 */
export declare class RuleEvalError extends Error {
    constructor(message: string);
}
/**
 * Evaluate a parsed expression against `env`. Pure with respect to the AST
 * (no mutation), but each call to `random()` advances `env.rand`'s
 * underlying state — see rules.ts for how that is wired to a per-tick
 * `Rng` for deterministic replay.
 *
 * Short-circuits `&&`, `||`, and `?:` — the untaken branch is never
 * evaluated, so it can reference fields the current entity lacks without
 * raising (matches ordinary expression-language expectations and avoids
 * spurious RuleEvalErrors from branches that were never meant to run).
 */
export declare function evaluate(ast: AstNode, env: EvalEnv): number | string | boolean;
/** A compiled expression: {@link evaluate} for one AST, without the walk. */
export type CompiledExpression = (env: EvalEnv) => number | string | boolean;
/**
 * O-69 (R12): turn `ast` into nested closures once, so a rule evaluated for
 * every entity every tick does not re-dispatch on node kinds. Same results,
 * errors and short-circuiting as {@link evaluate}; no code is generated.
 */
export declare function compileExpression(ast: AstNode): CompiledExpression;

// file: index.d.ts
export type { AstNode, BinaryOp, FunctionName, LogicalOp, UnaryOp } from './ast.js';
export { FUNCTION_ARITY, FUNCTION_NAMES } from './ast.js';
export { MAX_EXPRESSION_DEPTH, MAX_EXPRESSION_LENGTH, parseExpression } from './parser.js';
export type { ParseError } from './parser.js';
export { evaluate, RuleEvalError } from './evaluator.js';
export type { EvalEnv } from './evaluator.js';
export { compileRule, installRules } from './rules.js';
export type { CompiledRule, InstallRulesOptions, RuleActionDef, RuleDef, RuleError, RuleFault, RulesHandle } from './rules.js';
export { BUILD_ID } from './build-id.js';

// file: lexer.d.ts
/**
 * Tokenizer for the rules expression grammar. Internal to the parser —
 * `tokenize` throws a {@link LexError} on the first invalid character or
 * unterminated string; `parser.ts` catches it and turns it into a
 * `ParseError` (parsing never throws past the public `parseExpression` API).
 */
export type TokenType = 'number' | 'string' | 'identifier' | 'punct' | 'eof';
export interface Token {
    type: TokenType;
    value: string;
    pos: number;
}
export declare class LexError extends Error {
    position: number;
    constructor(message: string, position: number);
}
export declare function tokenize(source: string): Token[];

// file: parser.d.ts
import { type AstNode } from './ast.js';
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
export declare const MAX_EXPRESSION_LENGTH = 16384;
export declare const MAX_EXPRESSION_DEPTH = 128;
export interface ParseError {
    position: number;
    message: string;
}
/**
 * Parse a single expression. Never throws: a syntax error is always
 * reported as a {@link ParseError} with an accurate character `position`
 * (0-based offset into `source`), not an exception.
 */
export declare function parseExpression(source: string): {
    ast: AstNode;
} | {
    errors: ParseError[];
};
export type { AstNode } from './ast.js';

// file: rules.d.ts
import type { ComponentType, World } from '@domecs/core';
export interface RuleActionDef {
    /** Dotted "Component.field" target, same JSON shape as Studio's SystemData.actions. */
    set: string;
    expr: string;
}
export interface RuleDef {
    name: string;
    schedule: 'tick' | 'fixed';
    /**
     * System priority (lower runs first; default 0). Rules of equal priority
     * run in the order of the `defs` array last passed to `update()` (O-69).
     * Where they sit among other systems of that priority depends on
     * {@link InstallRulesOptions.order}.
     */
    priority?: number;
    enabled?: boolean;
    query: string[];
    when?: string;
    actions: RuleActionDef[];
}
export interface RuleError {
    rule: string;
    /** Character position within the offending expression source, or -1 for
     *  a non-syntax error (e.g. an unresolvable component name in `query` or
     *  an action's `set` target — see compileRule doc for the exact rule). */
    position: number;
    message: string;
}
/**
 * The error a rule reports, as an entity fault (`Faulted`, source
 * `rule:<name>`), when it cannot run on that entity: a field it reads is
 * missing, or an action's write is rejected (O-68). The entity is skipped
 * for that tick and nothing is written.
 */
export interface RuleFault {
    readonly kind: 'rule_eval_failed';
    readonly rule: string;
    readonly message: string;
}
/** Opaque compiled-rule handle. Internal shape lives in CompiledRuleInternal below. */
export interface CompiledRule {
    def: RuleDef;
}
/**
 * Resolve+parse a `RuleDef` against real `@domecs/core` component types.
 *
 * - `def.when` (if present) and every `def.actions[i].expr` are parsed via
 *   `parseExpression`; every `ParseError` becomes a `RuleError` at the same
 *   `position` (position is relative to the individual expression string
 *   that produced it, not the whole `RuleDef`).
 * - Every `def.query[i]` name, and every `Component` referenced by a
 *   `Component.field` inside any parsed expression (when or action expr),
 *   is resolved via `resolve(name)`. An unresolvable name is a `RuleError`
 *   with `position` set to the referencing token's position when it came
 *   from inside an expression (so callers can point at it), or `-1` for a
 *   bare name with no token position of its own — `query[i]` entries and an
 *   action's `set` target's component name (the left side of the dot in
 *   `"Component.field"`, which is a raw string, not something parsed).
 * - Type errors certain before the rule runs are `RuleError`s at the
 *   offending node's position (O-68): a string or boolean literal, or an
 *   operator result of that kind, where arithmetic, a comparison or a
 *   function needs a number — outside the right side of `&&`/`||` and
 *   ternary branches, which may not run. Field kinds are not inferred.
 * - If there are ANY errors, returns `{ rule: null, errors }` — never a
 *   partially-compiled rule.
 */
export declare function compileRule(def: RuleDef, resolve: (name: string) => ComponentType<any> | undefined): {
    rule: CompiledRule;
    errors: [];
} | {
    rule: null;
    errors: RuleError[];
};
export interface RulesHandle {
    /**
     * Replace the full active rule set: compiles every def, installs (as
     * `world.system` calls) every rule that compiled clean, and silently (from
     * the caller's perspective — the returned Map tells them) skips ones that
     * did not. Un-registers any `world.system` from a PREVIOUS `update()` call
     * whose rule name is no longer present in `defs`, or is present but now
     * fails to compile.
     *
     * Rules are registered in `defs` order, so equal-priority rules run in
     * that order (O-69). In 'registration' mode re-registration also moves
     * every rule after the equal-priority systems registered before this
     * call; in 'stable' mode it does not (see {@link InstallRulesOptions}). A def that repeats an earlier def's name is not
     * installed and is reported under that name.
     *
     * @returns a `Map<string, RuleError[]>` keyed by rule name for every def
     * that failed to compile or repeated a name. Rules without problems are
     * absent from the map — never present with an empty array.
     */
    update(defs: RuleDef[]): Map<string, RuleError[]>;
    /** Remove every currently-installed rule system. */
    uninstall(): void;
}
/** Options for {@link installRules}. */
export interface InstallRulesOptions {
    /**
     * 'registration' (default, 2.0 behaviour): rules tie-break by registration
     * index, so after `update()` they run after every equal-priority system
     * registered before it.
     * 'stable': rule i (its index in the de-duplicated defs) registers with
     * `order: orderBase + i`, so its run position is a pure function of
     * (priority, defs order), never of when `update()` ran. A def that fails
     * to compile keeps its index.
     */
    readonly order?: 'registration' | 'stable';
    /**
     * First order key used in 'stable' mode (finite). Default 1, so systems
     * with the default order 0 run before rules of the same priority. Give
     * each stable handle on one world its own range.
     */
    readonly orderBase?: number;
}
/**
 * Constructs a {@link RulesHandle} and immediately calls `update(defs)` once.
 *
 * @throws Error when `options.order` is not 'registration' or 'stable', or
 *   `options.orderBase` is not a finite number.
 */
export declare function installRules(world: World, defs: RuleDef[], resolve: (name: string) => ComponentType<any> | undefined, options?: InstallRulesOptions): RulesHandle;

// file: typecheck.d.ts
import type { AstNode } from './ast.js';
/** What an expression is known to produce before it runs. */
export type StaticKind = 'number' | 'string' | 'boolean' | 'unknown';
/**
 * O-68 (R4): infer `node`'s result kind from its literals and operators,
 * and report the type errors that are certain before the rule runs — a
 * string or boolean literal (or an operator producing one) where
 * arithmetic, a comparison or a function needs a number. Field values are
 * `'unknown'`: a component's defaults do not fix a field's kind. Errors in
 * code that may not run — the right side of `&&`/`||`, a ternary branch —
 * are not reported, so this only rejects what fails on every evaluation.
 */
export declare function inferKind(node: AstNode, report: (pos: number, message: string) => void): StaticKind;
