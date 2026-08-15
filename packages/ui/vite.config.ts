import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // The API and the SDK bundle are served by the Fastify process, not by
    // Vite. On zeus that process runs inside the Incus container while Vite
    // runs on the host, so this target is the container's published port.
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
