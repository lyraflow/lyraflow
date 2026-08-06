import { defineConfig } from 'vitest/config'

// Deliberately separate from vitest.config.ts rather than adding
// `test/*.test.ts` to its `include`: Vitest's CLI filter (the file path
// passed after `run`) only narrows files already matched by `include` — it
// cannot pull in a file `include` excludes. Broadening the root config's
// `include` to cover this file would make plain `pnpm test` (`vitest run`
// with no filter) pick it up too, turning every fast unit-test run into one
// that spins up Docker containers and takes minutes. This config exists so
// `pnpm vitest run --config vitest.durability.config.ts` can find the file
// while `vitest.config.ts` stays scoped to `packages/*/src/**/*.test.ts`.
export default defineConfig({
  test: {
    include: ['test/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
