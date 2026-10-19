/**
 * E1.6 / spec §8 "Getting builds to studio": scripts/pack-for-studio.mjs
 * builds, stamps BUILD_ID and the packed version with build metadata, packs
 * all seven @domecs packages, writes manifest.json, and leaves the working
 * tree as it found it. Packs into a temp dir; no network.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { PACKAGES, readTarEntry } from '../scripts/pack-for-studio.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(fs.readFileSync(path.join(root, 'packages/domecs/package.json'), 'utf8')).version

function git(...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

test('pack-for-studio packs seven stamped tarballs and a manifest, then restores the tree', { timeout: 600_000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'domecs-pack-'))
  const statusBefore = git('status', '--porcelain')
  const pkgJsonBefore = PACKAGES.map((p) => fs.readFileSync(path.join(root, p.dir, 'package.json'), 'utf8'))
  try {
    // A stale tarball from an earlier pack is replaced, not left beside.
    fs.writeFileSync(path.join(out, 'domecs-core-0.0.1+gdeadbee.tgz'), 'stale')
    fs.writeFileSync(path.join(out, 'unrelated.txt'), 'keep me')

    const r = spawnSync(process.execPath, [path.join(root, 'scripts/pack-for-studio.mjs'), '--out', out], {
      cwd: root,
      encoding: 'utf8',
      timeout: 540_000,
    })
    assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`)

    const sha = git('rev-parse', 'HEAD')
    const dirty = statusBefore !== ''
    const buildId = `${version}+g${sha.slice(0, 7)}${dirty ? '-dirty' : ''}`

    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'))
    assert.equal(manifest.version, version)
    assert.equal(manifest.buildId, buildId)
    assert.equal(manifest.gitSha, sha)
    assert.equal(manifest.dirty, dirty)
    assert.ok(!Number.isNaN(Date.parse(manifest.packedAt)), 'packedAt is an ISO timestamp')
    assert.deepEqual(Object.keys(manifest.packages).sort(), PACKAGES.map((p) => p.name).sort())

    // §3.4: the determinism golden script travels with the tarballs, so studio
    // can run the engine's own golden under its pinned Electron (G-engine).
    const goldenSrc = fs.readFileSync(path.join(root, 'scripts/determinism-golden.mjs'))
    assert.deepEqual(fs.readFileSync(path.join(out, 'determinism-golden.mjs')), goldenSrc)
    assert.deepEqual(manifest.golden, {
      file: 'determinism-golden.mjs',
      integrity: `sha512-${createHash('sha512').update(goldenSrc).digest('base64')}`,
    })

    const tarballs = fs.readdirSync(out).filter((f) => f.endsWith('.tgz')).sort()
    assert.equal(tarballs.length, 7, tarballs.join(', '))
    assert.ok(fs.existsSync(path.join(out, 'unrelated.txt')), 'only our own stale tarballs are removed')

    for (const p of PACKAGES) {
      const short = p.name.replace('@domecs/', '')
      const file = `domecs-${short}-${buildId}.tgz`
      const entry = manifest.packages[p.name]
      assert.deepEqual(entry, {
        file,
        integrity: `sha512-${createHash('sha512').update(fs.readFileSync(path.join(out, file))).digest('base64')}`,
        buildId,
      })

      const tgz = path.join(out, file)
      const pkg = JSON.parse(readTarEntry(tgz, 'package/package.json').toString('utf8'))
      assert.equal(pkg.name, p.name)
      assert.equal(pkg.version, buildId)
      const text = JSON.stringify(pkg)
      assert.ok(!text.includes('workspace:'), `${p.name}: workspace: protocol left in packed package.json`)
      if (p.name !== '@domecs/core') {
        assert.equal(pkg.peerDependencies['@domecs/core'], `^${version}`)
      }
      // publishConfig applied: the packed entry points are the built dist.
      assert.equal(pkg.main, './dist/index.js')

      const stamp = readTarEntry(tgz, 'package/dist/build-id.js').toString('utf8')
      const tmp = path.join(out, `${short}-build-id.mjs`)
      fs.writeFileSync(tmp, stamp)
      const mod = await import(pathToFileURL(tmp).href)
      assert.equal(mod.BUILD_ID, buildId)
    }

    // Working tree restored: package.json bytes and dist/build-id.js back to source values.
    PACKAGES.forEach((p, i) => {
      assert.equal(fs.readFileSync(path.join(root, p.dir, 'package.json'), 'utf8'), pkgJsonBefore[i])
      assert.match(fs.readFileSync(path.join(root, p.dir, 'dist/build-id.js'), 'utf8'), /BUILD_ID = 'dev'/)
    })
    assert.equal(git('status', '--porcelain'), statusBefore)
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
})

test('pack-for-studio refuses to run without --out', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/pack-for-studio.mjs')], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /--out/)
})
