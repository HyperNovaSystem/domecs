import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGES, OUT_DIR, ROOT, normalize } from '../scripts/api-surface.mjs'

test('committed API surface matches the freshly-built dist barrel (no-drift gate)', () => {
  for (const [dir, name] of PACKAGES) {
    const distPath = join(ROOT, dir, 'dist', 'index.d.ts')
    assert.ok(existsSync(distPath), `dist not built for "${name}" — run \`pnpm -r build\` first`)

    const snapPath = join(OUT_DIR, `${name}.d.ts`)
    assert.ok(existsSync(snapPath), `missing snapshot doc/api-surface/${name}.d.ts — run \`pnpm api:surface\``)

    assert.equal(
      readFileSync(snapPath, 'utf8'),
      normalize(readFileSync(distPath, 'utf8')),
      `API-surface drift in "${name}": regenerate with \`pnpm api:surface\` and commit doc/api-surface/`,
    )
  }
})

test('snapshot covers every workspace package (no package escapes the contract)', () => {
  const snapshotted = new Set(PACKAGES.map(([dir]) => dir))
  const onDisk = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, 'packages', d.name, 'package.json')))
    .map((d) => `packages/${d.name}`)

  for (const dir of onDisk) {
    assert.ok(
      snapshotted.has(dir),
      `workspace package "${dir}" is not in PACKAGES — add it to scripts/api-surface.mjs`,
    )
  }
})
