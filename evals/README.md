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
node evals/selftest.mjs                     # free: references pass, trap mutants fail
node evals/run.mjs --agent reference        # free: grades the reference solutions
node evals/run.mjs --agent claude --k 3 --confirm-cost [--model sonnet] [--budget 2]
node evals/run.mjs --agent codex  --k 3 --confirm-cost [--model <model>]
node evals/run.mjs --agent claude --task fixed-projectile --k 5 --confirm-cost
```

`--k` attempts per task (default 3). The report gives **pass@1** (the mean
pass rate) and **pass^k** (the share of tasks every attempt passed; τ-bench's
reliability measure), plus cost for Claude. Paid runs write
`evals/results/<date>-<agent>[-model].json`; commit the ones a decision
rests on. A failed attempt's workspace is kept and its path is in the
results, so you can read what the agent wrote and the grader's TAP output
(`.grader/result.tap`).

## Isolation

Every attempt runs in a fresh temp directory with no git repo.

- **Claude Code:** `claude -p` with `--setting-sources project` (no user
  settings, hooks or plugins), `--strict-mcp-config` (no MCP servers),
  `--no-session-persistence`, `--max-budget-usd` per attempt (default 2),
  and an allow-list of file tools plus `node`, `ls`, `cat`, `mkdir`. The
  user-level `CLAUDE.md` memory may still load.
- **Codex:** `codex exec --ignore-user-config --ephemeral -s workspace-write
  --skip-git-repo-check`.

## Adding a task

`tasks/<id>/` holds `task.json` (id, title, traps, prompt), `grader.test.mjs`
(node:test, imports `../src/...` and reads `src/` relative to the workspace)
and `reference/` (a known-good solution). Then add at least one mutant per
trap to `selftest.mjs`; a grader that passes a mutant is not testing that
trap. The prompt must state the full export contract the grader relies on.
