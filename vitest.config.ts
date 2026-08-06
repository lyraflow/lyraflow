import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Multiple test files now share the same live Postgres/ClickHouse test
    // containers (migrator.test.ts and schema-postgres.test.ts both DROP and
    // recreate the same tables). Running files in parallel races their
    // setup/teardown against each other's queries; running them sequentially
    // keeps each file's fixtures stable for the duration of its own tests.
    fileParallelism: false,
  },
})
