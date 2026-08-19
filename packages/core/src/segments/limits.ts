/**
 * The member walk's two bounds, in a module of their own.
 *
 * Split out of `compile.ts` so the web UI can import the real numbers rather
 * than inferring or duplicating them (#120). Its own module rather than a
 * subpath export of the compiler, because the compiler is a substantial
 * server-side module and the browser bundle has been bitten twice by pulling
 * node-only module-scope work in through a convenient import. Two integers
 * cost nothing to reach; the file they used to live in does.
 *
 * `compile.ts` re-exports both, so every existing importer is unchanged and
 * there is exactly one definition.
 */

/** One page. Bounded because this endpoint is reachable by any key holder. */
export const MEMBER_PAGE_SIZE = 100

/**
 * The furthest a caller may paginate. This endpoint is a preview of a
 * population, not an export of it — the export API is a later plan. Past this
 * many rows the response says so rather than truncating quietly.
 */
export const MEMBER_WINDOW_MAX = 1000
