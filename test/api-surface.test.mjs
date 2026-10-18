import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGES, OUT_DIR, ROOT, surfaceOf } from '../scripts/api-surface.mjs'

test('committed API surface matches the freshly-built dist declarations (no-drift gate)', () => {
  for (const [dir, name] of PACKAGES) {
    const distPath = join(ROOT, dir, 'dist', 'index.d.ts')
    assert.ok(existsSync(distPath), `dist not built for "${name}" — run \`pnpm -r build\` first`)

    const snapPath = join(OUT_DIR, `${name}.d.ts`)
    assert.ok(existsSync(snapPath), `missing snapshot doc/api-surface/${name}.d.ts — run \`pnpm api:surface\``)

    assert.equal(
      readFileSync(snapPath, 'utf8'),
      surfaceOf(dir),
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

  for (const [dir] of PACKAGES) {
    assert.ok(
      existsSync(join(ROOT, dir, 'package.json')),
      `PACKAGES references "${dir}" which no longer exists — update scripts/api-surface.mjs`,
    )
  }
})

test('every package exports BUILD_ID: string (ED-15, E1.5)', () => {
  for (const [dir, name] of PACKAGES) {
    const snap = readFileSync(join(OUT_DIR, `${name}.d.ts`), 'utf8')
    assert.match(
      snap,
      /\/\/ file: build-id\.d\.ts\n(?:[^\n]*\n)*?export declare const BUILD_ID: string;/,
      `${name}: doc/api-surface/${name}.d.ts lacks build-id.d.ts with \`export declare const BUILD_ID: string\``,
    )
    assert.match(
      readFileSync(join(ROOT, dir, 'src', 'index.ts'), 'utf8'),
      /export \{ BUILD_ID \} from '\.\/build-id\.js'/,
      `${name}: src/index.ts does not re-export BUILD_ID`,
    )
  }
})
