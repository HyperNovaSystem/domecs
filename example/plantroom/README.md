# Plantroom — flagship operable simulation (WS-4)

Working title for the PLAN capstone: a simulated industrial process cell that
exercises the distinctive DOMECS stack **together**:

- deterministic fixed-step physics-ish plant model
- typed control actions (`world.action` / agent bridge)
- snapshot branching + fast-forward compare
- multi-view projection targets (tags / alarms / trends)
- agent-in-the-loop proposals for operator approval

## Status

**Scaffold + headless core.** Product depth and browser chrome grow here (or
in a standalone app repo) as dogfood demands.

## Run tests

```bash
# from repo root
pnpm --filter @domecs/core build
node --test example/plantroom/test/episode.test.mjs
```

## Demo moment (target)

1. Fault develops (cooling pump trip).
2. Agent proposes a control sequence via typed actions.
3. Operator branches the snapshot.
4. Both strategies fast-forward; outcomes compared.
5. One branch committed.

## Layout

| Path | Role |
|------|------|
| `src/model.mjs` | Components, events, systems (tags, alarms, plant) |
| `src/session.mjs` | Agent bridge + branch/fast-forward helpers |
| `test/episode.test.mjs` | Deterministic fault → propose → branch episode |
