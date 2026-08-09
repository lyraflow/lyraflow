import type { FastifyInstance } from 'fastify'

export interface MetricsDeps {
  bufferDepth: () => number
  totals: () => { accepted: number; rejected: number; throttled: number }
  retention: () => { lastRunAt: number | null; partitionsDropped: number }
}

/**
 * Hand-rolled rather than pulling in a client library: four numbers do not
 * justify a dependency, and the exposition format is trivial.
 */
export function registerMetrics(app: FastifyInstance, deps: MetricsDeps): void {
  app.get('/metrics', async (_req, reply) => {
    const totals = deps.totals()
    const retention = deps.retention()
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
      // A retention worker that has silently stopped — crashed, wedged,
      // never started — looks exactly like one that is running fine with
      // nothing left to expire: neither shows up as an error, a failed
      // request, or any other signal this process already surfaces. This
      // timestamp is the only thing that tells the two apart. Alert on it
      // going STALE (older than roughly a couple of run intervals), not on
      // its value: 0 before the first run is expected on every fresh
      // install and is not itself a problem.
      "# HELP lyraflow_retention_last_run_timestamp_seconds Unix time of the retention worker's last completed run; 0 before the first one. A worker that has silently stopped is indistinguishable from one with nothing to drop, so alert on this going stale rather than on its value.",
      '# TYPE lyraflow_retention_last_run_timestamp_seconds gauge',
      `lyraflow_retention_last_run_timestamp_seconds ${retention.lastRunAt === null ? 0 : Math.floor(retention.lastRunAt / 1000)}`,
      '# HELP lyraflow_retention_partitions_dropped_total ClickHouse partitions the retention worker has actually dropped since process start. A dry run or a run that found nothing expired does not advance this.',
      '# TYPE lyraflow_retention_partitions_dropped_total counter',
      `lyraflow_retention_partitions_dropped_total ${retention.partitionsDropped}`,
    ]
    return reply.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`)
  })
}
