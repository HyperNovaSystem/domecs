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
    // Assumes api.md uses non-indented triple-backtick fences (no nested or
    // 4-backtick fences); the closing fence is a line of bare ``` + whitespace.
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
 * `exports` point at the workspace package's built `dist/` via a single
 * directory link named `dist`. A directory junction (Windows) / dir symlink
 * (POSIX) needs no elevated privilege, unlike per-file file symlinks which
 * throw `EPERM` on Windows without Developer Mode/admin. The link target's
 * realpath is the real `dist`, so relative imports inside it (e.g.
 * `./component.js`) still resolve.
 */
function linkPackages() {
  const scope = join(TMP_DIR, 'node_modules', '@domecs')
  for (const [key, dir] of Object.entries(DOMECS_PACKAGES)) {
    const absDistDir = join(ROOT, dir, 'dist')
    const distJs = join(absDistDir, 'index.js')
    const distDts = join(absDistDir, 'index.d.ts')
    if (!existsSync(distJs) || !existsSync(distDts)) {
      console.error(`doctest: missing build output for @domecs/${key} (${dir}/dist). Run \`pnpm build\` first.`)
      process.exit(1)
    }
    const pkgDir = join(scope, key)
    mkdirSync(pkgDir, { recursive: true })
    // 'junction' is honored on Windows (no privilege needed) and ignored on
    // POSIX, where Node creates a plain directory symlink instead.
    try {
      symlinkSync(absDistDir, join(pkgDir, 'dist'), 'junction')
    } catch (err) {
      console.error(
        `doctest: failed to link @domecs/${key} dist (${err.code}) — on Windows enable Developer Mode or run as admin`,
      )
      process.exit(1)
    }
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify(
        {
          name: `@domecs/${key}`,
          version: '0.0.0',
          type: 'module',
          exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
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
  const seen = new Set()
  for (const source of SOURCES) {
    const md = readFileSync(join(ROOT, source), 'utf8')
    for (const block of extractDoctests(md, source)) {
      const name = tempFileName(block)
      if (seen.has(name)) {
        console.error(`doctest: duplicate snippet name \`${block.name}\` — two doctest fences resolve to the same temp file ${name}`)
        process.exit(1)
      }
      seen.add(name)
      const file = join(TMP_DIR, name)
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
