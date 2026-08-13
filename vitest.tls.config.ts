import { defineConfig } from 'vitest/config'

// Separate from vitest.durability.config.ts because this suite binds 80 and
// 443 on top of the 3000 the CI stack already takes, and both configs call
// `down -v`. Two of them on one machine is not a slow test, it is a pair of
// failures that read as broken code.
export default defineConfig({
  test: {
    include: ['test/tls-proxy.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
})
