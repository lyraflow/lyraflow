import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerMetrics } from './metrics.js'

describe('metrics', () => {
  it('exposes buffer depth, ingest totals and retention state in Prometheus text format', async () => {
    const app = Fastify()
    registerMetrics(app, {
      bufferDepth: () => 42,
      totals: () => ({ accepted: 10, rejected: 2, throttled: 1, over_quota: 3, bot: 7 }),
      retention: () => ({ lastRunAt: null, partitionsDropped: 0 }),
    })
    const res = await app.inject({ method: 'GET', url: '/metrics' })

    expect(res.headers['content-type']).toContain('text/plain')
    // Full-body equality, not spot-checked substrings: the Prometheus text
    // exposition format requires every emitted metric to carry both a HELP
    // and a TYPE line and the body to end in a trailing newline — a scraper
    // parsing this strictly would reject a body missing any of those, and a
    // partial `toContain` check can't tell "present" apart from "malformed
    // and coincidentally contains this substring". This pins the entire
    // body, including the retention series added in Plan 9.
    expect(res.body).toBe(
      [
        '# HELP lyraflow_ingest_buffer_depth Events accepted but not yet durably written to ClickHouse (queued plus in-flight).',
        '# TYPE lyraflow_ingest_buffer_depth gauge',
        'lyraflow_ingest_buffer_depth 42',
        '# HELP lyraflow_ingest_events_total Individual events by outcome since process start (not HTTP responses — one batch request can carry up to 500).',
        '# TYPE lyraflow_ingest_events_total counter',
        'lyraflow_ingest_events_total{outcome="accepted"} 10',
        'lyraflow_ingest_events_total{outcome="rejected"} 2',
        'lyraflow_ingest_events_total{outcome="throttled"} 1',
        'lyraflow_ingest_events_total{outcome="over_quota"} 3',
        'lyraflow_ingest_events_total{outcome="bot"} 7',
        "# HELP lyraflow_retention_last_run_timestamp_seconds Unix time of the retention worker's last completed run; 0 before the first one. A worker that has silently stopped is indistinguishable from one with nothing to drop, so alert on this going stale rather than on its value.",
        '# TYPE lyraflow_retention_last_run_timestamp_seconds gauge',
        'lyraflow_retention_last_run_timestamp_seconds 0',
        '# HELP lyraflow_retention_partitions_dropped_total ClickHouse partitions the retention worker has actually dropped since process start. A dry run or a run that found nothing expired does not advance this.',
        '# TYPE lyraflow_retention_partitions_dropped_total counter',
        'lyraflow_retention_partitions_dropped_total 0',
        '',
      ].join('\n'),
    )
  })

  it('reports lastRunAt as a Unix-seconds gauge once a run has completed, and a nonzero dropped-partitions counter', async () => {
    const app = Fastify()
    // 2026-08-09T12:00:00.000Z, an arbitrary fixed instant — the point is
    // the ms->s conversion and truncation, not any particular date.
    const lastRunAt = Date.UTC(2026, 7, 9, 12, 0, 0)
    registerMetrics(app, {
      bufferDepth: () => 0,
      totals: () => ({ accepted: 0, rejected: 0, throttled: 0, over_quota: 0, bot: 0 }),
      retention: () => ({ lastRunAt, partitionsDropped: 7 }),
    })
    const res = await app.inject({ method: 'GET', url: '/metrics' })

    expect(res.body).toContain('lyraflow_retention_last_run_timestamp_seconds 1786276800')
    expect(res.body).toContain('lyraflow_retention_partitions_dropped_total 7')
  })
})
