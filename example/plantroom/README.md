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
# from repo root
pnpm plantroom:dev
# → http://localhost:5179

pnpm plantroom:build
```

**GitHub Pages (this repo):** https://hypernovasystem.github.io/domecs/  
Deployed from `main` via `.github/workflows/pages.yml` (enable Pages → GitHub Actions once if 404).

### Manual test path (≈2 min)

1. **1 · Inject pump trip** — temp climbs; proposal appears. Key: `1`
2. **2 · Approve** (or Reject + other proposal). Keys: `a` / `r`
3. **Branch compare** — naive vs reset+start (auto-faults if healthy). Key: `b`
4. **Historian scrub** + **Restore checkpoint @ scrub**
5. **Reset episode** — Key: `Esc` · Space toggles pause/run

### Layout

| Path | Role |
|------|------|
| `src/buildPlant.js` | Shared domain factory |
| `src/model.mjs` / `session.mjs` | Headless + agent session |
| `src/browser/*` | Vite multi-view chrome |
| `test/episode.test.mjs` | WS-4 acceptance tests |
