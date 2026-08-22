import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

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
    // `e2e/` holds Playwright specs, run only by `playwright test`
    // (playwright.config.ts) -- vitest's default include glob matches
    // `*.spec.ts` too, and without this exclude it tries to import
    // `@playwright/test`'s own `test()` outside Playwright's runner and
    // fails the whole suite with "Playwright Test did not expect test() to
    // be called here."
    // `dist/**` for a second reason of the same kind: `pnpm build` runs
    // `tsc -b`, which emits every `.test.tsx` beside the source it compiled,
    // so a built package carries a JS copy of its own suite. Vitest then
    // collects both, and the copy runs against stale output from whenever
    // the last build happened -- passing or failing for reasons unrelated to
    // the source. It stayed invisible until this branch added a test file
    // that did not exist in an older `dist`, at which point the suite grew
    // two phantom files that no source change could fix.
    exclude: [...configDefaults.exclude, 'e2e/**', 'dist/**'],
  },
})
