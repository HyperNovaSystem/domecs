import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  server: { port: 5173, strictPort: false },
  resolve: {
    preserveSymlinks: false,
  },
})
