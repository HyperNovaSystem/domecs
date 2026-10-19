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
export declare const FUNCTION_NAMES: readonly ["min", "max", "clamp", "abs", "sin", "cos", "floor", "random", "sqrt", "pow", "atan2", "hypot", "sign", "round", "ceil", "lerp", "distance"];
export type FunctionName = (typeof FUNCTION_NAMES)[number];
/** Expected argument count for each whitelisted function. */
export declare const FUNCTION_ARITY: Readonly<Record<FunctionName, number>>;
/**
 * The special forms (2.2, §5.2, §5.4): calls that are not plain numeric
 * functions, because their arguments are not all number expressions.
 * `args` lists each argument's role — `'set'` (a component
 * name: the entities holding it), `'entity'` (`self`, `first(S)`,
 * `nearest(S[, d])` or `entity(n)`), `'expr'`, or `'memberField'` (a
 * `Component.field` read on each member). `optional` counts the arguments
 * that may be left out: trailing ones, except `has`, whose optional
 * argument is the leading entity (`has(C)` is `has(self, C)`).
 * `first`, `nearest` and `entity` are selectors: they produce an entity,
 * which is only usable as `.Component.field`, `.id`, or an entity argument.
 * `key`, `pressed`, `released` and `mod` read the world's input (§5.4).
 */
export declare const SPECIAL_FORMS: Readonly<Record<string, {
    readonly args: ReadonlyArray<'set' | 'entity' | 'expr' | 'memberField'>;
    readonly optional: number;
}>>;
/**
 * Names the parser reserves (2.2, §5.2, ED-9): `self`, `tick`, (§5.4)
 * `pointer` (`pointer.x`), and (2.3, §6.1) `other` (an event rule's bound
 * entity) and `event` (`event.f`, the triggering payload's field). A
 * component with one of these names cannot be referenced in an expression.
 * After an entity, `id` is reserved too (`e.id` is the entity id).
 */
export declare const RESERVED_WORDS: ReadonlySet<string>;
/** What a selector, `self` or (2.3) `other` refers to (2.2). */
export type EntityNode = {
    kind: 'self';
    pos: number;
}
/** 2.3 (§6.1): the entity an event rule's `other` binding gives. */
 | {
    kind: 'other';
    pos: number;
} | {
    kind: 'select';
    op: 'first' | 'nearest';
    set: string;
    maxDistance?: AstNode;
    pos: number;
} | {
    kind: 'entityById';
    id: AstNode;
    pos: number;
};
export type AggregateOp = 'count' | 'exists' | 'sum' | 'avg' | 'minOf' | 'maxOf';
/** An input read (2.2, §5.4): held key, key edge, or modifier. */
export type InputOp = 'key' | 'pressed' | 'released' | 'mod';
/** The modifier names `mod(n)` accepts (2.2, §5.4). */
export type ModifierName = 'ctrl' | 'alt' | 'shift' | 'meta';
export declare const MODIFIER_NAMES: ReadonlySet<string>;
/** The pointer fields a rule can read (2.2, §5.4). */
export type PointerField = 'x' | 'y' | 'buttons' | 'wheel';
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
/** Bare `dt` / `time` / `tick` (2.2) — NOT a component reference. */
 | {
    kind: 'identifier';
    name: 'dt' | 'time' | 'tick';
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
}
/** `e.Component.field`; `self.C.f` reads the evaluated entity like `C.f`. */
 | {
    kind: 'member';
    target: EntityNode;
    component: string;
    field: string;
    pos: number;
}
/** `e.id`: the entity id as a number. */
 | {
    kind: 'entityId';
    target: EntityNode;
    pos: number;
}
/** `has(C)` / `has(e, C)` (the target defaults to self). */
 | {
    kind: 'has';
    target: EntityNode;
    component: string;
    pos: number;
}
/** `count(S)`, `exists(S)`, `sum|avg|minOf|maxOf(S, C.f)`. */
 | {
    kind: 'aggregate';
    op: AggregateOp;
    set: string;
    component?: string;
    field?: string;
    pos: number;
}
/** `countWithin(S, r[, e])` (the centre defaults to self). */
 | {
    kind: 'countWithin';
    set: string;
    radius: AstNode;
    centre?: EntityNode;
    pos: number;
}
/** `distanceTo(e)`. */
 | {
    kind: 'distanceTo';
    target: EntityNode;
    pos: number;
}
/** `a ?? b`: `b` when evaluating `a` yields no value. */
 | {
    kind: 'nullish';
    left: AstNode;
    right: AstNode;
    pos: number;
}
/** `key(n)` (held), `pressed(n)` / `released(n)` (edges this tick), `mod(n)`. */
 | {
    kind: 'input';
    op: InputOp;
    arg: AstNode;
    pos: number;
}
/** `pointer.x`, `pointer.y`, `pointer.buttons`, `pointer.wheel`. */
 | {
    kind: 'pointer';
    field: PointerField;
    pos: number;
}
/** `event.f`: the triggering event payload's field (event rules only). */
 | {
    kind: 'event';
    field: string;
    pos: number;
};
/**
 * Walk every read of the evaluated entity's own fields reachable from
 * `node`, in left-to-right order: `Component.field` and (2.2) `self.C.f`,
 * including inside the expression arguments of the 2.2 forms. Reads of
 * other entities (`first(S).C.f`), sets and `has` targets are not visited;
 * {@link walkComponentRefs} visits every component name. Exported from the
 * package entry for tools that only need self-field positions (a 2.1-style
 * rename of the evaluated entity's own reads); a rename that must also
 * cover member reads, sets and `has` targets uses `walkComponentRefs`.
 * `pos` is the node position: the component token for `C.f`, but the
 * `self` token for `self.C.f` (the component name follows `self.`).
 */
export declare function walkFieldRefs(node: AstNode, visit: (component: string, field: string, pos: number) => void): void;
/**
 * Walk every component name reachable from `node`, in left-to-right source
 * order (2.2, §5.2):
 * - `'self'`: a read of the evaluated entity's field (`C.f`, `self.C.f`);
 * - `'member'`: a read of another entity's field (`first(S).C.f`, `e.C.f`,
 *   2.3 `other.C.f`) or an aggregate's per-member field (`sum(S, C.f)`);
 * - `'set'` (`field` null): a set (`count(S)`, `first(S)`, …) or a `has`
 *   target component.
 *
 * `pos` is the node's position: the component token for `C.f`, the start of
 * the entity for `e.C.f`, and the form's name token for sets, aggregates and
 * `has`. Component renames and `compileRule` resolution use this walker.
 * Payload reads (`event.f`, 2.3) name no component and are not visited.
 */
export declare function walkComponentRefs(node: AstNode, visit: (component: string, field: string | null, pos: number, role: 'self' | 'member' | 'set') => void): void;
/** Every direct child of `node` (expressions and entity nodes), for depth walks. */
export declare function childNodes(node: AstNode | EntityNode): Array<AstNode | EntityNode>;

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
import { type AstNode, type ModifierName } from './ast.js';
/** A value an expression produces. */
type Value = number | string | boolean;
/**
 * Everything `evaluate` needs, without touching a `World` — the AST /
 * parser / evaluator stay pure and world-agnostic (the only "@domecs/core"
 * import is the pure `dmath` namespace, so `sin()`/`cos()` and, from 2.2,
 * `atan2()`/`hypot()`/`pow()` are bit-reproducible across engines; O-75).
 * The world-facing wiring (resolving `Component.field` against a real
 * `World`) lives in rules.ts.
 *
 * The 2.2 members (spec §5.2) are optional, so the evaluator stays usable
 * without a world: a form whose hook is missing raises a
 * {@link RuleEvalError} "not available in this environment".
 */
export interface EvalEnv {
    /**
     * Resolve a `Component.field` reference. Return `undefined` when the
     * component is not registered/known, when the entity currently being
     * evaluated does not have that component, or when the component instance
     * has no such field. `evaluate` treats any of those uniformly: it throws
     * a {@link RuleEvalError} (a "no value" one, which `??` catches; see the
     * class doc for how rules.ts handles it).
     */
    resolveField(component: string, field: string): Value | undefined;
    /** Current tick delta-time in seconds (schedule-dependent — see rules.ts). */
    dt: number;
    /** Current elapsed simulation time in seconds. */
    time: number;
    /** Deterministic RNG hook for the `random()` builtin. */
    rand: {
        uniform(): number;
    };
    /** The evaluated entity's id (`self`, `self.id`; excluded by selectors). */
    self?: number | undefined;
    /** `C.f` on another entity, own properties only; `undefined` when absent. */
    readField?(entity: number, component: string, field: string): Value | undefined;
    /** The entities holding component `set`, ascending id, stable within a run. */
    members?(set: string): readonly number[];
    /** Whether `entity` is alive (`entity(n)`). */
    isAlive?(entity: number): boolean;
    /** Whether `entity` holds `component` (`has`). */
    has?(entity: number, component: string): boolean;
    /** The entity's position (live), or `undefined` when it has none. */
    position?(entity: number): {
        x: number;
        y: number;
    } | undefined;
    /** Nearest member of `set` to (x, y) within `maxDistance` (ties → lowest id), excluding `exclude`. */
    nearest?(set: string, x: number, y: number, maxDistance: number, exclude: number | undefined): number | undefined;
    /** Members of `set` within `r` of (x, y), ascending id, excluding `exclude`. */
    within?(set: string, x: number, y: number, r: number, exclude: number | undefined): readonly number[];
    /** `world.time.tick` (`tick`). */
    tick?: number;
    /**
     * Input state (2.2, §5.4), for `key(n)` (held), `pressed(n)` /
     * `released(n)` (edges), `mod(n)` and `pointer.x|y|buttons|wheel`. Rules
     * wire it from `ctx.input` (`keys`, `keyDelta`, `mods`, `pointer`).
     * `mod` is only called with one of the four names.
     */
    input?: {
        key(name: string): boolean;
        pressed(name: string): boolean;
        released(name: string): boolean;
        mod(name: ModifierName): boolean;
        readonly pointer: {
            readonly x: number;
            readonly y: number;
            readonly buttons: number;
            readonly wheel: number;
        };
    };
    /**
     * Event rules (2.3, §6.1): the triggering payload's field `f` for
     * `event.f`; `undefined` when the payload has no such field (no value).
     */
    eventField?(field: string): Value | undefined;
    /**
     * Event rules (2.3, §6.1): the entity the `other` binding gave, or
     * `undefined` when it gave none (no value). A dead entity is no value too.
     */
    other?: number | undefined;
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
 * "No value" (2.2, §5.2): a missing self or member field, an empty
 * selector result, a dead `entity(n)`, an empty `avg`/`minOf`/`maxOf`, an
 * entity without a position. `a ?? b` evaluates `b` on this error only.
 * Internal: `instanceof RuleEvalError` still holds, so uncaught it is the
 * existing per-entity `rule_eval_failed` fault.
 */
export declare class RuleNoValueError extends RuleEvalError {
    constructor(message: string);
}
/**
 * Evaluate a parsed expression against `env`. Pure with respect to the AST
 * (no mutation), but each call to `random()` advances `env.rand`'s
 * underlying state — see rules.ts for how that is wired to a per-tick
 * `Rng` for deterministic replay.
 *
 * Short-circuits `&&`, `||`, `?:` and `??` — the untaken branch is never
 * evaluated, so it can reference fields the current entity lacks without
 * raising (matches ordinary expression-language expectations and avoids
 * spurious RuleEvalErrors from branches that were never meant to run).
 */
export declare function evaluate(ast: AstNode, env: EvalEnv): Value;
/** A compiled expression: {@link evaluate} for one AST, without the walk. */
export type CompiledExpression = (env: EvalEnv) => Value;
/** Options for {@link compileExpression}. */
export interface CompileOptions {
    /**
     * Aggregates for which this returns true are computed once per
     * environment object (rules.ts builds one per rule run) and reused for
     * every entity of that run. Only sound when the aggregate cannot change
     * during the run: rules.ts marks a set aggregate whose field's component
     * the rule does not write (§5.2 "Memoization"). Results are identical
     * either way.
     */
    readonly memoize?: (node: Extract<AstNode, {
        kind: 'aggregate';
    }>) => boolean;
}
/**
 * O-69 (R12): turn `ast` into nested closures once, so a rule evaluated for
 * every entity every tick does not re-dispatch on node kinds. Same results,
 * errors and short-circuiting as {@link evaluate}; no code is generated.
 */
export declare function compileExpression(ast: AstNode, options?: CompileOptions): CompiledExpression;
export {};

// file: index.d.ts
export type { AggregateOp, AstNode, BinaryOp, EntityNode, FunctionName, InputOp, LogicalOp, ModifierName, PointerField, UnaryOp, } from './ast.js';
export { FUNCTION_ARITY, FUNCTION_NAMES, SPECIAL_FORMS, walkComponentRefs, walkFieldRefs } from './ast.js';
export { MAX_EXPRESSION_DEPTH, MAX_EXPRESSION_LENGTH, parseExpression } from './parser.js';
export type { ParseError } from './parser.js';
export { evaluate, RuleEvalError } from './evaluator.js';
export type { EvalEnv } from './evaluator.js';
export { compileRule, installRules } from './rules.js';
export type { CompiledRule, CompileRuleOptions, InstallRulesOptions, RuleActionDef, RuleDef, RuleDefPath, RuleError, RuleFault, RulesHandle, SpatialOption, } from './rules.js';
export { compileWorldExpression } from './world-expression.js';
export type { WorldExpression } from './world-expression.js';
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
 * Rules expression grammar (exactly this, nothing more; `(+)` marks the
 * 2.2 additions, spec §5.2):
 *
 *   expr       := ternary
 *   ternary    := nullish ( '?' ternary ':' ternary )?        // right-assoc
 *   nullish    := logicOr ( '??' logicOr )*                    (+) left-assoc
 *   logicOr    := logicAnd ( '||' logicAnd )*
 *   logicAnd   := equality ( '&&' equality )*
 *   equality   := relational ( ('==' | '!=') relational )*
 *   relational := additive ( ('<' | '<=' | '>' | '>=') additive )*
 *   additive   := multiplicative ( ('+' | '-') multiplicative )*
 *   multiplicative := unary ( ('*' | '/' | '%') unary )*
 *   unary      := ('!' | '-') unary | primary
 *   primary    := number | string | 'true' | 'false'
 *               | 'dt' | 'time' | 'tick'                       (+) tick
 *               | IDENT '.' IDENT                              // Component.field
 *               | entity '.' IDENT '.' IDENT                   (+) another entity's field
 *               | entity '.' 'id'                              (+) entity id
 *               | 'pointer' '.' ('x' | 'y' | 'buttons' | 'wheel')  (+) §5.4
 *               | 'event' '.' IDENT                            (++) payload field (2.3, §6.1)
 *               | call
 *               | '(' expr ')'
 *   entity     := 'self' | 'first' '(' SET ')'                 (+)
 *               | 'other'                                      (++) event rules (2.3, §6.1)
 *               | 'nearest' '(' SET ( ',' expr )? ')'          (+) optional max distance
 *               | 'entity' '(' expr ')'                        (+) by numeric id
 *   call       := FUNC '(' args? ')'                           // whitelisted call
 *               | 'has' '(' ( entity ',' )? SET ')'            (+)
 *               | ('count' | 'exists') '(' SET ')'             (+)
 *               | 'countWithin' '(' SET ',' expr ( ',' entity )? ')'   (+)
 *               | ('sum' | 'avg' | 'minOf' | 'maxOf') '(' SET ',' IDENT '.' IDENT ')'  (+)
 *               | 'distanceTo' '(' entity ')'                  (+)
 *               | ('key' | 'pressed' | 'released' | 'mod') '(' expr ')'  (+) §5.4, arg: a string
 *   args       := expr ( ',' expr )*
 *   SET        := IDENT                                        (+) a component name: its holders
 *
 * Function calls are restricted to exactly: min(a,b) max(a,b) clamp(v,lo,hi)
 * abs(v) sin(v) cos(v) floor(v) random(), and from 2.2 sqrt(v) pow(a,b)
 * atan2(y,x) hypot(a,b) sign(v) round(v) ceil(v) lerp(a,b,t)
 * distance(x1,y1,x2,y2). Wrong arity or an unknown function name is a
 * ParseError, not a runtime error — the whitelist and arg counts are
 * enforced at parse time.
 *
 * Reserved words (2.2): `self`, `tick`, `other`, `event`, `pointer` cannot
 * name a component in an expression, and `id` cannot after an entity.
 * `(++)` marks the 2.3 additions (§6.1): `event.f` reads the triggering
 * event's payload and `other` is the entity an event rule binds; the parser
 * accepts both anywhere, and `compileRule` / `compileWorldExpression`
 * reject them outside an event rule (and `other` without a binding). Only
 * `first(`, `nearest(` and `entity(` start a selector: `first.x` is still
 * `Component.field`. An entity is not a value: use `.id` or
 * `.Component.field`. Input reads (2.2, §5.4): `key(n)`, `pressed(n)`,
 * `released(n)`, `mod(n)` and `pointer.x|y|buttons|wheel`; `key`,
 * `pressed`, `released` and `mod` start an input read only before `(`.
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
import { type ComponentType, type EventType, type World } from '@domecs/core';
import { type AstNode, type EntityNode } from './ast.js';
/**
 * O-67: field names a rule may never read or write. Reads are own-property
 * only, and these names would reach the object's prototype machinery.
 */
export declare const FORBIDDEN_FIELDS: ReadonlySet<string>;
export interface RuleActionDef {
    /** Dotted "Component.field" target, same JSON shape as Studio's SystemData.actions. */
    set: string;
    expr: string;
}
export interface RuleDef {
    name: string;
    /**
     * `'tick'` / `'fixed'`: the rule polls every entity matching `query` on
     * that schedule. `'event'` (2.3, §6.1): the rule runs when the event named
     * by {@link on} is delivered — once per payload, in emission order — for
     * the entity {@link self} names, else for every entity matching `query`
     * (broadcast, ascending id), else once with no entity (world scope: empty
     * `query`, no `self`).
     */
    schedule: 'tick' | 'fixed' | 'event';
    /**
     * Event rules (2.3): the name of the event that triggers the rule,
     * resolved through {@link InstallRulesOptions.resolveEvent} (default
     * `world.lookupEvent`). Required iff `schedule` is `'event'`.
     */
    on?: string;
    /**
     * Event rules (2.3): an expression giving self's entity id from the
     * payload, e.g. `"event.target"`. When it names an entity that is not
     * alive or does not match `query`/`without`, the payload is skipped
     * silently; when it gives no value or no integer, that is a systemic
     * `rule_eval_failed` fault (`event.target ?? -1` skips silently instead).
     * It cannot read an evaluated entity (`C.f`, `self`, ...) or `other`.
     */
    self?: string;
    /**
     * Event rules (2.3): an expression giving the entity `other` refers to,
     * e.g. `"event.b"`. When it gives no value, or the entity is dead,
     * reads of `other` are no value. Same restrictions as {@link self}.
     */
    other?: string;
    /**
     * System priority (lower runs first; default 0). Rules of equal priority
     * run in the order of the `defs` array last passed to `update()` (O-69).
     * Where they sit among other systems of that priority depends on
     * {@link InstallRulesOptions.order}.
     */
    priority?: number;
    /**
     * Which stream the rule's `random()` draws (§4.4; SPEC §2.8). Overrides
     * {@link InstallRulesOptions.rng} for this rule. `'own'`: the rule's own
     * stream, keyed `rule:<name>` and derived from the world's root seed, so
     * adding, removing or editing another rule never changes its draws (its
     * draws still depend on how many entities it visits). `'shared'`: the
     * world's shared stream. Any other value is a {@link RuleError} on `'rng'`.
     */
    rng?: 'shared' | 'own';
    enabled?: boolean;
    query: string[];
    /**
     * Components that exclude an entity from the rule (2.2, §5.2): the rule
     * runs on entities holding every `query` component and none of these
     * (`And(...query.map(Has), ...without.map(c => Not(Has(c))))`).
     */
    without?: string[];
    when?: string;
    actions: RuleActionDef[];
}
/**
 * Which part of a {@link RuleDef} an error is about (§4.6). Later minors add
 * members, so keep a default branch when switching on it.
 */
export type RuleDefPath = 'name' | 'schedule' | 'priority' | 'rng' | 'when' | 'on' | 'self' | 'other' | {
    readonly query: number;
} | {
    readonly without: number;
} | {
    readonly action: number;
    readonly part: 'set' | 'expr';
};
export interface RuleError {
    rule: string;
    /** Character position within the offending part's string (see `field`),
     *  or -1 for a non-syntax error (e.g. an unresolvable component name in
     *  `query` or an action's `set` target — see compileRule doc for the
     *  exact rule). */
    position: number;
    message: string;
    /** The part of the def the error is about. Set by compileRule and
     *  installRules from 2.1 on every error. */
    field?: RuleDefPath;
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
 * - Event rules (2.3, §6.1): `on` must resolve through
 *   `options.resolveEvent` (`field: 'on'`); `on`, `self` and `other` on a
 *   polling rule are errors at that field. `event.f` outside an event rule,
 *   or naming a field the event's schema does not declare, and `other`
 *   without an `other` binding, are errors at their position. The `self` /
 *   `other` bindings and every expression of a world-scope rule (no `self`,
 *   empty `query`) cannot read an evaluated entity (`C.f`, `self`,
 *   `has(C)`, `nearest`, `distanceTo`, a centre-less `countWithin`); a
 *   world-scope rule cannot `set` (`{ action: i, part: 'set' }`) or use
 *   `without`.
 * - Every error carries `field` (§4.6), the one part of the def it is about:
 *   `'schedule'`, `'priority'`, `'rng'`, `'on'`, `'self'`, `'other'`, `{ query: i }`, `'when'` (parse, resolve and
 *   type errors), `{ action: i, part: 'set' }` (malformed target, unknown
 *   target component, forbidden target field) or `{ action: i, part: 'expr' }`
 *   (every error inside that expression). `position` is an offset within
 *   that part's string, or -1.
 * - If there are ANY errors, returns `{ rule: null, errors }` — never a
 *   partially-compiled rule.
 */
export declare function compileRule(def: RuleDef, resolve: (name: string) => ComponentType<any> | undefined, options?: CompileRuleOptions): {
    rule: CompiledRule;
    errors: [];
} | {
    rule: null;
    errors: RuleError[];
};
/** Default `spatial.cellSize`: a pure performance setting (results never depend on it). */
export declare const DEFAULT_CELL_SIZE = 32;
/** The position source for `nearest`, `countWithin` and `distanceTo`. */
export interface SpatialOption {
    /** Component holding each entity's position. */
    readonly component: string;
    /** Field names (default `'x'` / `'y'`). */
    readonly x?: string;
    readonly y?: string;
    /** Grid cell size (default 32): performance only, results never depend on it. */
    readonly cellSize?: number;
}
/** Options for {@link compileRule} (2.2). */
export interface CompileRuleOptions {
    /** Position source; required if the rule uses `nearest`, `countWithin` or `distanceTo`. */
    readonly spatial?: SpatialOption;
    /**
     * Event types by name (2.3, §6.1), for an event rule's `on`.
     * `installRules` defaults it to `world.lookupEvent`; `compileRule` has
     * no default, so an event rule compiled without it reports `on`.
     */
    readonly resolveEvent?: (name: string) => EventType<unknown> | undefined;
}
/** Visit `root` and every node below it (expressions and entity nodes), parents first. */
export declare function forEachNode(root: AstNode, visit: (node: AstNode | EntityNode) => void): void;
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
     * First order key used in 'stable' mode (finite, |orderBase| <= 2^51 so
     * every key orderBase + i stays exact). Default 1, so systems
     * with the default order 0 run before rules of the same priority. Give
     * each stable handle on one world its own range.
     */
    readonly orderBase?: number;
    /**
     * Default stream mode for every rule that sets no {@link RuleDef.rng}
     * (§4.4). Default `'shared'` (2.0 behaviour). `'own'` gives each rule its
     * own stream, so editing one rule never reshuffles another's draws.
     */
    readonly rng?: 'shared' | 'own';
    /**
     * Position source for `nearest`, `countWithin` and `distanceTo` (2.2,
     * §5.2); required if any rule uses them (otherwise that rule fails to
     * compile). Selection uses a grid built from these positions at the start
     * of each rule run; `distanceTo` reads live positions. An entity whose
     * position fields are missing or not finite numbers has no position.
     */
    readonly spatial?: SpatialOption;
    /**
     * Event types by name, for event rules' `on` (2.3, §6.1). Default
     * `world.lookupEvent`: the event must be known to the world (registered,
     * emitted, subscribed to or a trigger) when `update()` compiles the rule,
     * and its name must not be ambiguous.
     */
    readonly resolveEvent?: (name: string) => EventType<unknown> | undefined;
}
/**
 * Constructs a {@link RulesHandle} and immediately calls `update(defs)` once.
 *
 * @throws Error when `options.order` is not 'registration' or 'stable',
 *   `options.orderBase` is not a finite number with |orderBase| <= 2^51, or
 *   `options.rng` is not 'shared' or 'own'.
 */
export declare function installRules(world: World, defs: RuleDef[], resolve: (name: string) => ComponentType<any> | undefined, options?: InstallRulesOptions): RulesHandle;

// file: typecheck.d.ts
import { type AstNode } from './ast.js';
/** What an expression is known to produce before it runs. */
export type StaticKind = 'number' | 'string' | 'boolean' | 'unknown';
/**
 * O-68 (R4): infer `node`'s result kind from its literals and operators,
 * and report the type errors that are certain before the rule runs — a
 * string or boolean literal (or an operator producing one) where
 * arithmetic, a comparison or a function needs a number. Field values are
 * `'unknown'`: a component's defaults do not fix a field's kind. Errors in
 * code that may not run — the right side of `&&`/`||`/`??`, a ternary
 * branch — are not reported, so this only rejects what fails on every
 * evaluation.
 *
 * 2.2 (§5.2): `has` and `exists` are boolean; `count`, `countWithin`,
 * `distanceTo`, `e.id`, `tick` and the aggregates are numbers; member reads
 * are `'unknown'`. An entity is never a value: the parser already rejects
 * one outside a member base, selector argument or `has` target ("use .id").
 * Input reads (§5.4) are boolean (`key`, `pressed`, `released`, `mod`) or
 * number (`pointer.*`); their argument must be a string, and a literal
 * `mod` name must be one of ctrl, alt, shift, meta.
 */
export declare function inferKind(node: AstNode, report: (pos: number, message: string) => void): StaticKind;

// file: world-expression.d.ts
import { type ComponentType, type Result, type World } from '@domecs/core';
import { type AstNode } from './ast.js';
import { type InstallRulesOptions, type RuleError, type RuleFault } from './rules.js';
/**
 * A compiled world expression (2.2, §5.3): a rules expression with no
 * evaluated entity, for metrics, probes and outcomes measured over a whole
 * world.
 */
export interface WorldExpression {
    /** The source it was compiled from. */
    readonly source: string;
    /** The parsed expression. */
    readonly ast: AstNode;
    /**
     * Evaluate against `world`'s current state. Read-only: never mutates the
     * world, never draws randomness, never moves change windows, so
     * `hashSnapshot(world.snapshot({}), { includeChanges: true })` is the same
     * after any number of calls, and `describe()` changes only by a type
     * object attached to data a restore left unregistered. Retains nothing
     * of `world` after it returns. A no-value read without `??`, a type error,
     * a non-finite number or a non-primitive result is
     * `err({ kind: 'rule_eval_failed', rule: '<expr>', message })`.
     */
    evaluate(world: World): Result<number | string | boolean, RuleFault>;
}
/**
 * Compile a world expression (2.2, §5.3): the rules grammar without an
 * evaluated entity. Rejected at compile time, at the form's position:
 * bare `Component.field`, `self`, `has(C)` without an entity, `distanceTo`
 * and `nearest` (both measure from the evaluated entity), `countWithin`
 * without a centre, `dt`, `random()` (measuring a world must not
 * advance its randomness), and the input reads `key`, `pressed`,
 * `released`, `mod` and `pointer.*` (a metric must not depend on input), and
 * (2.3) the event-rule forms `event.f` and `other`. `time` is `world.time.elapsed` and `tick` is
 * `world.time.tick`. Everything else — selectors `first(S)` and
 * `entity(n)` with `.C.f` / `.id` reads, `has(e, C)`, aggregates,
 * `countWithin(S, r, e)` (needs `options.spatial`), math and `??` —
 * means what it means in a rule.
 *
 * Unknown components, forbidden fields and certain type errors are errors
 * too, as in `compileRule`. Errors carry `rule: '<expr>'` and a `position`
 * in `source`, in source order. Never throws.
 */
export declare function compileWorldExpression(source: string, resolve: (name: string) => ComponentType<any> | undefined, options?: {
    readonly spatial?: InstallRulesOptions['spatial'];
}): {
    expression: WorldExpression;
    errors: [];
} | {
    expression: null;
    errors: RuleError[];
};
