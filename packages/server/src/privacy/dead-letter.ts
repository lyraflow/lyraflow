/**
 * `events_dead_letter` holds REJECTED payloads verbatim, with no identity
 * columns to match on — only the raw JSON. Matching the quoted form of each
 * id (`"alice"`) rather than the bare substring keeps `bob` from matching
 * inside `bobby`; it is still a substring match over unparsed text, which is
 * the most that can be said about a payload that failed to parse. Erring
 * toward deleting (or exporting) a diagnostic row is the right direction
 * here. One known gap, not worth code against: buildDeadLetterRow
 * (ingest/routes.ts) truncates the stored payload at 8000 characters, so a
 * cut that lands mid-token can leave e.g. `…"user_id":"alice` with no
 * closing quote — the quoted-form match below then misses it. The
 * alternative (matching the bare substring) reintroduces the `bob`-inside-
 * `bobby` collision this quoting exists to prevent, which is the worse
 * failure mode of the two. A second known gap, same shape: an id containing
 * `"` or `\` is stored JSON-escaped in the payload (`\"`, `\\`), so the
 * literal quoted form built here never matches it either.
 *
 * The purge (purge.ts step 4) and the export (export.ts) both bind this to
 * `{ids:Array(String)}` against `scope.ids` — the SAME predicate, so what
 * deletion treats as this person's data, the export shows as this person's
 * data. Kept in exactly one place on purpose: see dead-letter.test.ts.
 */
export const DEAD_LETTER_MATCH = 'quoted-id-substring' as const

export const DEAD_LETTER_OWNED_BY_IDS = `arrayExists(x -> position(payload, concat('"', x, '"')) > 0, {ids:Array(String)})`
