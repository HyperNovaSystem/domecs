import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  server: { port: 5175, strictPort: false },
  resolve: { preserveSymlinks: false },
})
