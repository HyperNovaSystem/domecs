# Designing APIs, SDKs, and Libraries for AI Agents

*A legibility guideline. Core thesis: an API is a language. If you design it for a reader that moves forward token by token, reasons locally, and pattern-matches from prior examples, you get an API that is also harder for humans to misuse. The two goals rarely conflict; where they do, this document says so.*

---

## 0. The agent's reading model (why these rules exist)

Every rule below falls out of how an agent actually consumes your surface. Design against this model, not against an idealized careful reader.

- **Forward pass, weak backtracking.** The agent commits to tokens as it emits them. Correctness should be decidable from what precedes a call, not from something it would have to scroll back to find.
- **Finite context.** It cannot hold your entire surface in view. What isn't in the signature, the local docstring, or the error message effectively does not exist at the moment of the call.
- **Pattern completion.** It guesses the next method, argument, or field from priors. A *guessable* API is a correct API; an inconsistent one manufactures hallucinations and then gets blamed for them.
- **Self-correction from feedback.** It reads errors and retries. An error that says *what failed, why, and how to fix it* turns a failure into a fix. An opaque error turns it into a loop.
- **Possibly stale priors.** Its training or cache may predate your latest version. Behavior must not change silently under a name it already "knows."

> **The smell test:** if an agent guesses the wrong method name, passes args in the wrong order, or misses a failure mode — treat it as a design bug in your surface, not a defect in the agent. The fix is almost always *more locality* or *more consistency*.

---

## I. The signature is the contract

Everything required to call correctly should live in the signature and its immediate doc. Nothing load-bearing in prose three pages away.

1. **Type the boundary.** Inputs and outputs are typed at every public edge. Inference inside is fine; opacity at the edge is not.
2. **Make effects and capabilities explicit.** What does this touch — network, disk, clock, the database, money? Name it. For wire APIs, this is method semantics (a `GET` does not mutate); for SDKs, prefer passing capabilities in over reaching out to ambient globals.
3. **Errors are values, and they are enumerable.** The set of ways a call can fail is part of its type, not a surprise discovered at runtime. Closed error enums over open exception hierarchies.
4. **Name arguments; don't position them.** Keyword/named params, or a single options object, over positional lists. Transposing two same-typed positional args is the single most common silent error — and naming makes it impossible.

```
// Don't — what fails? what does it touch? what are these three booleans?
sync(dev, true, false, true)

// Do — failure, effect, and intent all visible at the call site
fn sync_device(
  device: DeviceId,
  mode: SyncMode,            // closed set, see §II.2
) -> Result<SyncReport, SyncError>   // failure is in the type
  uses [Network, Db]                 // effect is in the signature
```

---

## II. One canonical path

Each action has exactly one idiomatic spelling. Every redundant way to do a thing is a fork the agent must choose at, a variant a human reviewer must re-recognize, and a surface you must keep consistent forever. Pure cost, no signal.

1. **One way per action.** No three pagination styles, no "you can pass a string *or* an object *or* a callback." Pick one. Offer sugar later only if it earns its keep.
2. **Closed sets over magic strings.** Anything with a fixed set of valid values is an enum/constant, not a free-form string. The valid options become visible and unguessable-wrong.
3. **Consistent naming the agent can extrapolate.** If you have `getUser` and `getAccount`, the third one is `getDevice` — never `fetchDevice` or `deviceLookup`. Pick a verb set (`get/list/create/update/delete`), pick singular-vs-plural rules, and never deviate. Consistency is what lets pattern completion land on the right name on the first try.
4. **Small orthogonal primitives over mega-functions with mode flags.** A function whose behavior forks on a `mode` or `legacy` flag is several functions wearing a trench coat. Split them; let the agent compose.

```
// Don't — one entry point, behavior depends on which keys you set
query({ id, ids, filter, raw, paginate, legacy })

// Do — orthogonal, each guessable from the others
get_device(id)            // one
list_devices(filter)      // many
```

---

## III. Locality — no action at a distance

The result of a call should depend only on its arguments and explicitly-passed state, never on hidden order or ambient context.

1. **No required setup rituals — or make them typed.** If `connect()` must precede `query()`, encode it: `query` takes a `Connection`, so the type system makes the wrong order unrepresentable. Don't leave ordering as folklore in the README.
2. **No hidden global/mutable state.** Ambient singletons, implicit "current context," thread-locals, and `this`-rebinding all force nonlocal reasoning the agent cannot see. Pass state in; return state out.
3. **Return what's needed for the next step.** A `create` should return the created object (with its id), not just a status — so the agent isn't forced into a second guess-the-id call.
4. **Self-contained calls.** Reading one call should not require reading three earlier ones. If it does, that's coupling to surface.

```
// Don't — implicit ordering, ambient state, useless return
configure_client(apiKey)      // mutates a hidden global
set_active_project("alpha")   // more hidden state
run()                         // returns void; depends on the two calls above

// Do — state flows through values; order is enforced by types
let client  = Client(api_key)
let project = client.project("alpha")
let result  = project.run()   // returns the run; nothing hidden
```

---

## IV. Failure is legible

Agents self-correct from errors. Treat the error path as a primary interface, not an afterthought.

1. **Every error answers three questions:** *what* failed, *why*, and *how to fix it.* The fix hint is the part most APIs omit and the part an agent uses most.
2. **Distinguish retryable from terminal.** A typed/flagged distinction (transient vs permanent) tells the agent whether to back off and retry or to stop and change its input. Without it, the agent either gives up on transients or hammers permanents.
3. **Mark idempotency and safety.** State plainly which operations are safe to retry and which mutate. Support idempotency keys on anything that creates or charges. An agent *will* retry on timeout; design for it.
4. **Fail at the boundary, not deep inside.** Validate inputs at entry and reject with a precise message, rather than failing three layers down with a stack trace that leaks internals and pins blame on the wrong line.

```
// Don't
Error: invalid input

// Do — what / why / how, plus a retry signal
Error: setpoint 4200 N exceeds device max (3000 N) for DeviceId "rig-07".
  what:  validation failed on field `setpoint`
  why:   value 4200 > device.max_force 3000
  fix:   pass setpoint <= 3000, or raise the device limit first
  retry: false   // terminal — do not retry without changing input
```

---

## V. Discoverability — a machine-readable surface

The agent should be able to *learn your API from the artifact*, not from a blog post.

1. **Ship a machine-readable spec.** OpenAPI for HTTP, MCP tool schemas for tools, typed stubs (`.d.ts`, `.pyi`, type hints) for libraries. The schema *is* the documentation the agent trusts most.
2. **Examples are the primary documentation.** Agents copy examples far more than they parse prose. Every public entry point gets at least one runnable example showing the happy path and one showing error handling.
3. **Keep examples current by running them.** A drifted example is worse than none — it teaches the wrong thing confidently. Put examples under test (doctest, snippet CI) so they cannot rot.
4. **Self-describing names and docstrings.** The name and one-line doc should let the agent decide *whether this is the right call* without opening the body.

> For MCP/tool surfaces specifically: the tool **description** and **parameter docs** are the entire interface — there is no body to read. Spend disproportionate care there. One tool = one clear job; avoid tools whose behavior depends on a `mode` argument (see §II.4).

---

## VI. Economy of context

The window is finite. Respect it as a first-class resource.

1. **Flat over deeply nested.** A response five objects deep costs the agent more to traverse and more tokens to hold. Prefer shallow shapes and explicit references over deep embedding.
2. **Small surface, few concepts.** Fewer types, reused consistently, beat many bespoke ones. Every new concept is something the agent must fit into a finite window alongside the actual task.
3. **Predictable partial results.** Pagination, streaming, and partial sync should be uniform across the whole API — same cursor field, same page-size param, same "has more" signal everywhere.
4. **Don't make the agent hold large state across calls.** If a workflow needs continuity, give it a server-side handle/token to carry, not a blob it must keep verbatim in context.

---

## VII. Stability — the agent's priors may be stale

1. **Version visibly; evolve additively.** Add fields and methods; don't repurpose existing ones. A name the agent already "knows" must keep meaning what it meant.
2. **No silent behavior changes.** Changing a default, a unit, or an error shape under an unchanged signature is a trap for any agent working from priors. Make breaking changes loud and versioned.
3. **Deprecate in the type, with a pointer.** Deprecation should surface at the call site (annotation, lint, warning) and name its replacement, so the agent is steered to the new path instead of guessing.

---

## VIII. The enforcement gradient (carry-over from the language design)

Where you can, encode rules at the strongest level the situation supports, and degrade gracefully:

1. **Prove it** — make the wrong thing unrepresentable in the type (ordering via `Connection`, exhaustiveness via closed enums).
2. **Check it** — validate at the boundary with a precise, fix-oriented error (§IV).
3. **Witness it** — ship runnable examples that cannot drift (§V.2–3).

The same predicate — "setpoint must be ≤ device max" — ideally appears as a type refinement, a boundary check, *and* an example, in that order of preference. Pick the strongest rung you can afford for each rule rather than treating these as separate features.

---

## IX. Review checklist

Run a public change against these. A "no" is a design bug to fix or to consciously accept.

**Signature**
- [ ] Can the call be made correctly from the signature + one-line doc alone?
- [ ] Are inputs/outputs typed at the boundary?
- [ ] Are all failure modes in the type (not thrown as a surprise)?
- [ ] Are args named, or order-safe?
- [ ] Are effects (network/disk/clock/db/money) discoverable?

**Canonical form**
- [ ] Exactly one idiomatic way to do this action?
- [ ] Fixed-value params are enums/constants, not free strings?
- [ ] Does the name follow the existing verb/number conventions so it's guessable?

**Locality**
- [ ] Result depends only on args + passed-in state (no hidden globals/order)?
- [ ] Does it return what's needed for the next step?

**Failure**
- [ ] Does every error give what / why / how-to-fix?
- [ ] Is retryable-vs-terminal distinguishable?
- [ ] Are mutating/creating calls idempotency-safe?

**Discoverability**
- [ ] Machine-readable spec (OpenAPI / MCP schema / typed stubs) shipped?
- [ ] At least one runnable, tested example per entry point?
- [ ] (Tools/MCP) Is the description a complete interface on its own?

**Context & stability**
- [ ] Response shape shallow and uniform with the rest of the API?
- [ ] Pagination/partial-results consistent across the surface?
- [ ] Change is additive; no silent repurposing of existing names?

---

## X. The one-line version

> **Put everything needed to use it — and every way it can fail — where the reader already is, spell each action exactly one way, and make the error tell you how to fix it.**

Everything else is a corollary.
