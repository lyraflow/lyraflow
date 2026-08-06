import type { FastifyInstance } from 'fastify'

export interface MetricsDeps {
  bufferDepth: () => number
  totals: () => { accepted: number; rejected: number; throttled: number }
}

/**
 * Hand-rolled rather than pulling in a client library: four numbers do not
 * justify a dependency, and the exposition format is trivial.
 */
export function registerMetrics(app: FastifyInstance, deps: MetricsDeps): void {
  app.get('/metrics', async (_req, reply) => {
    const totals = deps.totals()
    const lines = [
      // depth is queued + in-flight rows (IngestBuffer.depth), not queue
      // length — a batch handed to ClickHouse but not yet acknowledged still
      // counts, because it is still memory Lyraflow is holding on the
      // caller's behalf and still at risk if the process dies uncleanly.
      '# HELP lyraflow_ingest_buffer_depth Events accepted but not yet durably written to ClickHouse (queued plus in-flight).',
      '# TYPE lyraflow_ingest_buffer_depth gauge',
      `lyraflow_ingest_buffer_depth ${deps.bufferDepth()}`,
      '# HELP lyraflow_ingest_events_total Individual events by outcome since process start (not HTTP responses — one batch request can carry up to 500).',
      '# TYPE lyraflow_ingest_events_total counter',
      `lyraflow_ingest_events_total{outcome="accepted"} ${totals.accepted}`,
      `lyraflow_ingest_events_total{outcome="rejected"} ${totals.rejected}`,
      `lyraflow_ingest_events_total{outcome="throttled"} ${totals.throttled}`,
    ]
    return reply.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`)
  })
}
