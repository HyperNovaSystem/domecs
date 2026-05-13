import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  findLegacyDomecsImportSpecifiers,
  rewriteDomecsDependencies,
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
