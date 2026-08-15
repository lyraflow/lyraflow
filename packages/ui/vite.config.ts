import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // shadcn's vendored components import via "@/..."; this is the only
    // alias they assume exists.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // The API and the SDK bundle are served by the Lyraflow server, not by
    // Vite -- this proxies both to it so the dev server can serve the SPA
    // while still reaching a real backend.
    proxy: {
      '/v1': 'http://localhost:3000',
      '/lyraflow.js': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
})
