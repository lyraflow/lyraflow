export const SCHEMA_VERSION = 17

export { hashPassword, verifyPassword } from './auth/password.js'
export { ProjectExistsError, createProject, slugify } from './projects/create.js'
export * from './ingest/payloads.js'
export * from './ingest/properties.js'
export * from './ingest/timestamp.js'
export * from './enrich/user-agent.js'
export * from './enrich/bots.js'
export { SERVER_SIDE_LIBRARIES, isServerSideLibrary } from './enrich/libraries.js'
export {
  type EventRow,
  type GeoInfo,
  type RowInput,
  PAGE_EVENT_NAME,
  PAGE_NAME_PROPERTY,
  chDateTime,
  eventNameFor,
  parseChDateTime,
  propertyBagFor,
  toEventRow,
} from './ingest/row.js'
export * from './identity/ranges.js'
export * from './identity/resolve.js'
export * from './segments/ast.js'
export * from './segments/instants.js'
export * from './segments/validate.js'
export * from './segments/params.js'
export * from './segments/base.js'
export * from './segments/compile.js'
export * from './segments/hash.js'
export * from './segments/cursor.js'
export * from './funnels/ast.js'
export * from './funnels/validate.js'
export * from './funnels/levels.js'
export * from './funnels/compile.js'
export * from './privacy/suppression.js'
export { buildSnippet, normalizeHost } from './snippet/build.js'
