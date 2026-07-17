# Plantroom — flagship operable simulation (WS-4)

Product-depth reference for DOMECS: a simulated industrial process cell that
exercises the distinctive stack **together**:

| Capability | Where |
|------------|--------|
| Deterministic fixed-step plant | `src/buildPlant.js` |
| Typed control actions | `SetPump`, `InjectFault`, `AcknowledgeAlarm` |
| Agent proposals + **operator approval** | session + browser approval panel |
| Snapshot **branch compare** | session / toolbar |
| **Historian** samples + checkpoint restore | resource + external checkpoint ring |
| Multi-view DOM | Tags / Alarms / Plant slots |
| Scale | **200 field sensors** + critical tags (~207 entities) |
| Agent bridge | `createAgentBridge` |

## Dogfood decision

**Keep Plantroom in this monorepo** as the flagship reference app
(`example/plantroom`, package `@domecs/example-plantroom`).

Rationale: it validates the operable-sim stack against workspace packages
without a second publish cycle. Promote to a standalone HyperNovaSystem repo
later if daily product use outgrows the monorepo (not required to close WS-4).

## Run tests (headless)

```bash
# from repo root
pnpm --filter @domecs/core build
pnpm test:plantroom
```

Covers: branch compare, operator approval gate, historian checkpoint restore,
entity scale, determinism.

## Browser UI

```bash
pnpm plantroom:dev
# → http://localhost:5179

pnpm plantroom:build
```

### Demo moment (UI)

1. **Run** the plant (auto-starts).
2. **Inject pump trip** — fault + auto-queues a competent agent proposal.
3. **Approve** or **Reject** in the Operator approval panel.
4. Or run **Branch compare** to fast-forward naive vs reset+start strategies.
5. **Historian scrub** — drag the scrubber; **Restore checkpoint @ scrub**
   reloads the nearest snapshot checkpoint ≤ that tick.
6. **Return to live** resumes sampling after scrub.

### Layout

| Path | Role |
|------|------|
| `src/buildPlant.js` | Shared domain factory |
| `src/model.mjs` / `session.mjs` | Headless + agent session |
| `src/browser/*` | Vite multi-view chrome |
| `test/episode.test.mjs` | WS-4 acceptance tests |
