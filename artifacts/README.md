# artifacts/

Local-only output from Playwright MCP sessions and ad-hoc browser captures.

Everything under this folder is gitignored (see `.gitignore`) except this
README. Use the subdirectories by convention:

- `screenshots/` — one-off PNGs from MCP Playwright or manual captures
- `test-results/` — Playwright test runner output (default when a config is added)
- `playwright-report/` — Playwright HTML report output
- `traces/` — `trace.zip` files for `npx playwright show-trace`

If you need an image in the committed docs, put it somewhere else (e.g.
`doc/images/`) — this folder is treated as throwaway.
