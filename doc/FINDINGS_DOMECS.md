# DOMECS Findings

Notes from maintaining the core engine packages.

## 2026-05-13 - headless import contract needs package-level regressions

The runtime already avoided browser globals at import time, but only the core
package had meaningful Node coverage. `@domecs/dom` and `@domecs/input` were
tested primarily under `happy-dom`, so a future accidental top-level
`document`/`window` read could slip through.

Follow-up rule:

- Keep at least one Node-environment import/install smoke test in every
  browser-adjacent package.
- Keep `happy-dom` limited to tests that actually exercise DOM behavior.
- Treat API docs and package README snippets as part of the contract; the input
  and DOM snippets had drifted from the current `createInputPlugin` /
  `mountDOM` APIs.
