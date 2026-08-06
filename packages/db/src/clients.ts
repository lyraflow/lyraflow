import { type ClickHouseClient, createClient } from '@clickhouse/client'
import { Pool, type PoolClient } from 'pg'

export interface ChConfig {
  url: string
  username: string
  password: string
  database: string
}

export function createPgPool(url: string): Pool {
  return new Pool({ connectionString: url, max: 10 })
}

export function createChClient(cfg: ChConfig): ClickHouseClient {
  return createClient({
    url: cfg.url,
    username: cfg.username,
    password: cfg.password,
    database: cfg.database,
  })
}

export type { ClickHouseClient, Pool, PoolClient }
