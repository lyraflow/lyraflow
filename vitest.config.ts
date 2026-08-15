import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // packages/ui runs under its own vitest (packages/ui/vite.config.ts), with a
    // jsdom environment, globals and a setup file this root config does not
    // provide. The include glob above only matches `.test.ts`, so `.test.tsx`
    // files were never collected here anyway -- but a `.test.ts` file under
    // packages/ui would have matched and then failed with "document is not
    // defined", or worse, silently run with no DOM. A partial match here is
    // worse than no match: it looks like coverage. Excluded explicitly so this
    // runner never reaches into packages/ui at all; `pnpm test` at the root
    // reaches it instead by chaining into `packages/ui`'s own `test` script.
    // Spread vitest's own default excludes (node_modules, dist, ...) rather
    // than replacing them -- `exclude` overwrites the default array entirely
    // if not merged in.
    exclude: [...configDefaults.exclude, 'packages/ui/**'],
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
