import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildEsmImportProbe,
  findLegacyDomecsImportSpecifiers,
  rewriteDomecsDependencies,
  writeEsmImportProbeFile,
} from '../scripts/validate-release.mjs'

test('rewriteDomecsDependencies replaces legacy package keys with packed scoped tarballs', () => {
  const packageJson = {
    dependencies: {
      domecs: 'file:../domecs/packages/domecs',
      'domecs-dom': 'file:../domecs/packages/domecs-dom',
      vite: '^5.4.11',
    },
    devDependencies: {
      'domecs-input': 'file:../domecs/packages/domecs-input',
      typescript: '^5.6.3',
    },
  }

  const result = rewriteDomecsDependencies(packageJson, {
    '@domecs/core': 'file:../packs/domecs-core-0.1.0-alpha.0.tgz',
    '@domecs/dom': 'file:../packs/domecs-dom-0.1.0-alpha.0.tgz',
    '@domecs/input': 'file:../packs/domecs-input-0.1.0-alpha.0.tgz',
  })

  assert.deepEqual(result.usedPackages, [
    '@domecs/core',
    '@domecs/dom',
    '@domecs/input',
  ])
  assert.deepEqual(result.packageJson.dependencies, {
    vite: '^5.4.11',
    '@domecs/core': 'file:../packs/domecs-core-0.1.0-alpha.0.tgz',
    '@domecs/dom': 'file:../packs/domecs-dom-0.1.0-alpha.0.tgz',
  })
  assert.deepEqual(result.packageJson.devDependencies, {
    typescript: '^5.6.3',
    '@domecs/input': 'file:../packs/domecs-input-0.1.0-alpha.0.tgz',
  })
})

test('rewriteDomecsDependencies only adds packed packages an app already uses', () => {
  const result = rewriteDomecsDependencies(
    {
      dependencies: {
        '@domecs/core': 'workspace:*',
        '@domecs/dom': 'workspace:*',
      },
    },
    {
      '@domecs/core': 'file:../packs/domecs-core-0.1.0-alpha.0.tgz',
      '@domecs/dom': 'file:../packs/domecs-dom-0.1.0-alpha.0.tgz',
      '@domecs/input': 'file:../packs/domecs-input-0.1.0-alpha.0.tgz',
    },
  )

  assert.deepEqual(result.packageJson.dependencies, {
    '@domecs/core': 'file:../packs/domecs-core-0.1.0-alpha.0.tgz',
    '@domecs/dom': 'file:../packs/domecs-dom-0.1.0-alpha.0.tgz',
  })
  assert.equal(result.packageJson.dependencies['@domecs/input'], undefined)
})

test('rewriteDomecsDependencies covers inspector and persist (review #11)', () => {
  const result = rewriteDomecsDependencies(
    {
      dependencies: {
        '@domecs/core': 'workspace:*',
        '@domecs/inspector': 'workspace:*',
        '@domecs/persist': 'workspace:*',
      },
    },
    {
      '@domecs/core': 'file:../packs/domecs-core-0.1.0-alpha.0.tgz',
      '@domecs/dom': 'file:../packs/domecs-dom-0.1.0-alpha.0.tgz',
      '@domecs/input': 'file:../packs/domecs-input-0.1.0-alpha.0.tgz',
      '@domecs/inspector': 'file:../packs/domecs-inspector-0.1.0-alpha.0.tgz',
      '@domecs/persist': 'file:../packs/domecs-persist-0.1.0-alpha.0.tgz',
    },
  )

  assert.deepEqual(result.packageJson.dependencies, {
    '@domecs/core': 'file:../packs/domecs-core-0.1.0-alpha.0.tgz',
    '@domecs/inspector': 'file:../packs/domecs-inspector-0.1.0-alpha.0.tgz',
    '@domecs/persist': 'file:../packs/domecs-persist-0.1.0-alpha.0.tgz',
  })
  assert.deepEqual(result.usedPackages, [
    '@domecs/core',
    '@domecs/inspector',
    '@domecs/persist',
  ])
})

test('buildEsmImportProbe imports every used package and prints the ok marker (review #11)', () => {
  const probe = buildEsmImportProbe(['@domecs/core', '@domecs/persist'])
  assert.match(probe, /import\(['"]@domecs\/core['"]\)/)
  assert.match(probe, /import\(['"]@domecs\/persist['"]\)/)
  assert.match(probe, /domecs-esm-smoke-ok/)
})

test('buildEsmImportProbe rejects a package name that could break out of the string literal', () => {
  assert.throws(() => buildEsmImportProbe(["@domecs/core')\nprocess.exit(1)//"]), /invalid package name/i)
})

test('writeEsmImportProbeFile writes the probe to a file so it survives win32 shell quoting', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domecs-probe-'))
  try {
    const file = writeEsmImportProbeFile(dir, ['@domecs/core', '@domecs/dom'])
    assert.equal(path.dirname(file), dir)
    const source = fs.readFileSync(file, 'utf8')
    assert.match(source, /import\(['"]@domecs\/core['"]\)/)
    assert.match(source, /import\(['"]@domecs\/dom['"]\)/)
    assert.match(source, /domecs-esm-smoke-ok/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('findLegacyDomecsImportSpecifiers flags old runtime imports only', () => {
  const matches = findLegacyDomecsImportSpecifiers(`
    import { createWorld } from 'domecs'
    import { mountDOM } from "domecs-dom"
    import { createInputPlugin } from 'domecs-input'
    const docs = 'domecs/doc/exemplars.md'
    import { createWorld as ok } from '@domecs/core'
  `)

  assert.deepEqual(matches, ['domecs', 'domecs-dom', 'domecs-input'])
})
