#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const workspaceRoot = path.resolve(__dirname, '..')

const runtimePackages = [
  { name: '@domecs/core', dir: 'packages/domecs' },
  { name: '@domecs/dom', dir: 'packages/domecs-dom' },
  { name: '@domecs/input', dir: 'packages/domecs-input' },
  { name: '@domecs/inspector', dir: 'packages/domecs-inspector' },
  { name: '@domecs/persist', dir: 'packages/domecs-persist' },
]

const packageAliases = new Map([
  ['domecs', '@domecs/core'],
  ['domecs-dom', '@domecs/dom'],
  ['domecs-input', '@domecs/input'],
  ['@domecs/core', '@domecs/core'],
  ['@domecs/dom', '@domecs/dom'],
  ['@domecs/input', '@domecs/input'],
  // inspector/persist never had unscoped legacy names — scoped only.
  ['@domecs/inspector', '@domecs/inspector'],
  ['@domecs/persist', '@domecs/persist'],
])

const dependencySections = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]

const orgAppCandidates = [
  '../fleet_app',
  '../harbor_game',
  '../lighthouse_novel',
  '../studio',
  '../tessera_game',
  '../halls_game',
]

const sourceExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
])

const ignoredDirNames = new Set([
  '.git',
  '.tmp',
  'coverage',
  'dist',
  'node_modules',
])

export function findLegacyDomecsImportSpecifiers(source) {
  const matches = []
  const seen = new Set()
  const re = /\bfrom\s*['"](domecs|domecs-dom|domecs-input)['"]|\bimport\s*\(\s*['"](domecs|domecs-dom|domecs-input)['"]\s*\)/g
  for (const match of source.matchAll(re)) {
    const specifier = match[1] ?? match[2]
    if (!seen.has(specifier)) {
      seen.add(specifier)
      matches.push(specifier)
    }
  }
  return matches
}

// Conservative allow-list: scoped (@scope/name) or bare npm names, the only
// shapes a published @domecs package can take. Anything else is rejected so a
// crafted name can't escape the string literal in the generated probe.
const SAFE_PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/**
 * Build a Node ESM probe that dynamically imports each package and prints a
 * sentinel. Run with `node --input-type=module -e <probe>` against the staged
 * install, it proves each packed package actually resolves and loads as ESM
 * (catching missing `dist`, bad `exports` maps, or CJS/ESM interop breakage)
 * — a class of failure the app `test`/`build` scripts can miss when they only
 * touch a subset of packages.
 */
export function buildEsmImportProbe(packageNames) {
  for (const name of packageNames) {
    if (!SAFE_PACKAGE_NAME.test(name)) {
      throw new Error(`invalid package name for ESM import probe: ${JSON.stringify(name)}`)
    }
  }
  const imports = packageNames.map((name) => `await import('${name}')`).join('\n')
  return `${imports}\nconsole.log('domecs-esm-smoke-ok')`
}

/**
 * Write the ESM probe to a file inside the staged app instead of passing it
 * via `node -e`: with `shell: true` on win32 a multiline -e argument is
 * truncated at the first newline by cmd.exe, breaking the probe.
 */
export function writeEsmImportProbeFile(dir, packageNames) {
  const file = path.join(dir, '.domecs-esm-probe.mjs')
  fs.writeFileSync(file, `${buildEsmImportProbe(packageNames)}\n`)
  return file
}

export function rewriteDomecsDependencies(packageJson, tarballSpecs) {
  const next = structuredClone(packageJson)
  const used = new Set()

  for (const section of dependencySections) {
    const deps = next[section]
    if (!deps) continue

    const replacements = new Map()
    for (const key of Object.keys(deps)) {
      const scoped = packageAliases.get(key)
      if (!scoped) continue
      if (!tarballSpecs[scoped]) {
        throw new Error(`No packed tarball was provided for ${scoped}`)
      }
      delete deps[key]
      replacements.set(scoped, tarballSpecs[scoped])
      used.add(scoped)
    }

    for (const [key, value] of replacements) {
      deps[key] = value
    }

    if (Object.keys(deps).length === 0) {
      delete next[section]
    }
  }

  return {
    packageJson: next,
    usedPackages: runtimePackages
      .map((pkg) => pkg.name)
      .filter((name) => used.has(name)),
  }
}

function parseArgs(argv) {
  const args = new Set(argv)
  return {
    dryRun: args.has('--dry-run'),
    skipInstall: args.has('--skip-install') || args.has('--dry-run'),
    includeWorkspace: !args.has('--org-only'),
    includeOrg: !args.has('--workspace-only'),
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? workspaceRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })

  if (result.status !== 0) {
    if (result.error) {
      throw new Error(`Command failed: ${command} ${args.join(' ')}\n${result.error.message}`)
    }
    const detail = options.capture
      ? `\n${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd()
      : ''
    throw new Error(
      `Command failed: ${command} ${args.join(' ')}${detail ? `\n${detail}` : ''}`,
    )
  }

  return result.stdout ?? ''
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function fileDependencySpec(fromDir, targetFile) {
  let rel = path.relative(fromDir, targetFile).replaceAll(path.sep, '/')
  if (!rel.startsWith('.')) rel = `./${rel}`
  return `file:${rel}`
}

function assertInside(child, parent) {
  const childPath = path.resolve(child)
  const parentPath = path.resolve(parent)
  const rel = path.relative(parentPath, childPath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${childPath} is outside ${parentPath}`)
  }
}

function safeResetDir(dir, requiredParent) {
  assertInside(dir, requiredParent)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
}

function isIgnoredCopyPath(source) {
  const base = path.basename(source)
  return (
    ignoredDirNames.has(base) ||
    base === 'package-lock.json' ||
    base === 'pnpm-lock.yaml' ||
    base === 'yarn.lock'
  )
}

function copyApp(sourceDir, destinationDir) {
  fs.cpSync(sourceDir, destinationDir, {
    recursive: true,
    filter: (source) => !isIgnoredCopyPath(source),
  })
}

function collectFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!ignoredDirNames.has(entry.name)) collectFiles(full, files)
      continue
    }
    if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(full)
    }
  }
  return files
}

function legacyImportFailures(appDir) {
  const failures = []
  for (const file of collectFiles(appDir)) {
    const matches = findLegacyDomecsImportSpecifiers(fs.readFileSync(file, 'utf8'))
    if (matches.length > 0) {
      failures.push({
        file,
        specifiers: matches,
      })
    }
  }
  return failures
}

function packageUsesDomecs(packageJson) {
  return dependencySections.some((section) => {
    const deps = packageJson[section]
    return deps && Object.keys(deps).some((key) => packageAliases.has(key))
  })
}

function discoverWorkspaceApps(root) {
  const examplesDir = path.join(root, 'example')
  if (!fs.existsSync(examplesDir)) return []
  return fs
    .readdirSync(examplesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(examplesDir, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
    .map((dir) => ({
      kind: 'workspace',
      name: path.basename(dir),
      sourceDir: dir,
      stageRelativeDir: path.join('domecs', 'example', path.basename(dir)),
    }))
}

function discoverOrgApps(root) {
  return orgAppCandidates
    .map((relativeDir) => path.resolve(root, relativeDir))
    .filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
    .map((dir) => ({
      kind: 'org',
      name: path.basename(dir),
      sourceDir: dir,
      stageRelativeDir: path.basename(dir),
    }))
}

function discoverApps(root, options) {
  const apps = []
  if (options.includeWorkspace) apps.push(...discoverWorkspaceApps(root))
  if (options.includeOrg) apps.push(...discoverOrgApps(root))

  return apps.filter((app) => {
    const packageJson = readJson(path.join(app.sourceDir, 'package.json'))
    if (packageUsesDomecs(packageJson)) return true
    return legacyImportFailures(app.sourceDir).length > 0
  })
}

function ensureSharedTsconfig(stageRoot) {
  const source = path.join(workspaceRoot, 'tsconfig.base.json')
  const destination = path.join(stageRoot, 'domecs', 'tsconfig.base.json')
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
}

function buildAndPack(packDir) {
  run('pnpm', ['-r', '--filter', './packages/*', 'build'])

  const tarballs = {}
  for (const pkg of runtimePackages) {
    const output = run(
      'pnpm',
      [
        '--dir',
        path.join(workspaceRoot, pkg.dir),
        'pack',
        '--pack-destination',
        packDir,
        '--json',
      ],
      { capture: true },
    )
    const packed = JSON.parse(output)
    tarballs[pkg.name] = packed.filename
  }
  return tarballs
}

function stageApp(app, stageRoot, tarballs) {
  const stageDir = path.join(stageRoot, app.stageRelativeDir)
  copyApp(app.sourceDir, stageDir)

  const packageFile = path.join(stageDir, 'package.json')
  const packageJson = readJson(packageFile)
  const tarballSpecs = Object.fromEntries(
    Object.entries(tarballs).map(([name, filename]) => [
      name,
      fileDependencySpec(stageDir, filename),
    ]),
  )
  const rewritten = rewriteDomecsDependencies(packageJson, tarballSpecs)
  writeJson(packageFile, rewritten.packageJson)

  const legacyFailures = legacyImportFailures(stageDir)
  if (legacyFailures.length > 0) {
    const lines = legacyFailures.map((failure) => {
      const rel = path.relative(stageDir, failure.file).replaceAll(path.sep, '/')
      return `  ${app.name}/${rel}: ${failure.specifiers.join(', ')}`
    })
    throw new Error(
      [
        `${app.name} still imports old DOMECS package names.`,
        'Update source imports to @domecs/core, @domecs/dom, and @domecs/input.',
        ...lines,
      ].join('\n'),
    )
  }

  return {
    ...app,
    stageDir,
    packageJson: rewritten.packageJson,
    usedPackages: rewritten.usedPackages,
  }
}

function runAppSmoke(app, options) {
  const scripts = app.packageJson.scripts ?? {}
  const installCommand = process.env.DOMECS_RELEASE_INSTALLER ?? 'npm'

  if (options.skipInstall) {
    console.log(`[dry-run] ${app.name}: staged with ${app.usedPackages.join(', ')}`)
    return
  }

  if (app.usedPackages.length === 0) {
    console.log(`[skip] ${app.name}: no @domecs runtime package dependencies`)
    return
  }

  if (installCommand === 'pnpm') {
    run('pnpm', ['install', '--ignore-workspace'], { cwd: app.stageDir })
  } else {
    run('npm', ['install', '--package-lock=false'], { cwd: app.stageDir })
  }

  // ESM import smoke: prove every packed @domecs package this app uses
  // actually loads from the staged install before exercising the app scripts.
  const probeFile = writeEsmImportProbeFile(app.stageDir, app.usedPackages)
  try {
    run('node', [path.basename(probeFile)], { cwd: app.stageDir })
  } finally {
    fs.rmSync(probeFile, { force: true })
  }

  if (scripts.test) {
    run(installCommand, installCommand === 'pnpm' ? ['test'] : ['test'], {
      cwd: app.stageDir,
    })
  }
  if (scripts.build) {
    run(installCommand, installCommand === 'pnpm' ? ['run', 'build'] : ['run', 'build'], {
      cwd: app.stageDir,
    })
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const tmpRoot = path.join(workspaceRoot, '.tmp')
  const releaseRoot = path.join(tmpRoot, 'release-validation')
  const packDir = path.join(releaseRoot, 'packs')
  const stageRoot = path.join(releaseRoot, 'stage')

  safeResetDir(releaseRoot, tmpRoot)
  fs.mkdirSync(packDir, { recursive: true })
  fs.mkdirSync(stageRoot, { recursive: true })
  ensureSharedTsconfig(stageRoot)

  const apps = discoverApps(workspaceRoot, options)
  if (apps.length === 0) {
    throw new Error('No DOMECS example apps were found to validate')
  }

  const tarballs = options.dryRun
    ? Object.fromEntries(
      runtimePackages.map((pkg) => [
        pkg.name,
        path.join(packDir, `${pkg.name.replace('@', '').replace('/', '-')}.tgz`),
      ]),
    )
    : buildAndPack(packDir)

  const stagedApps = apps.map((app) => stageApp(app, stageRoot, tarballs))
  for (const app of stagedApps) {
    runAppSmoke(app, options)
  }

  console.log(
    `Release validation ${options.skipInstall ? 'staged' : 'passed'} for ${stagedApps.length} app(s).`,
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
