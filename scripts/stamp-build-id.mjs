#!/usr/bin/env node
/**
 * Stamp every `@domecs/*` package's built `dist/build-id.js` with the plain
 * package version: the identity a published build carries (ED-15). Without
 * it a registry release would report `BUILD_ID === 'dev'`, the same as any
 * workspace build.
 *
 *   node scripts/stamp-build-id.mjs     # after `pnpm -r build`
 *
 * `pnpm publish:npm` runs it between the build and `pnpm publish`, and the
 * packed cold-install runs it (then restores `'dev'`) so the gate checks the
 * payload npm would receive. The next `pnpm build` writes `'dev'` again.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PACKAGES, stampBuildIdSource } from './pack-for-studio.mjs'

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Stamps each package's `dist/build-id.js` with the shared version. A file
 * already stamped with that version is left alone. Returns the version and
 * `restore()`, which writes every file back byte for byte.
 */
export function stampPublishBuildIds({ root = defaultRoot } = {}) {
  const versions = new Set(
    PACKAGES.map((p) => JSON.parse(fs.readFileSync(path.join(root, p.dir, 'package.json'), 'utf8')).version),
  )
  if (versions.size !== 1) throw new Error(`packages disagree on version: ${[...versions].join(', ')}`)
  const [version] = versions
  const stamped = `export const BUILD_ID = ${JSON.stringify(version)};`
  const originals = []
  const restore = () => {
    for (const [file, text] of originals) fs.writeFileSync(file, text)
  }
  try {
    for (const p of PACKAGES) {
      const file = path.join(root, p.dir, 'dist', 'build-id.js')
      const text = fs.readFileSync(file, 'utf8')
      if (text.includes(stamped)) continue
      originals.push([file, text])
      fs.writeFileSync(file, stampBuildIdSource(text, version))
    }
  } catch (e) {
    restore()
    throw e
  }
  return { version, restore }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { version } = stampPublishBuildIds()
    console.error(`[stamp-build-id] BUILD_ID = ${version} in ${PACKAGES.length} packages`)
  } catch (e) {
    console.error(`[stamp-build-id] FAILED: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}
