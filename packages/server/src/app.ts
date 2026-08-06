import type { ClickHouseClient, Pool } from '@lyraflow/db'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Config } from './config.js'
import { type Readiness, registerHealth } from './health.js'

export interface AppDeps {
  config: Config
  pg: Pool
  ch: ClickHouseClient
  readiness: Readiness
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LYRAFLOW_LOG_LEVEL ?? 'info' },
    // Browsers cannot be trusted to send small bodies; cap before parsing.
    bodyLimit: 1_048_576,
    trustProxy: true,
  })

  app.decorate('deps', deps)
  registerHealth(app, deps.readiness)

  return app
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
  }
}
