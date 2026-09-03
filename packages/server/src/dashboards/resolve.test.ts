import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FunnelStore } from '../funnels/store.js'
import { RetentionReportStore } from '../reports/retention-store.js'
import { TrendStore } from '../reports/trend-store.js'
import { resolveTiles } from './resolve.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})

let projectA: number
let projectB: number
const stores = {
  trends: new TrendStore(pg),
  retention: new RetentionReportStore(pg),
  funnels: new FunnelStore(pg),
}

async function project(slug: string): Promise<number> {
  await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $1, $2, $3) RETURNING id`,
    [slug, `wk_${slug}`, `hash_${slug}`],
  )
  return Number(r.rows[0]?.id)
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  projectA = await project('dash-resolve-a')
  projectB = await project('dash-resolve-b')
})

beforeEach(async () => {
  for (const t of ['trend_reports', 'retention_reports', 'funnels']) {
    await pg.query(`DELETE FROM ${t} WHERE project_id = ANY($1)`, [[projectA, projectB]])
  }
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [
    ['dash-resolve-a', 'dash-resolve-b'],
  ])
  await pg.end()
  await ch.close()
})

const trendInput = {
  name: 'T',
  event: 'signup',
  interval: '1d' as const,
  group_by: null,
  where: [],
}
const retentionInput = {
  name: 'R',
  start_event: 'signup',
  return_event: 'login',
  start_where: [],
  return_where: [],
  granularity: 'week' as const,
  periods: 8,
  segment_id: null,
}

describe('resolveTiles', () => {
  it('embeds each kind in its own wire shape, in tile order', async () => {
    const t = await stores.trends.create(projectA, trendInput)
    const r = await stores.retention.create(projectA, retentionInput)
    const f = await stores.funnels.create(projectA, 'F', {
      steps: [{ event: 'a' }, { event: 'b' }],
      window_seconds: 3600,
      segment_id: null,
    })
    const out = await resolveTiles(stores, projectA, [
      { kind: 'funnel', report_id: f.id, width: 'full' },
      { kind: 'retention', report_id: r.id, width: 'half' },
      { kind: 'trend', report_id: t.id, width: 'half' },
    ])
    expect(out.map((x) => x.kind)).toEqual(['funnel', 'retention', 'trend'])
    expect(out[0]?.report).toMatchObject({
      id: f.id,
      name: 'F',
      window_seconds: 3600,
      stale: false,
    })
    expect(out[1]?.report).toMatchObject({ id: r.id, name: 'R', granularity: 'week', stale: false })
    expect(out[2]?.report).toMatchObject({ id: t.id, name: 'T', interval: '1d', stale: false })
  })

  it('resolves a missing report to null, keeping the tile', async () => {
    const out = await resolveTiles(stores, projectA, [
      { kind: 'trend', report_id: 999999, width: 'half' },
    ])
    expect(out).toEqual([{ kind: 'trend', report_id: 999999, width: 'half', report: null }])
  })

  it('resolves a report in ANOTHER project to null -- the project boundary', async () => {
    const t = await stores.trends.create(projectB, trendInput)
    const out = await resolveTiles(stores, projectA, [
      { kind: 'trend', report_id: t.id, width: 'half' },
    ])
    expect(out[0]?.report).toBeNull()
  })

  it('embeds a stale funnel as stale rather than failing', async () => {
    const r = await pg.query<{ id: string }>(
      `INSERT INTO funnels (project_id, name, definition_version, steps, window_seconds)
       VALUES ($1, 'Broken', 1, '[{"nonsense":true}]'::jsonb, 60) RETURNING id`,
      [projectA],
    )
    const id = Number(r.rows[0]?.id)
    const out = await resolveTiles(stores, projectA, [
      { kind: 'funnel', report_id: id, width: 'half' },
    ])
    expect(out[0]?.report).toMatchObject({ id, stale: true })
  })

  it('makes no query for a kind no tile uses', async () => {
    const calls: string[] = []
    const spy = {
      trends: {
        list: async (p: number) => {
          calls.push('trends')
          return stores.trends.list(p)
        },
      },
      retention: {
        list: async (p: number) => {
          calls.push('retention')
          return stores.retention.list(p)
        },
      },
      funnels: {
        list: async (p: number) => {
          calls.push('funnels')
          return stores.funnels.list(p)
        },
      },
    } as unknown as typeof stores
    await resolveTiles(spy, projectA, [{ kind: 'trend', report_id: 1, width: 'half' }])
    expect(calls).toEqual(['trends'])
  })

  it('resolves a tile by kind, not by id alone -- a trend and a funnel sharing an id', async () => {
    // Explicit shared id via raw SQL rather than racing two sequences to
    // collide: `trend_reports` and `funnels` each have their own bigserial,
    // so nothing short of forcing the id proves the lookup is kind-scoped.
    const sharedId = 918273
    await pg.query('DELETE FROM trend_reports WHERE id = $1', [sharedId])
    await pg.query('DELETE FROM funnels WHERE id = $1', [sharedId])
    await pg.query(
      `INSERT INTO trend_reports (id, project_id, name, event, interval, group_by, event_where, definition_version)
       VALUES ($1, $2, 'Shared', 'signup', '1d', NULL, '[]'::jsonb, 1)`,
      [sharedId, projectA],
    )
    await pg.query(
      `INSERT INTO funnels (id, project_id, name, definition_version, steps, window_seconds, segment_id)
       VALUES ($1, $2, 'Shared', 2, '[{"event":"a"},{"event":"b"}]'::jsonb, 3600, NULL)`,
      [sharedId, projectA],
    )
    // Both kinds must be REQUESTED (so both `list()`s run and both rows
    // load into memory), not only the funnel one -- otherwise the trend
    // row is simply never fetched and a kind-blind bug has nothing to find.
    const out = await resolveTiles(stores, projectA, [
      { kind: 'trend', report_id: sharedId, width: 'half' },
      { kind: 'funnel', report_id: sharedId, width: 'half' },
    ])
    expect(out[0]?.report).toMatchObject({ id: sharedId, event: 'signup' })
    expect(out[1]?.report).toMatchObject({ id: sharedId, name: 'Shared', window_seconds: 3600 })
    expect(out[1]?.report).not.toMatchObject({ event: 'signup' })
    await pg.query('DELETE FROM trend_reports WHERE id = $1', [sharedId])
    await pg.query('DELETE FROM funnels WHERE id = $1', [sharedId])
  })
})
