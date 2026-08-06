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
    expect(res.body).toContain('lyraflow_ingest_buffer_depth 42')
    expect(res.body).toContain('lyraflow_ingest_events_total{outcome="accepted"} 10')
    expect(res.body).toContain('lyraflow_ingest_events_total{outcome="throttled"} 1')
    expect(res.body).toContain('# TYPE lyraflow_ingest_buffer_depth gauge')
  })
})
