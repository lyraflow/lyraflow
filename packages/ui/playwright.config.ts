import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // One path, run once. This suite exists to prove the built assets, the
  // static serving, the real cookie and the API work together -- not to
  // cover behaviour, which the unit suite does far more cheaply.
  workers: 1,
  retries: 0,
  timeout: 60_000,
  // IMPORTANT 5 from the whole-branch review: with no `reporter` set,
  // Playwright's CI default is `dot` -- the `html` reporter (and the
  // `playwright-report/` directory it writes) is added by `create-
  // playwright`'s scaffolding, not a default of the test runner itself.
  // Proved against a real failing run: only `test-results/**/trace.zip`
  // came out, no `playwright-report/` at all, so `ci.yml`'s own
  // `upload-artifact` step (targeting exactly that path, "on failure") had
  // nothing to upload -- the first time this suite actually went red, the
  // one artifact its own workflow comment promises would not exist.
  // `open: 'never'` because this only ever runs in CI; nothing here should
  // try to launch a local browser to view it.
  reporter: [['html', { open: 'never' }], ['dot']],
  use: {
    baseURL: process.env.LYRAFLOW_E2E_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
})
