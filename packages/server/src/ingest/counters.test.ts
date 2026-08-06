import { type Pool, createPgPool } from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { IngestCounters } from './counters.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
let projectId: number

beforeAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', ['counters-test'])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Counters', 'counters-test', 'wk_counters', 'h') RETURNING id`,
  )
  projectId = Number(r.rows[0]?.id)
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', ['counters-test'])
  await pg.end()
})

describe('IngestCounters', () => {
  it('accumulates in memory and writes one row per project and month', async () => {
    const c = new IngestCounters(pg)
    c.record(projectId, 'accepted', 5)
    c.record(projectId, 'accepted', 3)
    c.record(projectId, 'rejected')
    await c.flush()

    const r = await pg.query<{ events_accepted: string; events_rejected: string }>(
      'SELECT events_accepted, events_rejected FROM ingest_counters WHERE project_id = $1',
      [projectId],
    )
    expect(Number(r.rows[0]?.events_accepted)).toBe(8)
    expect(Number(r.rows[0]?.events_rejected)).toBe(1)
  })

  it('adds to the existing row on a later flush rather than replacing it', async () => {
    const c = new IngestCounters(pg)
    c.record(projectId, 'accepted', 2)
    await c.flush()
    const r = await pg.query<{ events_accepted: string }>(
      'SELECT events_accepted FROM ingest_counters WHERE project_id = $1',
      [projectId],
    )
    expect(Number(r.rows[0]?.events_accepted)).toBe(10)
  })

  it('is a no-op when nothing was recorded', async () => {
    const c = new IngestCounters(pg)
    await expect(c.flush()).resolves.toBeUndefined()
  })

  it('re-buffers a failed write so a later successful flush still persists it', async () => {
    // Minimal fake satisfying only the `query` method IngestCounters calls;
    // cast through `unknown` since it doesn't implement pg's full Pool
    // surface. The first call fails to simulate a DB blip; later calls
    // forward to the real pool so the retry can actually land in Postgres.
    let shouldFail = true
    const flaky = {
      query: (text: string, values?: unknown[]) => {
        if (shouldFail) {
          shouldFail = false
          return Promise.reject(new Error('connection reset'))
        }
        return pg.query(text, values)
      },
    } as unknown as Pool

    const c = new IngestCounters(flaky)
    c.record(projectId, 'accepted', 4)
    await expect(c.flush()).rejects.toThrow()

    // Recording again before the retry proves the re-buffered tally merges
    // with new activity rather than being discarded or overwritten by it.
    c.record(projectId, 'accepted', 1)
    await c.flush()

    const r = await pg.query<{ events_accepted: string }>(
      'SELECT events_accepted FROM ingest_counters WHERE project_id = $1',
      [projectId],
    )
    // 10 from the two earlier tests, plus the re-buffered 4, plus the 1
    // recorded during the outage window: 15.
    expect(Number(r.rows[0]?.events_accepted)).toBe(15)
  })
})
