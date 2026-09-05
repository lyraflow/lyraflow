import { createChClient, createPgPool } from '@lyraflow/db'
import { afterAll, describe, expect, it } from 'vitest'
import { RetentionBody, runRetentionReport } from './retention-run.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})
const deps = { ch, pg, database: 'lyraflow_test' }

afterAll(async () => {
  await pg.end()
  await ch.close()
})

describe('RetentionBody', () => {
  it('defaults granularity and periods', () => {
    const parsed = RetentionBody.parse({ start_event: 'a', return_event: 'b' })
    expect(parsed.granularity).toBe('week')
    expect(parsed.periods).toBe(8)
  })
})

describe('runRetentionReport', () => {
  it('computes an empty grid for an empty project and echoes the definition', async () => {
    const body = await runRetentionReport(
      deps,
      { id: 999_999_999 },
      RetentionBody.parse({
        start_event: 'signed_up',
        return_event: 'came_back',
        granularity: 'day',
        periods: 3,
      }),
    )
    expect(body.start_event).toBe('signed_up')
    expect(body.return_event).toBe('came_back')
    expect(body.granularity).toBe('day')
    expect(body.warnings).toEqual([])
    expect(typeof body.computed_at).toBe('string')
  })

  it('warns when the segment no longer exists, and still runs', async () => {
    const body = await runRetentionReport(
      deps,
      { id: 999_999_999 },
      RetentionBody.parse({
        start_event: 'a',
        return_event: 'b',
        segment_id: 987_654_321,
      }),
    )
    expect(body.warnings).toEqual([expect.objectContaining({ path: 'segment_id' })])
  })
})
