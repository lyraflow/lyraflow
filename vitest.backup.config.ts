import { defineConfig } from 'vitest/config'

// The backup and restore suites, split out of vitest.durability.config.ts so
// they get their own CI job. Together they run for roughly a quarter of an
// hour — they take backups, destroy both Docker volumes, and restore — and
// leaving them in the durability job took it from under three minutes to
// nearly seventeen.
//
// The split is deliberately by EXCLUSION over there rather than inclusion
// here: `vitest.durability.config.ts` keeps `test/*.test.ts` and subtracts
// exactly these two files. A new `test/*.test.ts` therefore lands in the
// durability job automatically. Had it been the other way round — each config
// naming its own files — a new suite would belong to neither job and nothing
// would say so, which is the shape of silent coverage loss this repository has
// paid for more than once.
//
// `fileParallelism: false` for the same reason the durability config sets it:
// both files drive `docker-compose.ci.yml`, and both call `down -v`.
export default defineConfig({
  test: {
    include: ['test/backup-restore.test.ts', 'test/clickhouse-backup.test.ts'],
    testTimeout: 900_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
})
