# Agent evals (PLAN WS-5 B6)

Can a coding agent build working DOMECS code from what the npm packages
ship? These evals answer that with behavioral graders, not opinions. Run
them **on demand**, at the start and end of an improvement run, never on a
schedule. Paid runs cost money; the runner refuses them without
`--confirm-cost`.

## Tasks

Each task targets a trap the 2026-10-20 audit found. The agent gets only the
prompt and an empty project with the packed `@domecs/core` tarball installed,
exactly what an npm user gets. A hidden grader runs after it finishes.

| Task | What it builds | Traps it checks |
|---|---|---|
| `agent-counter` | An agent bridge with a schema-validated command | `act` already ticks; schema on commands; `reset` |
| `fixed-projectile` | Fixed-step projectiles under gravity | `stepOnce` never fires `fixed`; `world.rand` |
| `change-reader` | A resource index kept by a reactive system | `markChanged` after mutation; removals |
| `seeded-walk` | A seeded random walk with snapshot replay | `world.rand`; no wall clock; restore continuation |

## Run

```bash
node evals/selftest.mjs                     # free: references pass; every trap mutant and an early-exit probe fail
node evals/run.mjs --agent reference        # free: grades the reference solutions
node evals/run.mjs --agent claude --k 3 --confirm-cost [--model sonnet] [--budget 2]
node evals/run.mjs --agent codex  --k 3 --confirm-cost [--model <model>]
node evals/run.mjs --agent claude --task fixed-projectile --k 5 --confirm-cost
```

`--k` attempts per task (1–50, default 3). The report gives **pass@1** (the
mean pass rate) and **pass^k** (the share of tasks every attempt passed;
τ-bench's reliability measure), plus cost for Claude. Paid runs write
`evals/results/<timestamp>-<agent>[-model].json` (never overwritten); commit
the ones a decision rests on. A failed attempt's workspace is kept and its
path is in the results, so you can read what the agent wrote and the
grader's TAP output (`grader-result.tap`). Concurrent runs do not share any
scratch state.

## Billing

Agents run on the CLIs' own logins: `claude` on a claude.ai subscription
(`claude auth status`), `codex` on a ChatGPT plan (`codex login status`).
The runner strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`OPENAI_API_KEY` and `CODEX_API_KEY` from the agents' environment, so a key
in your shell cannot switch a run to API billing. On a subscription a run
uses your plan's limits rather than money; Claude's `costUsd` is then an
estimate, and `--max-budget-usd` still caps each attempt by that estimate.

The Agent SDKs are not used. Anthropic's terms ask that tools built on the
Claude Agent SDK authenticate with an API key, while the CLI used directly
on your own machine runs on your login.

## Isolation

Each run packs `@domecs/core` into a fresh temp directory outside the repo.
Every attempt gets its own copy, and the workspace references the tarball
by a relative path, so nothing in it points back at the checkout. The agent's
`src/` is then graded in a **separate fresh workspace**, so a planted
`.grader`, edited `node_modules` or other files never reach the grader. A
pass needs every named grader test to have run and passed: a candidate that
exits during import cannot pass by reporting zero tests.

- **Claude Code:** `claude -p` with:
  - `--tools Read,Write,Edit,Glob,Grep,Bash` (the tools that exist), plus an
    `--allowedTools` list that runs without asking (file tools, `node`,
    `ls`, `cat`, `mkdir`);
  - `--settings` denying Read, Glob and Grep under `/home` (where the repo
    and its graders live);
  - `--setting-sources project` (no user settings, so no user hooks or
    plugins), `--strict-mcp-config` (no MCP servers),
    `--no-session-persistence`, and `--max-budget-usd` per attempt
    (default 2).
- **Codex:** `codex exec --ignore-user-config --ignore-rules --ephemeral -s
  workspace-write --skip-git-repo-check`.

Not covered, so read results with this in mind:

- The user-level `CLAUDE.md` and Codex's global `AGENTS.md` instructions
  may still load.
- `Bash(node:*)` can read any file the OS lets it, so an agent that goes
  looking could find the graders under `/home`. Failed workspaces are kept,
  so read them when a result looks too good.
- Real containment needs a container or VM. Add one before using these
  evals for anything adversarial.

## Adding a task

`tasks/<id>/` holds `task.json` (id, title, traps, prompt), `grader.test.mjs`
(node:test, imports `../src/...` and reads `src/` relative to the workspace)
and `reference/` (a known-good solution). Then add at least one mutant per
trap to `selftest.mjs`; a grader that passes a mutant is not testing that
trap. The prompt must state the full export contract the grader relies on.
