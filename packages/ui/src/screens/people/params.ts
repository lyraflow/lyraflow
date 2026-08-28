import { Trait as TraitSchema } from '@lyraflow/core/segments/ast.js'
import type { Trait } from '@lyraflow/core/segments/ast.js'

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

/**
 * The "find by trait" control's state, carried in the URL for the same
 * reason `id` is (this file's own doc comment above) -- a search that
 * matches nobody is a real answer, and an operator who wants to show someone
 * else "look, this trait matches no one" needs a link that still says so
 * after a reload.
 *
 * Read straight through the real `Trait` schema (`ast.ts`) rather than a
 * hand-rolled check, the same reasoning `warnings.ts`'s `completeness`
 * gives for parsing against `FilterNodeSchema` instead of a second notion of
 * "filled in": a trait clause admits five operator families with different
 * value shapes -- a bare string, a `[low, high]` pair for `between`, a
 * `{n, unit}` window for `in the last`, or no value at all for `is set` --
 * and re-deriving which combinations are legal here would drift from the
 * source of truth the moment a family changes. A missing, malformed or
 * hand-edited URL simply fails to parse and this returns `null`, the same
 * "nothing to show yet" state `readPersonId` reports for no id.
 *
 * **`id` wins when a URL carries both.** `People` checks `readPersonId`
 * first and renders the profile, discarding the trait parameters silently.
 * Neither `personPath` nor `traitSearchPath` can produce such a URL -- each
 * writes its own parameters and nothing else -- so it is reachable only by
 * hand-assembling one, and naming a specific person is the more specific
 * request of the two. Written down so it stays a decision rather than a
 * consequence of which `if` happens to come first.
 */
const TRAIT_KEY_PARAM = 'trait_key'
const TRAIT_OP_PARAM = 'trait_op'
const TRAIT_VALUE_PARAM = 'trait_value'

export function readTraitQuery(search: string): Trait | null {
  const params = new URLSearchParams(search)
  const key = params.get(TRAIT_KEY_PARAM)
  const operator = params.get(TRAIT_OP_PARAM)
  if (key === null || operator === null) return null
  const candidate: Record<string, unknown> = { kind: 'trait', key, operator }
  const rawValue = params.get(TRAIT_VALUE_PARAM)
  if (rawValue !== null) {
    // `value` is JSON-encoded because it is the one field on this node whose
    // shape is not a plain string -- see the doc comment above. A value that
    // fails to parse as JSON at all (a truncated or hand-typed link) is
    // treated the same as any other malformed candidate: no search, not a
    // crash.
    try {
      candidate.value = JSON.parse(rawValue)
    } catch {
      return null
    }
  }
  const parsed = TraitSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

/**
 * The URL one trait search should produce.
 *
 * `value` is omitted whenever the node itself carries no `value` key --
 * `is_set`/`is_not_set`/`is_true`/`is_false` clauses have none (`ast.ts`'s
 * `setClause`/`booleanClause`) -- so those round-trip with no stray
 * parameter for `readTraitQuery` to misparse.
 */
export function traitSearchPath(node: Trait): string {
  const params = new URLSearchParams()
  params.set(TRAIT_KEY_PARAM, node.key)
  params.set(TRAIT_OP_PARAM, node.operator)
  const value = (node as { value?: unknown }).value
  if (value !== undefined) params.set(TRAIT_VALUE_PARAM, JSON.stringify(value))
  return `/people?${params.toString()}`
}
