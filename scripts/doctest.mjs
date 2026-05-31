import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, symlinkSync } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const TMP_DIR = join(ROOT, 'doc', '.doctest')
export const TMP_OUT = join(TMP_DIR, 'dist')

/** Markdown files scanned for `ts doctest` fences. */
export const SOURCES = ['doc/api.md']

/**
 * `@domecs/<key>` -> workspace package dir. The root workspace is not a
 * consumer of these packages, so pnpm creates no root-level
 * `node_modules/@domecs/*`. The harness builds a shim package per entry into
 * the temp `node_modules` so a verbatim snippet's `@domecs/*` specifier
 * resolves: `tsc` typechecks against the built `.d.ts` and `node` runs the
 * built `.js` — exactly what a published consumer gets.
 */
export const DOMECS_PACKAGES = {
  core: 'packages/domecs',
  dom: 'packages/domecs-dom',
  input: 'packages/domecs-input',
  inspector: 'packages/domecs-inspector',
  persist: 'packages/domecs-persist',
}

/**
 * Extract every fenced block whose info string begins with `ts doctest`.
 * Returns [{ name, code, source }]. An explicit `name=<slug>` in the info
 * string wins; otherwise the name is `<md-basename-without-ext>-<index>`.
 */
export function extractDoctests(markdown, source) {
  // Normalize CRLF -> LF so the fence regexes work on a Windows working tree
  // (git autocrlf checks api.md out as CRLF even though it is stored as LF).
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const base = basename(source).replace(/\.md$/, '')
  const blocks = []
  let i = 0
  let n = 0
  while (i < lines.length) {
    const open = /^```ts doctest\b(.*)$/.exec(lines[i])
    if (!open) {
      i += 1
      continue
    }
    const nameMatch = /\bname=([\w-]+)/.exec(open[1])
    const body = []
    i += 1
    while (i < lines.length && !/^```\s*$/.test(lines[i])) {
      body.push(lines[i])
      i += 1
    }
    i += 1 // consume closing fence
    blocks.push({
      name: nameMatch ? nameMatch[1] : `${base}-${n}`,
      code: body.join('\n'),
      source,
    })
    n += 1
  }
  return blocks
}

export function tempFileName(block) {
  return `${block.name}.ts`
}

/**
 * Build a shim `@domecs/<key>` package in the temp `node_modules` whose
 * `exports` point at the workspace package's built `dist/index.{js,d.ts}` via
 * file symlinks. Node forbids `..` in an `exports` target, so the targets are
 * package-local symlinks rather than relative paths escaping the shim dir.
 */
function linkPackages() {
  const scope = join(TMP_DIR, 'node_modules', '@domecs')
  for (const [key, dir] of Object.entries(DOMECS_PACKAGES)) {
    const distJs = join(ROOT, dir, 'dist', 'index.js')
    const distDts = join(ROOT, dir, 'dist', 'index.d.ts')
    if (!existsSync(distJs) || !existsSync(distDts)) {
      console.error(`doctest: missing build output for @domecs/${key} (${dir}/dist). Run \`pnpm build\` first.`)
      process.exit(1)
    }
    const pkgDir = join(scope, key)
    mkdirSync(pkgDir, { recursive: true })
    symlinkSync(distJs, join(pkgDir, 'index.js'), 'file')
    symlinkSync(distDts, join(pkgDir, 'index.d.ts'), 'file')
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify(
        {
          name: `@domecs/${key}`,
          version: '0.0.0',
          type: 'module',
          exports: { '.': { types: './index.d.ts', default: './index.js' } },
        },
        null,
        2,
      ) + '\n',
    )
  }
}

function run() {
  rmSync(TMP_DIR, { recursive: true, force: true })
  mkdirSync(TMP_DIR, { recursive: true })
  linkPackages()

  const all = []
  for (const source of SOURCES) {
    const md = readFileSync(join(ROOT, source), 'utf8')
    for (const block of extractDoctests(md, source)) {
      const file = join(TMP_DIR, tempFileName(block))
      writeFileSync(file, block.code.replace(/\r\n/g, '\n').replace(/\n*$/, '\n'))
      all.push({ ...block, file })
    }
  }
  if (all.length === 0) {
    console.error('doctest: no `ts doctest` fences found in ' + SOURCES.join(', '))
    process.exit(1)
  }
  console.log(`doctest: extracted ${all.length} snippet(s)`)

  // 1) Typecheck + emit. tsc resolves @domecs/* via the shim packages above.
  const tsc = spawnSync(
    'pnpm',
    ['exec', 'tsc', '-p', 'tsconfig.doctest.json'],
    { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' },
  )
  if (tsc.status !== 0) {
    console.error('doctest: typecheck failed')
    process.exit(1)
  }

  // 2) Execute each emitted module; a thrown assert exits non-zero. Bare
  // node resolves `@domecs/*` to the built dist via the shim packages above.
  let failed = 0
  for (const js of readdirSync(TMP_OUT).filter((f) => f.endsWith('.js'))) {
    const res = spawnSync('node', [join(TMP_OUT, js)], { cwd: ROOT, stdio: 'inherit' })
    if (res.status !== 0) {
      console.error(`doctest: FAILED ${js}`)
      failed += 1
    }
  }
  if (failed > 0) {
    console.error(`doctest: ${failed} snippet(s) failed`)
    process.exit(1)
  }
  console.log(`doctest: all ${all.length} snippet(s) passed`)
}

// CLI guard — Windows-safe main-module detection.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run()
}
