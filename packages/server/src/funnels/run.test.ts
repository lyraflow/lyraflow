import { createChClient, createPgPool } from '@lyraflow/db'
import { afterAll, describe, expect, it } from 'vitest'
import { FUNNEL_DEFAULT_RANGE_MS, makeFunnelRunner } from './run.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})
const runner = makeFunnelRunner({ ch, pg, database: 'lyraflow_test' })

afterAll(async () => {
  await pg.end()
  await ch.close()
})

describe('makeFunnelRunner', () => {
  it('runs a two-step funnel over an empty project and echoes the range', async () => {
    const since = new Date('2026-09-01T00:00:00.000Z')
    const until = new Date('2026-09-05T00:00:00.000Z')
    const body = await runner.execute(
      { id: 999_999_999 },
      { steps: [{ event: 'a' }, { event: 'b' }], windowSeconds: 3600, segmentId: null },
      { since, until },
    )
    expect(body.entered).toBe(0)
    expect(body.range).toEqual({ since: since.toISOString(), until: until.toISOString() })
    expect(body.warnings).toEqual([])
  })

  it('warns and runs wide when the segment is gone', async () => {
    const body = await runner.execute(
      { id: 999_999_999 },
      { steps: [{ event: 'a' }, { event: 'b' }], windowSeconds: 3600, segmentId: 987_654_321 },
      { since: new Date(Date.now() - FUNNEL_DEFAULT_RANGE_MS), until: new Date() },
    )
    expect(body.warnings).toEqual([expect.objectContaining({ path: 'segment_id' })])
  })
})
