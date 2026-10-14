import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// [workspace dir relative to ROOT, snapshot short-name]
export const PACKAGES = [
  ['packages/domecs', 'core'],
  ['packages/domecs-dom', 'dom'],
  ['packages/domecs-input', 'input'],
  ['packages/domecs-inspector', 'inspector'],
  ['packages/domecs-persist', 'persist'],
  ['packages/domecs-rules', 'rules'],
  ['packages/domecs-scene', 'scene'],
]

export const OUT_DIR = join(ROOT, 'doc', 'api-surface')

/** Make an emitted .d.ts barrel stable & OS-independent: LF, no sourcemap trailer, single final newline. */
export function normalize(dts) {
  return (
    dts
      .replace(/\r\n/g, '\n') // CRLF -> LF (Windows tsc / git autocrlf safety)
      .replace(/^\/\/# sourceMappingURL=.*$/m, '') // drop volatile sourcemap pointer
      .replace(/\n+$/, '') + '\n' // exactly one trailing newline
  )
}

/**
 * O-73 (X3): the whole declaration surface of a built package — every
 * emitted `.d.ts` under `dist/`, in path order, each under a `// file:`
 * header. The barrel alone only lists names, so a changed signature in a
 * module it re-exports passed the gate.
 */
export function surfaceOf(dir) {
  const dist = join(ROOT, dir, 'dist')
  const files = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.d.ts')) files.push(p)
    }
  }
  walk(dist)
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return files
    .map((f) => `// file: ${relative(dist, f).split('\\').join('/')}\n${normalize(readFileSync(f, 'utf8'))}`)
    .join('\n')
}

/** Regenerate every committed snapshot from the freshly-built dist declarations. Returns the names written. */
export function generate() {
  mkdirSync(OUT_DIR, { recursive: true })
  const written = []
  for (const [dir, name] of PACKAGES) {
    writeFileSync(join(OUT_DIR, `${name}.d.ts`), surfaceOf(dir))
    written.push(name)
  }
  return written
}

// CLI guard — Windows-safe main-module detection.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const written = generate()
  console.log(`Wrote API-surface snapshot for: ${written.join(', ')}`)
}
