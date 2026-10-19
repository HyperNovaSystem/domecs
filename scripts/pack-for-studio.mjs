#!/usr/bin/env node
/**
 * Pack every `@domecs/*` package as a build-stamped tarball for Studio
 * (spec §8 "Getting builds to studio", ED-15; plan E1.6).
 *
 *   node scripts/pack-for-studio.mjs --out ../studio/vendor/domecs
 *
 * 1. Builds the seven packages (`pnpm -r --filter ./packages/* build`).
 * 2. Computes the build id `<version>+g<sha7>[-dirty]` (dirty = the git
 *    tree had changes, untracked files included, before packing).
 * 3. Per package: rewrites the built `dist/build-id.js` to that id, sets the
 *    `package.json` `version` to it (build metadata, so `^2.0.0` ranges
 *    still match) and `workspace:` ranges to the plain version, runs
 *    `pnpm pack` (which applies `publishConfig` → `dist`), then restores
 *    `package.json` and `dist/build-id.js` byte for byte.
 * 4. Names each tarball `domecs-<pkg>-<buildId>.tgz` (a changed engine is a
 *    changed dependency spec), removes this script's older tarballs from
 *    `--out`, and writes `manifest.json`:
 *    `{ version, buildId, gitSha, dirty, packedAt,
 *       packages: { "@domecs/core": { file, integrity, buildId }, … } }`
 *    with npm-style `sha512-<base64>` integrity.
 * 5. Copies `scripts/determinism-golden.mjs` next to the tarballs (manifest
 *    `golden: { file, integrity }`), so studio can run the engine's
 *    dual-runtime golden with `--engine <its node_modules>` (spec §3.4).
 *
 * Never publishes. Publishing (`pnpm publish:npm`) needs owner approval and
 * ships plain versions.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const PACKAGES = [
  { name: '@domecs/core', dir: 'packages/domecs' },
  { name: '@domecs/dom', dir: 'packages/domecs-dom' },
  { name: '@domecs/input', dir: 'packages/domecs-input' },
  { name: '@domecs/inspector', dir: 'packages/domecs-inspector' },
  { name: '@domecs/persist', dir: 'packages/domecs-persist' },
  { name: '@domecs/rules', dir: 'packages/domecs-rules' },
  { name: '@domecs/scene', dir: 'packages/domecs-scene' },
]

const OWN_TARBALL = /^domecs-(core|dom|input|inspector|persist|rules|scene)-.+\.tgz$/
const GOLDEN_SCRIPT = 'determinism-golden.mjs'
const DEP_SECTIONS = ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts })
  if (r.status !== 0) {
    const detail = [r.stdout, r.stderr].filter(Boolean).join('\n')
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})\n${detail}`)
  }
  return r.stdout
}

/** `<version>+g<sha7>[-dirty]`. */
export function formatBuildId(version, sha, dirty) {
  return `${version}+g${sha.slice(0, 7)}${dirty ? '-dirty' : ''}`
}

/** Rewrite `workspace:` ranges the way `pnpm publish` would, against `version`. */
export function rewriteWorkspaceRanges(pkg, version) {
  const next = structuredClone(pkg)
  for (const section of DEP_SECTIONS) {
    const deps = next[section]
    if (!deps) continue
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range !== 'string' || !range.startsWith('workspace:')) continue
      const spec = range.slice('workspace:'.length)
      deps[name] = spec === '^' ? `^${version}` : spec === '~' ? `~${version}` : spec === '*' ? version : spec
    }
  }
  return next
}

/** The `dist/build-id.js` text with its `'dev'` literal replaced by `buildId`. */
export function stampBuildIdSource(source, buildId) {
  const re = /export const BUILD_ID = 'dev';/
  if (!re.test(source)) throw new Error("dist/build-id.js does not hold `export const BUILD_ID = 'dev';`")
  return source.replace(re, `export const BUILD_ID = ${JSON.stringify(buildId)};`)
}

/** npm-style subresource integrity of a file. */
export function integrityOf(file) {
  return `sha512-${createHash('sha512').update(fs.readFileSync(file)).digest('base64')}`
}

/**
 * Read one file out of a `.tgz` (ustar, with pax `path` records). Enough
 * for verifying our own `pnpm pack` output without a tar dependency.
 */
export function readTarEntry(tgzPath, entryName) {
  const buf = gunzipSync(fs.readFileSync(tgzPath))
  let off = 0
  let paxPath = null
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const field = (start, len) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '')
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1)
    const prefix = field(345, 155)
    const name = paxPath ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    const body = buf.subarray(off + 512, off + 512 + size)
    off += 512 + Math.ceil(size / 512) * 512
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))
      paxPath = m ? m[1] : null
      continue
    }
    paxPath = null
    if ((type === '0' || type === '' ) && name === entryName) return Buffer.from(body)
  }
  throw new Error(`${entryName} not found in ${tgzPath}`)
}

function gitState() {
  const sha = run('git', ['rev-parse', 'HEAD'], { cwd: root }).trim()
  const dirty = run('git', ['status', '--porcelain'], { cwd: root }).trim() !== ''
  return { sha, dirty }
}

function packOne(p, buildId, version, out) {
  const pkgDir = path.join(root, p.dir)
  const pkgPath = path.join(pkgDir, 'package.json')
  const stampPath = path.join(pkgDir, 'dist', 'build-id.js')
  const pkgText = fs.readFileSync(pkgPath, 'utf8')
  const stampText = fs.readFileSync(stampPath, 'utf8')
  const short = p.name.replace('@domecs/', '')
  const target = path.join(out, `domecs-${short}-${buildId}.tgz`)
  const staging = fs.mkdtempSync(path.join(out, '.pack-'))
  try {
    const pkg = rewriteWorkspaceRanges(JSON.parse(pkgText), version)
    pkg.version = buildId
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    fs.writeFileSync(stampPath, stampBuildIdSource(stampText, buildId))
    run('pnpm', ['pack', '--pack-destination', staging], { cwd: pkgDir })
    const created = fs.readdirSync(staging).filter((f) => f.endsWith('.tgz'))
    if (created.length !== 1) {
      throw new Error(`expected one tarball for ${p.name}, saw: ${created.join(', ') || '(none)'}`)
    }
    fs.renameSync(path.join(staging, created[0]), target)
  } finally {
    fs.writeFileSync(pkgPath, pkgText)
    fs.writeFileSync(stampPath, stampText)
    fs.rmSync(staging, { recursive: true, force: true })
  }
  // Verify the payload before declaring it in the manifest.
  const packed = JSON.parse(readTarEntry(target, 'package/package.json').toString('utf8'))
  if (packed.version !== buildId) throw new Error(`${p.name}: packed version ${packed.version} != ${buildId}`)
  if (JSON.stringify(packed).includes('workspace:')) throw new Error(`${p.name}: workspace: range left in tarball`)
  const stamp = readTarEntry(target, 'package/dist/build-id.js').toString('utf8')
  if (!stamp.includes(`BUILD_ID = ${JSON.stringify(buildId)}`)) throw new Error(`${p.name}: BUILD_ID not stamped`)
  return { file: path.basename(target), integrity: integrityOf(target), buildId }
}

export function packForStudio({ out, build = true, log = (m) => console.error(m) }) {
  const versions = new Set(
    PACKAGES.map((p) => JSON.parse(fs.readFileSync(path.join(root, p.dir, 'package.json'), 'utf8')).version),
  )
  if (versions.size !== 1) throw new Error(`packages disagree on version: ${[...versions].join(', ')}`)
  const [version] = versions
  // Dirty is decided before this script touches anything.
  const { sha, dirty } = gitState()
  const buildId = formatBuildId(version, sha, dirty)
  log(`[pack-for-studio] ${buildId} → ${out}`)
  fs.mkdirSync(out, { recursive: true })

  if (build) {
    log('[pack-for-studio] build packages…')
    run('pnpm', ['-r', '--filter', './packages/*', 'build'], { cwd: root })
  }

  const packages = {}
  const written = new Set()
  for (const p of PACKAGES) {
    log(`[pack-for-studio] pack ${p.name}…`)
    packages[p.name] = packOne(p, buildId, version, out)
    written.add(packages[p.name].file)
    log(`[pack-for-studio]   → ${packages[p.name].file}`)
  }
  for (const f of fs.readdirSync(out)) {
    if (OWN_TARBALL.test(f) && !written.has(f)) fs.rmSync(path.join(out, f))
  }
  // §3.4: studio runs the engine's determinism golden from the vendored
  // copy (`node determinism-golden.mjs --engine <node_modules>`).
  const goldenTarget = path.join(out, GOLDEN_SCRIPT)
  fs.copyFileSync(path.join(root, 'scripts', GOLDEN_SCRIPT), goldenTarget)
  log(`[pack-for-studio]   → ${GOLDEN_SCRIPT}`)
  const manifest = {
    version,
    buildId,
    gitSha: sha,
    dirty,
    packedAt: new Date().toISOString(),
    packages,
    golden: { file: GOLDEN_SCRIPT, integrity: integrityOf(goldenTarget) },
  }
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  log('[pack-for-studio] wrote manifest.json')
  return manifest
}

function parseArgs(argv) {
  const opts = { out: null, build: true }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') opts.out = argv[++i] ?? null
    else if (argv[i] === '--no-build') opts.build = false
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  return opts
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const opts = parseArgs(process.argv.slice(2))
    if (!opts.out) {
      console.error('usage: node scripts/pack-for-studio.mjs --out <dir> [--no-build]')
      process.exit(2)
    }
    const manifest = packForStudio({ out: path.resolve(opts.out), build: opts.build })
    console.log(JSON.stringify(manifest, null, 2))
  } catch (e) {
    console.error(`[pack-for-studio] FAILED: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}
