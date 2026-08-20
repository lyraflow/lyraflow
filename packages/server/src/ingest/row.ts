/**
 * Re-export only. The implementation moved to `@lyraflow/core` (#125), so
 * `packages/cli` can build an event row through the same function real ingest
 * uses without depending on `@lyraflow/server` — which meant Fastify and the
 * whole ingest and query surface, to compose a handful of fields.
 *
 * This file stays so the dozen server-side importers of `./ingest/row.js` are
 * unchanged. `GeoInfo` moved with it: the row's shape belongs with the row,
 * while `geo.ts` keeps the resolving, which needs a database and a request IP.
 */
export {
  type EventRow,
  type GeoInfo,
  type RowInput,
  chDateTime,
  parseChDateTime,
  toEventRow,
} from '@lyraflow/core'
