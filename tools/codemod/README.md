# domecs v1.0 Codemod

A [jscodeshift](https://github.com/facebook/jscodeshift) transform that mechanically
migrates consumer code to the domecs v1.0 API.

## Usage

```sh
# From the domecs workspace root:
pnpm codemod <path-to-source-dir-or-file>

# Dry run (print only, no writes):
node node_modules/jscodeshift/bin/jscodeshift.js \
  --parser=tsx --dry --print \
  -t tools/codemod/domecs-v1.cjs \
  ../my-app/src
```

## What the codemod does

### Auto-edits (safe — always applied)

| Old | New | Notes |
|---|---|---|
| `import { Added }` from `@domecs/*` | `import { OnAdded }` | + renames all bound references |
| `import { Removed }` | `import { OnRemoved }` | + renames all bound references |
| `import { Changed }` | `import { OnChanged }` | + renames all bound references |
| `import { ChangedResource }` | `import { OnChangedResource }` | + renames all bound references |
| `.step()` (zero args) | `.stepOnce()` | `.step(dt)` is **unchanged** |

The import rename also renames every identifier reference *bound to that import* throughout
the file. It is AST-based: it will NOT corrupt `markChanged` (a function that happens to
contain "Changed"), nor a local variable named `Changed` imported from a non-domecs module.

### Guarded member renames (applied when receiver is determinable)

These method names are too common to rename blindly (e.g. `.select()` exists on DOM elements,
`.count()` on many data structures). The codemod only renames them when it can statically
determine the receiver is a domecs World or Rng object.

**World methods:**

| Old | New |
|---|---|
| `.resource(` | `.getResource(` |
| `.count(` | `.countEntities(` |
| `.entitiesMatching(` | `.listEntities(` |
| `.select(` | `.selectViews(` |
| `.entitiesWith(` | `.iterEntitiesWith(` |
| `.start(` | `.startLoop(` |

**Rng methods:**

| Old | New |
|---|---|
| `.next(` | `.uniform(` |
| `.int(` | `.uniformInt(` |
| `.range(` | `.uniformRange(` |
| `.roll(` | `.uniformRoll(` |

When the receiver is **NOT** determinable, the call is **left unchanged** and a
`// CODEMOD-REVIEW:` comment is inserted on the line above for manual inspection.

### Receiver guard heuristic

A receiver is treated as a **domecs World** if the receiver expression is:
1. An `Identifier` named exactly `world`, or matching the pattern `/[Ww]orld$/`
   (e.g. `gameWorld`, `myWorld`).
2. An `Identifier` whose binding resolves to a `VariableDeclarator` with an initializer
   that is a `CallExpression` whose callee ends with `createWorld` or `/[Ww]orld$/`.
3. A `MemberExpression` whose property name is `world` or matches `/[Ww]orld$/`
   (e.g. `this.world.count(...)`, `ctx.gameWorld.select(...)`).

A receiver is treated as a **domecs Rng** if:
1. An `Identifier` named exactly `rng`, or matching `/[Rr]ng$/`.
2. An `Identifier` whose binding resolves to a `VariableDeclarator` whose initializer
   is a `CallExpression` with callee `createRng`, `restoreRng`, or `fork`.
3. A `MemberExpression` whose property is `rng` or matches `/[Rr]ng$/`.

**Bias:** when in doubt, the codemod flags rather than edits. False positives (flagging a
non-domecs call) are safe to dismiss; false negatives (silently mis-editing a non-domecs
call) would corrupt code.

### Flag-only (CODEMOD-REVIEW comment, never auto-edited)

These changes require human judgment and are only annotated with a `// CODEMOD-REVIEW:`
comment immediately above the relevant line:

| Pattern | Reason |
|---|---|
| `mountDOM(...)` calls | Now returns `Result<MountHandle, MountError>`; callers must unwrap `.value` / check `isOk()` |
| `changedOn: [...]` (array literal) | Must be migrated to `{mode:'legacy'}` or `{mode:'explicit',types:[...]}` |
| `DomecsError` in `new`/call/member | Construction and match arms now require a `retryable` field |
| `SystemDef` with `schedule` + `rateHz`/`triggers`/`reactsTo` | Field combo validity depends on schedule type; must be verified |

## Self-test

```sh
node --test tools/codemod/codemod.test.mjs
```

9 tests cover: full fixture round-trip, `markChanged` survival, `.step(dt)` survival,
import renames, flag comments for `mountDOM`/`changedOn`, and guarded method renames.

## Fixtures

- `__fixtures__/before.tsx` — representative input covering all transform categories
- `__fixtures__/after.tsx` — expected output after the transform is applied

## Coverage matrix

See `doc/phase2-coverage-matrix.md` for per-repo counts across all 8 lockstep consumers.
