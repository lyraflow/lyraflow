/**
 * The person id lives in the query string, not the path.
 *
 * `packages/server/src/static.ts`'s `looksLikeFile` 404s any non-API GET
 * whose last path segment contains a dot -- and `normalizePath` percent-
 * DECODES first, so escaping the dot away does not help. Person ids are
 * caller-supplied (`identify('cem@example.com')`), so a path parameter would
 * work on a client-side navigation and die on a hard refresh or a pasted
 * link: the worst shape of this bug, because it works everywhere it is
 * tested. `normalizePath` splits on `?` before the check runs, so a query
 * parameter keeps the property structurally rather than by discipline. It
 * also survives an id containing a slash, which a path parameter cannot.
 */
export function readPersonId(search: string): string | null {
  const id = new URLSearchParams(search).get('id')
  return id === null || id === '' ? null : id
}

/**
 * `personPath` lives beside `readPersonId` because they are one round trip
 * and must be tested as one -- putting it in `Router.tsx` (where
 * `funnelPath` and `segmentPath` live) would make every consumer of a
 * person link (`MemberList`, `AcceptedTable`, and this file's own unit
 * test) import the module that imports every screen.
 *
 * `encodeURIComponent`, never `encodeURI`: a person id may contain `&`, `#`
 * or `=`, and `encodeURI` leaves all three alone -- each of which would end
 * or split the parameter rather than travel inside it.
 */
export function personPath(id: string): string {
  return `/people?id=${encodeURIComponent(id)}`
}
