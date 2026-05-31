import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// [workspace dir relative to ROOT, snapshot short-name]
export const PACKAGES = [
  ['packages/domecs', 'core'],
  ['packages/domecs-dom', 'dom'],
  ['packages/domecs-input', 'input'],
  ['packages/domecs-inspector', 'inspector'],
  ['packages/domecs-persist', 'persist'],
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

/** Regenerate every committed snapshot from the freshly-built dist barrels. Returns the names written. */
export function generate() {
  mkdirSync(OUT_DIR, { recursive: true })
  const written = []
  for (const [dir, name] of PACKAGES) {
    const dts = readFileSync(join(ROOT, dir, 'dist', 'index.d.ts'), 'utf8')
    writeFileSync(join(OUT_DIR, `${name}.d.ts`), normalize(dts))
    written.push(name)
  }
  return written
}

// CLI guard — Windows-safe main-module detection.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const written = generate()
  console.log(`Wrote API-surface snapshot for: ${written.join(', ')}`)
}
