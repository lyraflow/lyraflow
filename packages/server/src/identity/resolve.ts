// Moved to @lyraflow/core in Plan 3: the segment compiler is pure logic in
// core and cannot import from the server package. Re-exported from here so
// that Plan 2's call sites keep working unchanged; prefer importing from
// @lyraflow/core in new code.
export { RESOLVED_PERSON_ALIAS, resolvedPersonExpr } from '@lyraflow/core'
