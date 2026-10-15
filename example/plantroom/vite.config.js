import { defineConfig } from 'vite'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
// Project Pages: https://hypernovasystem.github.io/domecs/
// Local dev / preview: base '/'. CI and PLANTROOM_BASE=/domecs/ use project path.
const base =
  process.env.PLANTROOM_BASE ??
  (process.env.GITHUB_ACTIONS === 'true' ? '/domecs/' : '/')

export default defineConfig({
  root,
  base,
  resolve: {
    // Prefer TypeScript source for monorepo DX (same as other exemplars).
    // Staged outside the repo (release validation) there is no source, and
    // the installed packages are used.
    alias: existsSync(path.resolve(root, '../../packages/domecs/src/index.ts'))
      ? {
          '@domecs/core': path.resolve(root, '../../packages/domecs/src/index.ts'),
          '@domecs/dom': path.resolve(root, '../../packages/domecs-dom/src/index.ts'),
        }
      : {},
  },
  server: { port: 5179 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
