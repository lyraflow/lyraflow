import { createChClient, createPgPool } from '@lyraflow/db'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { Readiness } from './health.js'

const config = loadConfig(process.env)
const pg = createPgPool(config.pgUrl)
const ch = createChClient(config.ch)
const readiness = new Readiness()

const app = buildApp({ config, pg, ch, readiness })

await app.listen({ port: config.port, host: '0.0.0.0' })
readiness.markReady()
