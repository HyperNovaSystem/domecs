# Agent legibility mini-app (WS-3)

Falsifiable check: using only patterns from root `AGENTS.md` and
`skills/domecs/SKILL.md`, an agent can operate a DOMECS world via
`createAgentBridge` (`observe → act → step → snapshot → reset`).

## Run

```bash
# from repo root
pnpm --filter @domecs/core build
node example/agent-legibility/run.mjs
```

Expect `{"ok":true,"finalScore":7,"deterministic":true,...}`.

Also covered by `pnpm test:legibility` (node test).
