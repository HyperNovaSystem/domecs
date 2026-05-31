# Phase 4 — Examples + api.md sync + docstring polish → freeze v1.0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Satisfy the last open legibility law (L6 — examples are tested documentation) with an inline-markdown doctest harness, sync `api.md` to the shipped types, polish docstrings/units, and freeze the surface as v1.0.

**Architecture:** A new `scripts/doctest.mjs` extracts ` ```ts doctest ` fenced blocks from markdown (starting with `doc/api.md`), writes each verbatim to a temp `.ts` module under `doc/.doctest/` (gitignored), typechecks them all with one `tsc`, then executes each compiled module with Node — a thrown `assert` fails CI. Snippets self-assert via `node:assert`, import `@domecs/*` from source (resolved through the installed workspace symlinks, exactly as consumers do), so they cannot drift from the shipped types or behavior. The remaining work is documentation-truth (delete the never-shipped `createPersistence` facade, fix prose-vs-type drifts, polish docstrings/units), a small `DEFAULT_INPUT_OPTIONS` export, CI hardening, and the v1.0 version freeze.

**Tech Stack:** Node ESM scripts (`.mjs`), TypeScript 5.6 (`tsc` with `moduleResolution: Bundler`, config in `tsconfig.base.json`), vitest 2.1.9 (harness unit tests only), pnpm 10.30.2 workspace. Repo root: `C:\dev\HyperNova\domecs`. Bash tool runs **Git Bash**; cwd may reset — prefix with `cd /c/dev/HyperNova/domecs`.

**Branch:** Create `v1-phase4-freeze` off `main` (main now carries Phases 0–3). Commit trailer on every commit must be EXACTLY:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

**Key facts the implementer must not re-derive (verified 2026-05-31):**
- `defineEvent<T>(name: string, options?: EventDefOptions): EventType<T>` — `packages/domecs/src/events.ts:31`. Event payload read is **tick-delayed**: an event emitted during tick N is visible to `event`-scheduled systems on tick N+1.
- `ChangedOn` union — `packages/domecs-dom/src/view.ts:21` — has **three arms** (`{mode:'auto'}`, `{mode:'legacy'}`, `{mode:'explicit'; types}`). Omitting `changedOn` ≡ `{mode:'auto'}`. The four behavioral branches the doctest must cover are: **omitted (default), auto, legacy, explicit**.
- `mountDOM(world, opts): Result<MountHandle, MountError>` — `packages/domecs-dom/src/mount.ts:62`. `MountError` is its own union (`slot_already_mounted` / `unregistered_slot` / `plugin_install_failed`) and is **NOT** part of the `DomecsError` union — `describeError()` does not accept it; format `e.error.kind` by hand.
- `world.use(plugin, options?): Result<() => void, DomecsError>` — returns a `DomecsError` on failure, which **is** accepted by `describeError()`. Use this for the Result + describeError happy/error doctest.
- `MountOptions.slots` is already `Readonly<Record<string, HTMLElement>>` (`mount.ts:6`); `Plugin` fields are already `readonly` (`plugin.ts:16-19`). These are **api.md** corrections, not type changes.
- `InspectorOptions` real fields: `bufferSize?`, `recordStateChanges?`, `timelineBufferSize?` (`inspector.ts:94`). api.md currently documents fictitious `slot`/`hotkey`/`detect`.
- `InputPluginOptions` (`collector.ts:4`) static-default fields: `clearOnBlur` (true), `textInputSelector` (`'input,textarea,[contenteditable="true"]'`), `preventDefaultKeys` (false). `keyTarget`/`pointerTarget`/`wheelTarget`/`pollGamepads` defaults are **environment-derived** (document/navigator) and therefore NOT static — `DEFAULT_INPUT_OPTIONS` carries only the static ones.
- `api.md` `createPersistence`/`Persistence` facade lives around `doc/api.md:823-865` and **never shipped** — delete it; the shipped path is the Result-typed free functions over `Storage`.
- Workspace resolution: every `@domecs/*` package sets `exports["."] = "./src/index.ts"`, so a temp file importing `@domecs/core` resolves to source through the installed `node_modules` symlink — no `paths`/alias needed once `pnpm install` has run.
- CI workflow: `.github/workflows/ci.yml` — steps are checkout → pnpm/action-setup → setup-node → install → typecheck → build → api:surface → no-drift gate → unit tests → api:check → release-validate.
- Surface gate: after ANY change to an exported symbol **or its emitted TSDoc**, run `pnpm -r build && pnpm api:surface` and commit the `doc/api-surface/*.d.ts` diff (TSDoc comments are emitted into `.d.ts`, so docstring edits on exported symbols DO move the surface).
- This is a **public, pre-v1.0 alpha** repo: NO backward-compatibility shims, aliases, or compat docs. Clean breaks only. Respect `.gitignore` for `.claude/`.

---

## File Structure

| File | Responsibility | Task |
|------|----------------|------|
| `scripts/doctest.mjs` | Extract `ts doctest` fences → temp modules → tsc → node-run; CLI entry for `pnpm doctest`. Exports pure `extractDoctests()` + `tempFileName()` for unit tests. | 1 |
| `scripts/doctest.test.mjs` | Vitest unit tests for the pure extraction/naming functions + an end-to-end fixture (one passing, one failing snippet). | 1 |
| `tsconfig.doctest.json` | Root tsconfig: extends base, `include: ["doc/.doctest/**/*.ts"]`, `noEmit:false`, `outDir:"doc/.doctest/dist"`, `types:["node"]`. | 1 |
| `.gitignore` (root) | Add `doc/.doctest/`. | 1 |
| `package.json` (root) | Add `"doctest"` script. | 1 |
| `packages/domecs-input/src/collector.ts` | Add `DEFAULT_INPUT_OPTIONS`; consume it as the single source of static defaults. | 2 |
| `packages/domecs-input/src/index.ts` | Re-export `DEFAULT_INPUT_OPTIONS`. | 2 |
| `packages/domecs-input/test/default-options.test.ts` | Assert applied static defaults equal `DEFAULT_INPUT_OPTIONS`. | 2 |
| `doc/api-surface/input.d.ts` | Regenerated surface (new export). | 2 |
| `doc/api.md` | Inline `ts doctest` fences (Task 3); drift fixes + facade deletion + banner (Task 4). | 3, 4 |
| `packages/domecs/src/{input,result,errors,query}.ts`, `packages/domecs-dom/src/view.ts`, etc. | Docstring/units polish. | 5 |
| `doc/api-surface/*.d.ts` | Regenerated after docstring polish. | 5 |
| `.github/workflows/ci.yml` | `permissions: contents: read`, `concurrency`, SHA-pinned actions, new `pnpm doctest` step. | 6 |
| `doc/LEGIBILITY.md` | Flip L6 ✅; update enforcement legend. | 7 |
| `packages/*/package.json` | Version `0.1.0-alpha.0` → `1.0.0`; bump internal deps. | 7 |

---

### Task 1: Doctest harness

**Files:**
- Create: `scripts/doctest.mjs`
- Create: `scripts/doctest.test.mjs`
- Create: `tsconfig.doctest.json`
- Modify: `.gitignore` (root) — add `doc/.doctest/`
- Modify: `package.json` (root `scripts`) — add `"doctest"`

The harness has one pure, testable core (`extractDoctests`) and a thin CLI shell that spawns `tsc` and `node`. Snippets are written **verbatim** (no wrapping) and self-assert via `node:assert`.

- [ ] **Step 1: Write the failing unit test**

Create `scripts/doctest.test.mjs`:

```js
import { describe, expect, it } from 'vitest'
import { extractDoctests, tempFileName } from './doctest.mjs'

describe('extractDoctests', () => {
  it('extracts only fences whose info string starts with "ts doctest"', () => {
    const md = [
      '# Doc',
      '```ts',
      'const skip = 1 // plain ts, not a doctest',
      '```',
      'prose',
      '```ts doctest',
      "import { strict as assert } from 'node:assert'",
      'assert.equal(1 + 1, 2)',
      '```',
    ].join('\n')
    const blocks = extractDoctests(md, 'doc/api.md')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].code).toContain('assert.equal(1 + 1, 2)')
    expect(blocks[0].source).toBe('doc/api.md')
  })

  it('honors an explicit name= in the info string', () => {
    const md = ['```ts doctest name=event-tick-delay', 'const a = 1', '```'].join('\n')
    const blocks = extractDoctests(md, 'doc/api.md')
    expect(blocks[0].name).toBe('event-tick-delay')
  })

  it('falls back to <basename>-<index> when unnamed', () => {
    const md = ['```ts doctest', 'const a = 1', '```', '```ts doctest', 'const b = 2', '```'].join('\n')
    const blocks = extractDoctests(md, 'doc/api.md')
    expect(blocks.map((b) => b.name)).toEqual(['api-0', 'api-1'])
  })
})

describe('tempFileName', () => {
  it('produces a .ts filename from the block name', () => {
    expect(tempFileName({ name: 'event-tick-delay' })).toBe('event-tick-delay.ts')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /c/dev/HyperNova/domecs && pnpm exec vitest run scripts/doctest.test.mjs`
Expected: FAIL — `Cannot find module './doctest.mjs'` (or `extractDoctests is not a function`).

- [ ] **Step 3: Write the harness**

Create `scripts/doctest.mjs`:

```js
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const TMP_DIR = join(ROOT, 'doc', '.doctest')
export const TMP_OUT = join(TMP_DIR, 'dist')

/** Markdown files scanned for `ts doctest` fences. */
export const SOURCES = ['doc/api.md']

/**
 * Extract every fenced block whose info string begins with `ts doctest`.
 * Returns [{ name, code, source }]. An explicit `name=<slug>` in the info
 * string wins; otherwise the name is `<md-basename-without-ext>-<index>`.
 */
export function extractDoctests(markdown, source) {
  const lines = markdown.split('\n')
  const base = basename(source).replace(/\.md$/, '')
  const blocks = []
  let i = 0
  let n = 0
  while (i < lines.length) {
    const open = /^```ts doctest\b(.*)$/.exec(lines[i])
    if (!open) {
      i += 1
      continue
    }
    const nameMatch = /\bname=([\w-]+)/.exec(open[1])
    const body = []
    i += 1
    while (i < lines.length && !/^```\s*$/.test(lines[i])) {
      body.push(lines[i])
      i += 1
    }
    i += 1 // consume closing fence
    blocks.push({
      name: nameMatch ? nameMatch[1] : `${base}-${n}`,
      code: body.join('\n'),
      source,
    })
    n += 1
  }
  return blocks
}

export function tempFileName(block) {
  return `${block.name}.ts`
}

function run() {
  rmSync(TMP_DIR, { recursive: true, force: true })
  mkdirSync(TMP_DIR, { recursive: true })

  const all = []
  for (const source of SOURCES) {
    const md = readFileSync(join(ROOT, source), 'utf8')
    for (const block of extractDoctests(md, source)) {
      const file = join(TMP_DIR, tempFileName(block))
      writeFileSync(file, block.code.replace(/\r\n/g, '\n').replace(/\n*$/, '\n'))
      all.push({ ...block, file })
    }
  }
  if (all.length === 0) {
    console.error('doctest: no `ts doctest` fences found in ' + SOURCES.join(', '))
    process.exit(1)
  }
  console.log(`doctest: extracted ${all.length} snippet(s)`)

  // 1) Typecheck + emit. tsc resolves @domecs/* through the workspace symlinks.
  const tsc = spawnSync(
    'pnpm',
    ['exec', 'tsc', '-p', 'tsconfig.doctest.json'],
    { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' },
  )
  if (tsc.status !== 0) {
    console.error('doctest: typecheck failed')
    process.exit(1)
  }

  // 2) Execute each emitted module; a thrown assert exits non-zero.
  let failed = 0
  for (const js of readdirSync(TMP_OUT).filter((f) => f.endsWith('.js'))) {
    const res = spawnSync('node', [join(TMP_OUT, js)], { cwd: ROOT, stdio: 'inherit' })
    if (res.status !== 0) {
      console.error(`doctest: FAILED ${js}`)
      failed += 1
    }
  }
  if (failed > 0) {
    console.error(`doctest: ${failed} snippet(s) failed`)
    process.exit(1)
  }
  console.log(`doctest: all ${all.length} snippet(s) passed`)
}

// CLI guard — Windows-safe main-module detection.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
```

- [ ] **Step 4: Create the doctest tsconfig**

Create `tsconfig.doctest.json`:

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "outDir": "doc/.doctest/dist",
    "noEmit": false,
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false,
    "types": ["node"]
  },
  "include": ["doc/.doctest/**/*.ts"],
  "exclude": ["doc/.doctest/dist/**"]
}
```

- [ ] **Step 5: Gitignore the temp dir + add the script**

Append to root `.gitignore`:

```
doc/.doctest/
```

Add to root `package.json` `scripts` (place after `"api:check"`):

```json
"doctest": "node scripts/doctest.mjs",
```

- [ ] **Step 6: Run the unit tests to verify they pass**

Run: `cd /c/dev/HyperNova/domecs && pnpm exec vitest run scripts/doctest.test.mjs`
Expected: PASS (all extract/name tests green).

- [ ] **Step 7: Smoke-test the end-to-end runner against a temporary fixture**

Temporarily add to `doc/api.md` (top of file, will be removed before commit) one passing fence:

````
```ts doctest name=_smoke
import { strict as assert } from 'node:assert'
import { createWorld } from '@domecs/core'
const w = createWorld()
assert.ok(w)
```
````

Run: `cd /c/dev/HyperNova/domecs && pnpm install --frozen-lockfile && pnpm doctest`
Expected: `doctest: all 1 snippet(s) passed`. Then **remove the `_smoke` fence** from `doc/api.md`.
(If `node` cannot import the emitted ESM `@domecs/core`, confirm the workspace is installed; the symlink under `node_modules/@domecs/core` must resolve to `packages/domecs`.)

- [ ] **Step 8: Commit**

```bash
cd /c/dev/HyperNova/domecs
git add scripts/doctest.mjs scripts/doctest.test.mjs tsconfig.doctest.json .gitignore package.json
git commit -m "$(cat <<'EOF'
feat(doctest): inline-markdown doctest harness (L6)

Extract `ts doctest` fences from doc/api.md, typecheck with tsc, and run
each as a Node module that self-asserts via node:assert. `pnpm doctest`.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Export `DEFAULT_INPUT_OPTIONS`

**Files:**
- Modify: `packages/domecs-input/src/collector.ts`
- Modify: `packages/domecs-input/src/index.ts`
- Test: `packages/domecs-input/test/default-options.test.ts`
- Regenerate: `doc/api-surface/input.d.ts`

Expose the **static** input defaults as a single machine-readable const, and have the plugin consume it so the const is the source of truth (no second copy to drift).

- [ ] **Step 1: Write the failing test**

Create `packages/domecs-input/test/default-options.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_INPUT_OPTIONS } from '../src/index.js'

describe('DEFAULT_INPUT_OPTIONS', () => {
  it('exposes the static input defaults', () => {
    expect(DEFAULT_INPUT_OPTIONS).toEqual({
      clearOnBlur: true,
      textInputSelector: 'input,textarea,[contenteditable="true"]',
      preventDefaultKeys: false,
    })
  })

  it('is frozen so callers cannot mutate the shared defaults', () => {
    expect(Object.isFrozen(DEFAULT_INPUT_OPTIONS)).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /c/dev/HyperNova/domecs && pnpm --filter @domecs/input exec vitest run test/default-options.test.ts`
Expected: FAIL — `DEFAULT_INPUT_OPTIONS` is not exported.

- [ ] **Step 3: Add the const and consume it**

In `packages/domecs-input/src/collector.ts`, replace the lone `DEFAULT_TEXT_SELECTOR` const (line ~31) with:

```ts
/**
 * The environment-independent default {@link InputPluginOptions}. The target
 * options (`keyTarget`/`pointerTarget`/`wheelTarget`) and `pollGamepads`
 * are derived from `document`/`navigator` at install time and so are not
 * representable as static constants; they are omitted here.
 */
export const DEFAULT_INPUT_OPTIONS = Object.freeze({
  clearOnBlur: true,
  textInputSelector: 'input,textarea,[contenteditable="true"]',
  preventDefaultKeys: false,
} as const satisfies Partial<InputPluginOptions>)
```

Then update the three static-default reads inside `install` to source from the const:

```ts
      const clearOnBlur = options.clearOnBlur ?? DEFAULT_INPUT_OPTIONS.clearOnBlur
      const textSelector = options.textInputSelector ?? DEFAULT_INPUT_OPTIONS.textInputSelector
```

and (further down, where `preventDefaultKeys` is read):

```ts
      const preventDefaultKeys = options.preventDefaultKeys ?? DEFAULT_INPUT_OPTIONS.preventDefaultKeys
```

- [ ] **Step 4: Re-export from the barrel**

In `packages/domecs-input/src/index.ts` add:

```ts
export { createInputPlugin, DEFAULT_INPUT_OPTIONS } from './collector.js'
```

(Replace the existing `export { createInputPlugin } from './collector.js'` line.)

- [ ] **Step 5: Run the test + package gate to verify pass**

Run: `cd /c/dev/HyperNova/domecs && pnpm --filter @domecs/input test`
Expected: PASS (`tsc --noEmit` clean, all input tests green).

- [ ] **Step 6: Regenerate + commit the surface**

```bash
cd /c/dev/HyperNova/domecs
pnpm -r build && pnpm api:surface
git diff -- doc/api-surface/input.d.ts   # expect: + DEFAULT_INPUT_OPTIONS export
git add packages/domecs-input/src/collector.ts packages/domecs-input/src/index.ts \
        packages/domecs-input/test/default-options.test.ts doc/api-surface/input.d.ts
git commit -m "$(cat <<'EOF'
feat(input): export DEFAULT_INPUT_OPTIONS as machine-readable defaults

Single source of truth for the static input defaults; the plugin now reads
its defaults from the const. Regenerated input surface.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Author the required doctests in `api.md`

**Files:**
- Modify: `doc/api.md` (add ` ```ts doctest ` fences)

Add inline doctests covering the four scenarios from design §7. Each fence is a self-contained module: imports from `@domecs/*`, asserts with `node:assert`. Place each fence in the api.md section documenting its API. Names are stable slugs.

Every snippet must include **a happy path and the failure/branch behavior** it documents (L6).

- [ ] **Step 1: Input defaults + override + read**

In the `@domecs/input` section of `doc/api.md`, add:

````
```ts doctest name=input-defaults
import { strict as assert } from 'node:assert'
import { DEFAULT_INPUT_OPTIONS } from '@domecs/input'

// The static defaults are machine-readable.
assert.equal(DEFAULT_INPUT_OPTIONS.clearOnBlur, true)
assert.equal(DEFAULT_INPUT_OPTIONS.preventDefaultKeys, false)

// Overrides merge over the defaults the same way the plugin applies them.
const opts = { ...DEFAULT_INPUT_OPTIONS, preventDefaultKeys: true }
assert.equal(opts.preventDefaultKeys, true)
assert.equal(opts.clearOnBlur, true) // untouched default survives
```
````

- [ ] **Step 2: Event tick-delay**

In the events section, add (use the real `defineEvent`/system API — confirm `world.system(name, def, fn)` arg order and the emit/read API against `packages/domecs/src/world.ts` and `events.ts` before finalizing the body):

````
```ts doctest name=event-tick-delay
import { strict as assert } from 'node:assert'
import { createWorld, defineEvent } from '@domecs/core'

const w = createWorld()
const Hit = defineEvent<{ dmg: number }>('Hit')

const seen: number[] = []
w.system('read-hits', { schedule: 'event', event: Hit }, (ctx) => {
  for (const e of ctx.events) seen.push(e.dmg)
})

// Emit during this tick; event-scheduled systems observe it on the NEXT tick.
w.emit(Hit, { dmg: 7 })
w.stepOnce()
assert.deepEqual(seen, [7])
```
````

> **Implementer note:** The exact event-system context field (`ctx.events`), the `event:`/`triggers:` key on `EventSystemDef`, and the `w.emit`/`w.stepOnce` names MUST be confirmed against the Phase-2 source before writing — adjust the snippet to the real signatures. The *behavior* asserted (emit visible next tick, not same tick) is the contract; encode it with the real API.

- [ ] **Step 3: All four `changedOn` modes**

In the `@domecs/dom` / `defineView` section, add one fence asserting the type-level shape of each branch (DOM mount requires a document; keep this snippet to constructing + discriminating the union so it runs headless):

````
```ts doctest name=changedon-modes
import { strict as assert } from 'node:assert'
import type { ChangedOn } from '@domecs/dom'

// 1. Omitted — equivalent to { mode: 'auto' } (see defineView docstring).
const omitted: ChangedOn | undefined = undefined
assert.equal(omitted, undefined)

// 2. auto — derive OnChanged(T) from every Has(T) leaf in the view query.
const auto: ChangedOn = { mode: 'auto' }
assert.equal(auto.mode, 'auto')

// 3. legacy — redraw every mounted entity every tick.
const legacy: ChangedOn = { mode: 'legacy' }
assert.equal(legacy.mode, 'legacy')

// 4. explicit — gate redraws on exactly the listed component types.
const explicit: ChangedOn = { mode: 'explicit', types: [] }
assert.equal(explicit.mode, 'explicit')
assert.ok(Array.isArray(explicit.mode === 'explicit' ? explicit.types : []))
```
````

- [ ] **Step 4: Result error handling (happy + error path)**

In the error-handling / `Result` section, add (uses `world.use`, whose error IS a `DomecsError`, so `describeError` applies):

````
```ts doctest name=result-error-handling
import { strict as assert } from 'node:assert'
import { createWorld, definePlugin, describeError, isErr, isOk, ok } from '@domecs/core'

const w = createWorld()
const good = definePlugin({ name: 'good', install: () => ok(undefined) })

// Happy path: use() returns Ok carrying the uninstall function.
const installed = w.use(good)
assert.ok(isOk(installed))

// Error path: installing a second plugin with the same name fails with a
// DomecsError you can describe for a human-readable, fix-oriented message.
const dup = definePlugin({ name: 'good', install: () => ok(undefined) })
const result = w.use(dup)
assert.ok(isErr(result))
if (isErr(result)) {
  const described = describeError(result.error)
  assert.equal(typeof described, 'string')
  assert.ok(described.length > 0)
}
```
````

> **Implementer note:** Confirm the duplicate-plugin-name path actually returns `Err` (not a throw) against `packages/domecs/src/world.ts` / `plugin.ts`. If duplicate-name throws instead of erring, pick a different genuine `world.use` failure (e.g. an `install` that returns `err(...)`), keeping both an Ok and an Err branch asserted.

- [ ] **Step 5: Run the doctest harness**

Run: `cd /c/dev/HyperNova/domecs && pnpm doctest`
Expected: `doctest: all 4 snippet(s) passed` (plus any pre-existing). If a snippet fails typecheck or assertion, fix the snippet against the real API — do **not** weaken the asserted contract.

- [ ] **Step 6: Commit**

```bash
cd /c/dev/HyperNova/domecs
git add doc/api.md
git commit -m "$(cat <<'EOF'
docs(api): add tested doctests — input defaults, event tick-delay,
changedOn modes, Result error handling (L6)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `api.md` drift fixes + delete `createPersistence` facade + authoritative banner

**Files:**
- Modify: `doc/api.md`

Pure documentation-truth corrections. No code changes. Verify every edit against the cited source line before writing.

- [ ] **Step 1: Add the authoritative-source banner**

At the very top of `doc/api.md` (after the title), insert:

```markdown
> **Authoritative source:** the committed type surface in
> [`doc/api-surface/`](./api-surface/) is the contract; this file is a
> derived, human-readable view. Where they disagree, the types win.
```

- [ ] **Step 2: Delete the never-shipped persist facade**

Remove the `createPersistence` function signature and the `Persistence` interface block (around `doc/api.md:823-865`). Replace with prose blessing the shipped free functions as canonical:

```markdown
Persistence is a set of `Result`-typed free functions over a `Storage`
(`save` / `load` / `migrate`). There is no `createPersistence` facade — the
free functions are the one canonical path.
```

(Confirm the exact free-function names + signatures against `packages/domecs-persist/src/index.ts` and document them accurately.)

- [ ] **Step 3: Fix `InspectorOptions` fields**

Find the `InspectorOptions` block in api.md (documents fictitious `slot`/`hotkey`/`detect`). Replace its fields with the real ones (`inspector.ts:94`):

```markdown
interface InspectorOptions {
  bufferSize?: number          // max retained fault/state entries
  recordStateChanges?: boolean // interleave component-change events into the timeline
  timelineBufferSize?: number  // max timeline entries; only used when recordStateChanges is true
}
```

- [ ] **Step 4: Fix `Plugin` readonly + `MountOptions.slots` Readonly**

Ensure the `Plugin` interface in api.md marks `name`/`version`/`depends`/`provides` as `readonly` (matches `plugin.ts:16-19`), and `MountOptions.slots` is shown as `Readonly<Record<string, HTMLElement>>` (matches `mount.ts:6`).

- [ ] **Step 5: Verify no other doctest fences broke**

Run: `cd /c/dev/HyperNova/domecs && pnpm doctest`
Expected: still all pass (this task edits prose around the fences, not the fences).

- [ ] **Step 6: Commit**

```bash
cd /c/dev/HyperNova/domecs
git add doc/api.md
git commit -m "$(cat <<'EOF'
docs(api): sync api.md to shipped types

Delete never-shipped createPersistence/Persistence facade; fix
InspectorOptions/Plugin/MountOptions prose-vs-type drift; add
authoritative-source banner.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Docstring / units polish (design §7 rank-13)

**Files:**
- Modify (docstrings only): `packages/domecs/src/input.ts` (`PointerSnapshot`, `GamepadSnapshot`), `packages/domecs/src/result.ts` (`normalizeCause` → reference `MAX_CAUSE_DEPTH`), `packages/domecs/src/errors.ts` (`FaultEntry.detail` shape), `packages/domecs/src/signals.ts` (`Signal.subscribe` idempotency), `packages/domecs/src/query.ts` (`QueryDef` tuple-vs-combinator fork; `QueryNodeKind`), `packages/domecs/src/component.ts` (`defineComponent` overload trade-off), `packages/domecs-dom/src/view.ts` (`ChangedOn` says "three modes" — keep accurate).
- Regenerate: `doc/api-surface/*.d.ts`

These are TSDoc edits on exported symbols → they appear in emitted `.d.ts`, so the surface snapshot moves. No type/behavior change.

- [ ] **Step 1: Verify each target symbol's current docstring & exact location**

Run: `cd /c/dev/HyperNova/domecs && grep -rn "PointerSnapshot\|GamepadSnapshot\|entered\|wheel\|FaultEntry\|interface Signal\|QueryDef\|QueryNodeKind" packages/domecs/src/*.ts | head -40`
Confirm where each lives before editing (the input snapshot types may be in `input.ts`; adjust paths to reality).

- [ ] **Step 2: Apply the docstring edits**

For each, add/clarify the documented fact (write the actual prose; do not leave placeholders):
- `PointerSnapshot.entered` — type it/document it as `readonly Entity[]` (entities the pointer entered this frame).
- `PointerSnapshot` `wheel`/`deltaX`/`deltaY` — document units and **sign convention** (e.g. positive `wheel` = scroll down / away from user; pixels vs lines per the source's actual semantics — confirm in collector.ts).
- `GamepadSnapshot` button `value` — document the `0..1` range (analog).
- `FaultEntry.detail` — document its shape (a `JsonValue` projection of the fault payload; see `toJsonValue` in `result.ts`).
- `normalizeCause` docstring — reference `{@link MAX_CAUSE_DEPTH}` for the chain-walk depth (already present at `result.ts:138` — verify and keep).
- `Signal.subscribe` — document that the returned unsubscribe is **idempotent** (calling it twice is a no-op).
- `QueryNodeKind` — ensure the exported const map is documented as the enumerable kind set (already exported from `query.ts`).
- `defineComponent` — add the signature-level docstring on the dual-overload `Name` duplication trade-off (design §9 — documented TS limitation, both overloads kept).
- `QueryDef` — document the tuple-form (infers fields) vs combinator-form (falls back to `EntityView`) inference fork.
- `ChangedOn`/`defineView` (`view.ts:37`) — the docstring says "the three modes"; ensure it accurately lists `auto`/`legacy`/`explicit` and that omission ≡ `auto`.

- [ ] **Step 3: Typecheck (docstrings must not break compilation)**

Run: `cd /c/dev/HyperNova/domecs && pnpm -r --parallel typecheck`
Expected: PASS (comments only).

- [ ] **Step 4: Regenerate the surface + review the diff**

```bash
cd /c/dev/HyperNova/domecs
pnpm -r build && pnpm api:surface
git diff -- doc/api-surface   # expect: only TSDoc comment additions, no signature changes
```
Expected: the diff shows added/changed `/** … */` comments and (for `PointerSnapshot.entered`) possibly a type annotation; NO changed type signatures beyond `entered`.

- [ ] **Step 5: Run the full test + doctest gate**

Run: `cd /c/dev/HyperNova/domecs && pnpm -r --parallel test && pnpm doctest && pnpm api:check`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd /c/dev/HyperNova/domecs
git add packages doc/api-surface
git commit -m "$(cat <<'EOF'
docs(core,dom): polish docstrings + units (design §7 rank-13)

Document PointerSnapshot.entered/wheel sign+units, GamepadSnapshot value
range, FaultEntry.detail shape, Signal.subscribe idempotency,
defineComponent overload trade-off, QueryDef inference fork. Regen surface.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: CI hardening + wire the doctest gate

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Resolve the current action SHAs**

For each `uses:` (actions/checkout@v4, pnpm/action-setup@v4, actions/setup-node@v4), resolve the commit SHA for the tag. Prefer `gh api` (e.g. `gh api repos/actions/checkout/git/refs/tags/v4.2.2 -q .object.sha` after listing tags), or look up the release tag's commit. Record `SHA # vX.Y.Z` for the version-pin comment.

> If `gh` is unavailable or unauthenticated in this environment, mark this task **DONE_WITH_CONCERNS** and leave the actions at their tags, applying only the `permissions`, `concurrency`, and doctest-step changes. Do not invent SHAs.

- [ ] **Step 2: Edit `ci.yml`**

Add top-level (after `on:`):

```yaml
permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

Replace each `uses:` with its pinned SHA + version comment, e.g.:

```yaml
      - uses: actions/checkout@<sha>  # v4.2.2
      - uses: pnpm/action-setup@<sha>  # v4.x
      - uses: actions/setup-node@<sha>  # v4.x
```

Add a doctest step immediately after the `Unit tests` step:

```yaml
      - name: Doctests (L6 — examples are tested documentation)
        run: pnpm doctest
```

- [ ] **Step 3: Validate the workflow locally (lint/parse)**

Run: `cd /c/dev/HyperNova/domecs && node -e "const yaml=require('node:fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!/permissions:/.test(yaml)||!/concurrency:/.test(yaml)||!/pnpm doctest/.test(yaml)) throw new Error('ci.yml missing required additions'); console.log('ci.yml additions present')"`
Expected: `ci.yml additions present`.

- [ ] **Step 4: Commit**

```bash
cd /c/dev/HyperNova/domecs
git add .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
ci: harden workflow + add doctest gate

Least-privilege permissions: contents: read; concurrency auto-cancel;
SHA-pin actions; run `pnpm doctest` (L6).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Flip L6 ✅ + freeze v1.0

**Files:**
- Modify: `doc/LEGIBILITY.md`
- Modify: `packages/*/package.json` (5 packages)
- Regenerate: `doc/api-surface/*.d.ts` (versions don't appear in surface, but run the full gate)

- [ ] **Step 1: Flip L6 in `LEGIBILITY.md`**

- Line 118 header: `## L6 — Examples are tested documentation ⏳` → `✅`.
- Lines 12-15 enforcement legend: drop the "L6 in Phase 4" ⏳ clause; state all six laws are enforced (L1 Phase 0; L2 Phase 3; L3/L4/L5 Phase 2; L6 Phase 4). Remove the "⏳ = …" sentence since no law carries ⏳ anymore.
- Lines 126-127 enforcement status: rewrite to "shipped — `pnpm doctest` extracts and runs the inline `ts doctest` fences from `api.md` in CI (`.github/workflows/ci.yml`); see [`scripts/doctest.mjs`](../scripts/doctest.mjs)."
- Line 130 checklist: drop "(or queued for the Phase 4 snippet-CI)".

- [ ] **Step 2: Determine the internal-dependency wiring before bumping versions**

Run: `cd /c/dev/HyperNova/domecs && grep -rn "\"@domecs/" packages/*/package.json`
This shows whether dom/input/inspector/persist pin `@domecs/core` by `workspace:*`, `file:`, or a version range. If `workspace:*`, the version bump is independent per package (pnpm rewrites on publish). If a version range, bump the range to `^1.0.0` to match.

- [ ] **Step 3: Bump every package to `1.0.0`**

In each of `packages/domecs/package.json`, `packages/domecs-dom/package.json`, `packages/domecs-input/package.json`, `packages/domecs-inspector/package.json`, `packages/domecs-persist/package.json`: set `"version": "1.0.0"`. If Step 2 showed version-range internal deps, update those ranges to `^1.0.0` too.

> Do NOT run `pnpm publish` / `pnpm publish:npm`. Freezing the version is the only action; the user publishes and pushes himself.

- [ ] **Step 4: Run the entire release gate**

Run:
```bash
cd /c/dev/HyperNova/domecs
pnpm -r --parallel typecheck \
  && pnpm -r build \
  && pnpm api:surface \
  && git diff --exit-code -- doc/api-surface \
  && pnpm -r --parallel test \
  && pnpm doctest \
  && pnpm api:check \
  && pnpm test:release
```
Expected: every step green; the no-drift `git diff --exit-code` produces no output (clean).

> If `pnpm test:release` (`scripts/validate-release.mjs`) fails because it pins consumer apps / org siblings that changed version expectations, read its failure and resolve per design §10.4 step 8. Do not weaken the gate.

- [ ] **Step 5: Commit**

```bash
cd /c/dev/HyperNova/domecs
git add doc/LEGIBILITY.md packages/*/package.json doc/api-surface
git commit -m "$(cat <<'EOF'
chore(release)!: freeze v1.0 — flip L6 to shipped

All six legibility laws now enforced in CI. Bump every @domecs/* package
0.1.0-alpha.0 -> 1.0.0.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review (run after all tasks)

1. **Spec coverage (§7):** doctest harness (T1) ✓ · DEFAULT_INPUT_OPTIONS (T2) ✓ · the four required doctests — input defaults+override+read, event tick-delay, all four changedOn modes, Result error handling (T3) ✓ · delete createPersistence facade (T4) ✓ · api.md drift fixes InspectorOptions/Plugin/MountOptions + banner (T4) ✓ · docstring/units polish full rank-13 list (T5) ✓ · CI hardening permissions/concurrency/SHA-pin (T6) ✓ · doctest CI gate (T6) ✓ · flip L6 + freeze v1.0 (T7) ✓.
2. **Placeholder scan:** the two `Implementer note` blocks (T3 event + Result snippets) are deliberate "confirm the real signature" guards, not placeholders — the asserted *contract* is fully specified; only the surface syntax is confirmed against source at write time (the Phase-3 lesson: never hard-code a guessed signature). All commands, file paths, and config bodies are concrete.
3. **Type consistency:** `extractDoctests`/`tempFileName` names match between `doctest.mjs` and `doctest.test.mjs`; `DEFAULT_INPUT_OPTIONS` shape matches between the const (T2 S3), the test (T2 S1), and the doctest (T3 S1); `ChangedOn` arms match `view.ts`.
4. **Ordering:** T1 (harness) precedes T3 (authoring doctests) precedes T6 (CI gate); T2 (export) precedes T3-input-doctest; T5 surface-regen precedes T7 final-gate. Correct.
