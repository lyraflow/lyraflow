import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // One path, run once. This suite exists to prove the built assets, the
  // static serving, the real cookie and the API work together -- not to
  // cover behaviour, which the unit suite does far more cheaply.
  workers: 1,
  retries: 0,
  timeout: 60_000,
  use: {
    baseURL: process.env.LYRAFLOW_E2E_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
})
