import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root,
  resolve: {
    alias: {
      // Prefer TypeScript source for monorepo DX (same as other exemplars).
      '@domecs/core': path.resolve(root, '../../packages/domecs/src/index.ts'),
      '@domecs/dom': path.resolve(root, '../../packages/domecs-dom/src/index.ts'),
    },
  },
  server: { port: 5179 },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
