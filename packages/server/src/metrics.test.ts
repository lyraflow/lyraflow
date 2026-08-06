import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerMetrics } from './metrics.js'

describe('metrics', () => {
  it('exposes buffer depth and ingest totals in Prometheus text format', async () => {
    const app = Fastify()
    registerMetrics(app, {
      bufferDepth: () => 42,
      totals: () => ({ accepted: 10, rejected: 2, throttled: 1 }),
    })
    const res = await app.inject({ method: 'GET', url: '/metrics' })

    expect(res.headers['content-type']).toContain('text/plain')
    // Full-body equality, not spot-checked substrings: the Prometheus text
    // exposition format requires every emitted metric to carry both a HELP
    // and a TYPE line and the body to end in a trailing newline — a scraper
    // parsing this strictly would reject a body missing any of those, and a
    // partial `toContain` check can't tell "present" apart from "malformed
    // and coincidentally contains this substring". This pins the entire
    // 8-line body, including the previously-unasserted `rejected` series,
    // the `# TYPE lyraflow_ingest_events_total counter` line, and the
    // trailing `\n`.
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
        '',
      ].join('\n'),
    )
  })
})
