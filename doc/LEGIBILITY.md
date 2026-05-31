# domecs legibility — the contributor's law

> **What this is:** a standing review checklist for every public API change in domecs.
> Run a public change against the six laws below before merging.
> A "no" on any line is a design bug to fix or a cost to consciously accept.
>
> **Why it exists:** domecs is read far more by AI agents than by humans — agents move forward token by token, reason locally, pattern-match from priors, and self-correct from errors.
> An API designed for that reader is also harder for a human to misuse.
> The full reasoning is in the source rubric, [`agent-legible-api-design.md`](./agent-legible-api-design.md);
> the v1.0 plan that applies it is [`2026-05-30-v1-legibility-pass-design.md`](./2026-05-30-v1-legibility-pass-design.md).

**Enforcement legend:** ✅ = enforced in the shipped types/CI now (L1 in Phase 0; L3/L4/L5 in the
v1.0 break, Phase 2) · ⏳ = the rule is binding on new code today, but its remaining automated
enforcement lands later in the pass (Phases 3–4). Write to the rule regardless of which marker it
carries — ⏳ means "no CI net yet," not "optional."

---

## L1 — The shipped type surface is the contract ✅

The committed `.d.ts` snapshot is the public-API contract for every `@domecs/*` package. `api.md` is a
*derived* view, never the source of truth.

- **Regenerate on every public change:** `pnpm -r build && pnpm api:surface`, then commit the diff in
  [`doc/api-surface/`](./api-surface/). That diff **is** the API review — read it like one.
- **Enforced by:** the CI no-drift gate (`git diff --exit-code -- doc/api-surface`) plus
  [`pnpm api:check`](../test/api-surface.test.mjs), both in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
  The generator is [`scripts/api-surface.mjs`](../scripts/api-surface.mjs); see
  [`doc/api-surface/README.md`](./api-surface/README.md) for why the snapshot is committed even though
  `dist/` is gitignored.
- **`api.md`:** when it drifts, regenerate it or banner-mark it "authoritative source is the types."

**Checklist:** Did the public surface change? → snapshot regenerated and committed, and the surface
diff reviewed as an API change.

---

## L2 — Self-describing schemas and errors are first-class ⏳

The reflective surface is part of the API, not a debugging afterthought.

- Every new error variant ships with a `retryable` flag and a repair hint (what failed, why, how to fix).
- Every new descriptor kind (component / resource / event) is enumerable through a typed `describe*`
  surface, and `world.describe()` is the root that composes them into a `WorldManifest`.

**Enforcement status:** the `describe*` family + `world.describe()` land in Phase 3; the error half
shipped in the v1.0 break (Phase 2) — every `DomecsError` variant carries `retryable`, plus
`getErrorRepairHint`, the `ERROR_KINDS` const, and `isKnownDomecsErrorKind`. Until the `describe*`
sweep lands, any new descriptor must already be authored in this shape so it is mechanical.

**Checklist:** New error → has `retryable` + repair hint? New descriptor kind → reachable through a
typed `describe*`, not an ad-hoc field reach-in?

---

## L3 — One naming language, published as law ✅

The whole surface speaks one verb language; the name encodes return cardinality and cost. No
single-module change may reintroduce a sixth accessor shape.

| Category | Rule |
|----------|------|
| Reads | `get*` (singular, `X \| undefined`) · `count*` (→ number) · `list*` (→ eager array) · `select*` (→ hydrated views) |
| Lazy reads | `iter*` (→ lazy `Iterable`) |
| Descriptors vs instances | `define*` = descriptor · `create*` = live/effectful instance |
| Mutation | `add` = first attach · `set` = replace-or-create · `mark*Changed` = signal without replace |
| RNG | one `uniform*` family (`uniform`/`uniformInt`/`uniformRange`/`uniformRoll`; keep `pick`/`fork`/`seed`) |
| Temporal query nodes | `On*` (e.g. `OnAdded`, `OnChanged`) — illegal in one-shot selectors; bare PascalCase (`Has`/`Where`/`Not`/`And`/`Or`) is structural/logical |

**Enforcement status:** the exhaustive rename sweep shipped in the v1.0 break (Phase 2; full table in
design spec §4) — `get*`/`count*`/`list*`/`select*`/`iter*` reads, the `uniform*` RNG family, and the
`On*` temporal nodes are now the surface. A new accessor must fit one of the shapes above.

**Checklist:** Does each new name fit the verb language and encode its cardinality/cost? Did this
change avoid inventing a new accessor shape?

---

## L4 — Prove invalid states unrepresentable (prove > check > witness) ✅

Encode each rule at the strongest rung the situation supports, and degrade gracefully:
**prove** it in the type → **check** it at the boundary with a fix-oriented error → **witness** it
with a runnable example.

- Options that fork behavior are discriminated unions, not optional boolean flags.
- Registration-time or call-time throws are a last resort, not the design. If the type can make the
  wrong call unrepresentable, do that instead.

**Enforcement status:** the type-strengthening pass shipped in the v1.0 break (Phase 2; design spec §5)
— `SystemDef` is a discriminated union on `schedule`, `ChangedOn` replaces the `changedOn` tri-state,
`mountDOM` returns `Result`, and the one-shot selectors reject `On*` nodes at compile time via a
negative brand. The principle governs every new type.

**Checklist:** Could an invalid combination be made unrepresentable in the type rather than caught at
runtime? Is any new behavior fork a discriminated union rather than a flag?

---

## L5 — Closed sets are enumerable; the constructor↔discriminant mapping is explicit ✅

Anything with a fixed set of valid values is a closed, enumerable set — never a free-form string.

- Every discriminated union exports its `kind` set as a `const` (e.g. `ERROR_KINDS`, `QueryNodeKind`).
- Where constructors produce tagged values, ship the constructor→`kind` mapping explicitly so it is
  visible, not inferred.

**Enforcement status:** the exported `kind` constants shipped with their unions in the v1.0 break
(Phase 2) — `ERROR_KINDS` and `QueryNodeKind` are both exported consts. New closed sets must be
authored as enumerable consts from the start.

**Checklist:** Is every fixed-value parameter a closed set, not a magic string? Does each new union
export its `kind` set as a const?

---

## L6 — Examples are tested documentation ⏳

Agents copy examples far more than they parse prose.
A drifted example teaches the wrong thing confidently, so examples are tested.

- Every public entry point gets at least one runnable example: a happy path and the error path.
- Examples explicitly cover each behavioral branch (tick-delay events, the `changedOn` modes, reactive entities-as-delta) so they cannot drift from the shipped types.

**Enforcement status:** snippet-CI'd doctests land in Phase 4. Until then, new public entry points
should carry a runnable example in their docs or tests.

**Checklist:** Does each new public entry point have a runnable, branch-covering example? Is it under
test (or queued for the Phase 4 snippet-CI) so it cannot rot?

---

## The one-line version

> Put everything needed to use it — and every way it can fail — where the reader already is, spell
> each action exactly one way, and make the error tell you how to fix it. Everything else is a
> corollary.
